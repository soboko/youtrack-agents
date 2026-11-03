/**
 * In-memory fakes for the voice core's ports: a `VoiceTracker` loaded from plain issue fixtures, a `UserStateStore`,
 * and a controllable clock. Used by the transcript tests and by the text adapter, so the household can try the
 * conversation with no tracker account.
 *
 * The tracker fake can simulate what a real one does to a conversation: capped lists (`listCap`), slow calls
 * (`latencyMs` advances the fake clock; `hold()` makes calls wait until released), a capped list of people (`peopleCap`),
 * failures (`failNext`), and issues
 * changing or disappearing between turns (`update`, `remove`).
 */
import {TrackerFailure} from '../../tracker.ts';
import type {TrackerFailureKind, TrackerIssue} from '../../tracker.ts';
import {summaryScore} from './fuzzy.ts';
import type {StoredState, UserStateStore, VoiceComment, VoiceIssueQuery, VoiceTracker} from './types.ts';

export interface CommentFixture {
  author: string;
  /** ISO 8601 or epoch milliseconds. */
  created: string | number;
  /** Markdown. */
  text: string;
}

export interface IssueFixture {
  key: string;
  summary: string;
  /** Markdown, or null for none. */
  description?: string | null;
  state?: string | null;
  assignee?: string | null;
  subsystem?: string | null;
  /** Defaults to whether the state is one of `RESOLVED_STATES`. */
  resolved?: boolean;
  /** ISO 8601 or epoch milliseconds. */
  updated: string | number;
  comments?: CommentFixture[];
}

/** A fixture file: the login the fake runs as, its issues, and optionally the full name behind each login. */
export interface TrackerFixture {
  me: string;
  issues: IssueFixture[];
  /** Login -> full name. An assignee without one has no `assigneeName`, and is named by its login. */
  people?: Record<string, string>;
}

export const RESOLVED_STATES: readonly string[] = ['Fixed', 'Done', 'Verified', 'Closed', "Won't fix", 'Duplicate'];

/** Search matches need at least this summary score (see fuzzy.ts). */
const FAKE_SEARCH_THRESHOLD = 0.5;

function toTime(value: string | number, what: string): number {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Fixture ${what}: not a date: ${String(value)}`);
  return time;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Fixture ${what}: expected a string`);
  return value;
}

/** Validates parsed JSON as a tracker fixture, with a message naming the first problem. */
export function parseTrackerFixture(json: unknown): TrackerFixture {
  if (!isRecord(json)) throw new Error('Fixture: expected an object with "me" and "issues"');
  if (typeof json.me !== 'string') throw new Error('Fixture: "me" must be the login the fake runs as');
  if (!Array.isArray(json.issues)) throw new Error('Fixture: "issues" must be an array');
  const issues = json.issues.map((raw: unknown, index): IssueFixture => {
    const where = `issues[${index}]`;
    if (!isRecord(raw)) throw new Error(`Fixture ${where}: expected an object`);
    if (typeof raw.key !== 'string' || typeof raw.summary !== 'string') {
      throw new Error(`Fixture ${where}: "key" and "summary" are required strings`);
    }
    if (typeof raw.updated !== 'string' && typeof raw.updated !== 'number') {
      throw new Error(`Fixture ${where}: "updated" is required`);
    }
    toTime(raw.updated, `${where}.updated`);
    const comments = raw.comments === undefined ? [] : raw.comments;
    if (!Array.isArray(comments)) throw new Error(`Fixture ${where}: "comments" must be an array`);
    return {
      key: raw.key,
      summary: raw.summary,
      description: optionalString(raw.description, `${where}.description`),
      state: optionalString(raw.state, `${where}.state`),
      assignee: optionalString(raw.assignee, `${where}.assignee`),
      subsystem: optionalString(raw.subsystem, `${where}.subsystem`),
      resolved: typeof raw.resolved === 'boolean' ? raw.resolved : undefined,
      updated: raw.updated,
      comments: comments.map((comment: unknown, commentIndex): CommentFixture => {
        const commentWhere = `${where}.comments[${commentIndex}]`;
        if (!isRecord(comment) || typeof comment.author !== 'string' || typeof comment.text !== 'string') {
          throw new Error(`Fixture ${commentWhere}: "author" and "text" are required strings`);
        }
        if (typeof comment.created !== 'string' && typeof comment.created !== 'number') {
          throw new Error(`Fixture ${commentWhere}: "created" is required`);
        }
        toTime(comment.created, `${commentWhere}.created`);
        return {author: comment.author, created: comment.created, text: comment.text};
      }),
    };
  });
  if (json.people === undefined) return {me: json.me, issues};
  if (!isRecord(json.people) || Object.values(json.people).some((name) => typeof name !== 'string')) {
    throw new Error('Fixture: "people" must map each login to a full name');
  }
  return {me: json.me, issues, people: json.people as Record<string, string>};
}

/** A clock tests advance by hand. */
export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function createFakeClock(start: number): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

export type FakeTrackerMethod = 'listIssues' | 'getIssue' | 'listComments' | 'listAssignees';

export interface FakeTrackerOptions {
  /** Advanced by `latencyMs` on every call, so timings show up in logs without real waiting. */
  clock?: FakeClock;
  latencyMs?: number;
  /** The most issues any list returns; beyond it the list is reported incomplete. */
  listCap?: number;
  /** The most comments any comment list returns; beyond it the list is reported incomplete. */
  commentCap?: number;
  /** The most people `listAssignees` returns; beyond it the list is reported incomplete. */
  peopleCap?: number;
}

export interface FakeTrackerCall {
  method: FakeTrackerMethod;
  args: readonly unknown[];
}

export class FakeVoiceTracker implements VoiceTracker {
  readonly me: string;
  readonly calls: FakeTrackerCall[] = [];
  latencyMs: number;
  listCap: number | null;
  commentCap: number | null;
  peopleCap: number | null;
  private readonly people: ReadonlyMap<string, string>;
  private readonly clock: FakeClock | null;
  private readonly issues = new Map<string, IssueFixture>();
  private readonly failures = new Map<FakeTrackerMethod, TrackerFailureKind[]>();
  private gate: Promise<void> | null = null;
  private heldWaiters: Array<() => void> = [];
  private heldCount = 0;

  constructor(fixture: TrackerFixture, options: FakeTrackerOptions = {}) {
    this.me = fixture.me;
    this.clock = options.clock ?? null;
    this.latencyMs = options.latencyMs ?? 0;
    this.listCap = options.listCap ?? null;
    this.commentCap = options.commentCap ?? null;
    this.peopleCap = options.peopleCap ?? null;
    this.people = new Map(Object.entries(fixture.people ?? {}));
    for (const issue of fixture.issues) this.issues.set(issue.key, structuredClone(issue));
  }

  /** Makes the next `times` calls to `method` throw a `TrackerFailure` of `kind`. */
  failNext(method: FakeTrackerMethod, kind: TrackerFailureKind, times = 1): void {
    const queue = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i++) queue.push(kind);
    this.failures.set(method, queue);
  }

  /**
   * Resolves once a call is parked behind `hold()`. Tests await this, rather than a count of event-loop turns, to
   * know the turn has reached the tracker.
   */
  whenHeld(): Promise<void> {
    if (this.heldCount > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.heldWaiters.push(resolve);
    });
  }

  /** Holds every call until the returned function is called. */
  hold(): () => void {
    let release: () => void = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = () => {
        this.gate = null;
        resolve();
      };
    });
    return release;
  }

  add(issue: IssueFixture): void {
    this.issues.set(issue.key, structuredClone(issue));
  }

  update(key: string, changes: Partial<IssueFixture>): void {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`Fake tracker: no issue ${key} to update`);
    this.issues.set(key, {...issue, ...changes, key});
  }

  remove(key: string): void {
    this.issues.delete(key);
  }

  async listIssues(query: VoiceIssueQuery): Promise<{issues: TrackerIssue[]; complete: boolean}> {
    await this.enter('listIssues', [query]);
    let matches = [...this.issues.values()];
    const assignee = query.assignee;
    if (assignee === 'me') matches = matches.filter((issue) => issue.assignee === this.me);
    if (typeof assignee === 'object') matches = matches.filter((issue) => issue.assignee === assignee.login);
    if (query.state !== undefined) {
      const wanted = query.state.toLowerCase();
      matches = matches.filter((issue) => (issue.state ?? '').toLowerCase() === wanted);
    }
    if (query.unresolved) matches = matches.filter((issue) => !isResolved(issue));
    if (query.text !== undefined) {
      const text = query.text;
      matches = matches.filter((issue) => summaryScore(text, issue.summary) >= FAKE_SEARCH_THRESHOLD);
    }
    matches.sort((a, b) => toTime(b.updated, b.key) - toTime(a.updated, a.key));
    const limit = Math.min(query.limit, this.listCap ?? Number.POSITIVE_INFINITY);
    return {
      issues: matches.slice(0, limit).map((issue) => this.toTrackerIssue(issue)),
      complete: matches.length <= limit,
    };
  }

  /** Distinct assignees of unresolved issues, most recently updated first, named from the fixture's `people`. */
  async listAssignees(limit: number): Promise<{people: {login: string; name: string}[]; complete: boolean}> {
    await this.enter('listAssignees', [limit]);
    const logins: string[] = [];
    const open = [...this.issues.values()]
      .filter((issue) => !isResolved(issue))
      .sort((a, b) => toTime(b.updated, b.key) - toTime(a.updated, a.key));
    for (const issue of open) {
      if (issue.assignee && !logins.includes(issue.assignee)) logins.push(issue.assignee);
    }
    const cap = Math.min(limit, this.peopleCap ?? Number.POSITIVE_INFINITY);
    return {
      people: logins.slice(0, cap).map((login) => ({login, name: this.people.get(login) ?? login})),
      complete: logins.length <= cap,
    };
  }

  async getIssue(key: string): Promise<TrackerIssue> {
    await this.enter('getIssue', [key]);
    const issue = this.issues.get(key);
    if (!issue) throw new TrackerFailure('not-found', `No issue ${key}`);
    return this.toTrackerIssue(issue);
  }

  async listComments(key: string, limit: number): Promise<{comments: VoiceComment[]; complete: boolean}> {
    await this.enter('listComments', [key, limit]);
    const issue = this.issues.get(key);
    if (!issue) throw new TrackerFailure('not-found', `No issue ${key}`);
    const comments = (issue.comments ?? []).map((comment) => ({
      authorName: comment.author,
      created: toTime(comment.created, `${key} comment`),
      text: comment.text,
    }));
    const cap = Math.min(limit, this.commentCap ?? Number.POSITIVE_INFINITY);
    return {comments: comments.slice(0, cap), complete: comments.length <= cap};
  }

  private toTrackerIssue(issue: IssueFixture): TrackerIssue {
    return toTrackerIssue(issue, this.people);
  }

  private async enter(method: FakeTrackerMethod, args: readonly unknown[]): Promise<void> {
    this.calls.push({method, args});
    const gate = this.gate;
    if (gate !== null) {
      this.heldCount++;
      for (const notify of this.heldWaiters.splice(0)) notify();
      await gate;
      this.heldCount--;
    }
    if (this.clock !== null && this.latencyMs > 0) this.clock.advance(this.latencyMs);
    const kind = this.failures.get(method)?.shift();
    if (kind !== undefined) throw new TrackerFailure(kind, `Simulated ${kind} failure in ${method}`);
  }
}

function isResolved(issue: IssueFixture): boolean {
  return issue.resolved ?? RESOLVED_STATES.includes(issue.state ?? '');
}

function toTrackerIssue(issue: IssueFixture, people: ReadonlyMap<string, string>): TrackerIssue {
  const name = issue.assignee ? people.get(issue.assignee) : undefined;
  return {
    id: `fake-${issue.key}`,
    key: issue.key,
    summary: issue.summary,
    description: issue.description ?? null,
    url: `https://tracker.example/issue/${issue.key}`,
    updated: toTime(issue.updated, issue.key),
    workflow: {
      state: issue.state ?? null,
      role: null,
      assignee: issue.assignee ?? null,
      recommendedModel: null,
      subsystem: issue.subsystem ?? null,
    },
    ...(name === undefined ? {} : {assigneeName: name}),
  };
}

/**
 * A `UserStateStore` in a Map, versioned with a counter, with switchable failures. `beforeSave` runs before each
 * save's version check, so a test can slip another turn's save in between.
 */
export class MemoryStateStore implements UserStateStore {
  readonly values = new Map<string, StoredState>();
  failLoads = false;
  failSaves = false;
  saves = 0;
  conflicts = 0;
  beforeSave: (() => Promise<void>) | null = null;
  private counter = 0;

  /** Stores a value directly, as if a turn had saved it. */
  put(userId: string, serialized: string): void {
    this.counter++;
    this.values.set(userId, {serialized, version: String(this.counter)});
  }

  async load(userId: string): Promise<StoredState | null> {
    if (this.failLoads) throw new Error('Simulated state load failure');
    const stored = this.values.get(userId);
    return stored === undefined ? null : {...stored};
  }

  async save(userId: string, serialized: string, expectedVersion: string | null): Promise<boolean> {
    if (this.failSaves) throw new Error('Simulated state save failure');
    if (this.beforeSave !== null) await this.beforeSave();
    const current = this.values.get(userId)?.version ?? null;
    if (current !== expectedVersion) {
      this.conflicts++;
      return false;
    }
    this.saves++;
    this.put(userId, serialized);
    return true;
  }
}
