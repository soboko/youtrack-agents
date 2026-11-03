/**
 * The voice core's `VoiceTracker` over YA-8's `TrackerPort` (YA-15). A thin mapping: queries become `IssueFilter`s,
 * comments become `VoiceComment`s, completeness passes straight through, and failures keep the kinds the core already
 * speaks about (`converse.ts` `failureReply`: `permission` is "the tracker wouldn't let me read that", `not-found` on
 * an open is "that issue is gone" or "no issue with that id", and every other kind is "I couldn't reach the tracker").
 *
 * | VoiceTracker                          | TrackerPort                                                         |
 * | ------------------------------------- | ------------------------------------------------------------------- |
 * | `listIssues({assignee: 'me'})`        | `listIssues({assignee: 'me'})`, the credential's own login          |
 * | `listIssues({assignee: {login}})`     | `listIssues({assignee: login})`, another user's login               |
 * | `listIssues({state})`                 | `listIssues({state})`                                               |
 * | `listIssues({unresolved})`            | `listIssues({unresolved})`                                          |
 * | `listIssues({text})`                  | `listIssues({text, textMode: 'any'})`, the core's stopwords removed |
 * | `listIssues({limit})`                 | `listIssues({limit})`                                               |
 * | `{issues, complete}`                  | `{issues, complete}`, unchanged                                     |
 * | `getIssue(key)`                       | `getIssue(key)`, refused unless the result is still in the project  |
 * | `listComments(key, limit)`            | `listComments(key, limit)`, oldest first                            |
 * | `VoiceComment.{authorName,created,text}` | `TrackerComment.{authorName,created,text}`, `created` in epoch ms |
 * | `listAssignees(limit)`                | `listIssues({unresolved, limit: assigneeScanLimit})`, distinct       |
 * |                                       | `workflow.assignee` with `assigneeName`, first seen first            |
 *
 * `listAssignees` reads the people from the issues themselves, so it needs no user-directory permission: the household
 * token can read project H and nothing else. Every assignee is returned with the full name as the tracker has it, even
 * one that may not be spoken (empty, an email, or the login itself): the core drops those (`speakablePersonName`), treats
 * the people as incomplete, and so never says "nobody" about them or repeats their login. Anyone past the limit is left
 * out, and then `complete` is false.
 */
import {TrackerFailure} from '../../tracker.ts';
import type {IssueFilter, TrackerFailureKind, TrackerIssue, TrackerPort} from '../../tracker.ts';
import {searchWords} from '../core/fuzzy.ts';
import {speakablePersonName} from '../core/speakable.ts';
import type {VoiceComment, VoiceIssueQuery, VoiceLogger, VoiceTracker} from '../core/types.ts';

/** The reads a voice tracker makes. Nothing that writes is reachable through it. */
export type VoiceTrackerPort = Pick<TrackerPort, 'listIssues' | 'getIssue' | 'listComments'>;

type VoiceTrackerMethod = keyof VoiceTrackerPort | 'listAssignees';

/**
 * How many unresolved issues `listAssignees` reads to find the people. More issues than this, and the people are
 * reported incomplete: someone whose issues are all older may be missing.
 */
export const DEFAULT_ASSIGNEE_SCAN_LIMIT = 200;

export interface VoiceTrackerOptions {
  /**
   * The project the tracker is scoped to. A `getIssue` result whose key is not `<project>-<number>` (an old key that
   * now resolves to an issue moved elsewhere) is refused as `not-found`.
   */
  project?: string;
  /**
   * The turn's deadline. Once it fires, no call is started: each method rejects with an `unavailable` failure before
   * reaching the port. (Stage 1 has no writes; the same check will guard them.)
   */
  signal?: AbortSignal;
  /** Applied to every failure message before it leaves the binding, e.g. to strip the credential. */
  redact?: (text: string) => string;
  /** Receives one info line per failed call, with its kind and HTTP status. */
  log?: VoiceLogger;
  /** Included in log lines. */
  requestId?: string;
  /** Awaited before every call, after the signal check; a rejection refuses the call (the link check). */
  beforeCall?: () => Promise<void>;
  /** Unresolved issues read to find the assignees; `DEFAULT_ASSIGNEE_SCAN_LIMIT` by default. */
  assigneeScanLimit?: number;
}

const PORT_KINDS: ReadonlySet<string> = new Set<TrackerFailureKind>([
  'validation',
  'not-found',
  'permission',
  'conflict',
  'unsupported',
  'unavailable',
  'unknown',
]);

/** A failure leaving the binding: the port's kind (see `voiceFailure`), a redacted message and the HTTP status. */
export class VoiceTrackerFailure extends TrackerFailure {
  readonly status?: number;

  constructor(kind: TrackerFailureKind, message: string, status?: number) {
    super(kind, message);
    this.name = 'VoiceTrackerFailure';
    if (status !== undefined) this.status = status;
  }
}

/**
 * The words of a spoken search worth sending to the tracker, as spoken: each whitespace-separated word is kept only if
 * the core's own search words (`fuzzy.ts` `searchWords`, which drops its stopwords) find something in it. "find the
 * issue about the boiler" sends "boiler": an any-word query for "issue" or "about" would match unrelated summaries and
 * could push the one wanted past the limit before the core ranks anything.
 */
export function meaningfulText(text: string): string {
  return text
    .split(/\s+/u)
    .filter((word) => searchWords(word).length > 0)
    .join(' ');
}

/**
 * The tracker filter for a voice query, or `null` for a text search with no meaningful word, which must never be sent
 * as no text condition at all (that would list everything). Spoken text matches any word; the core ranks the matches.
 */
export function issueFilter(query: VoiceIssueQuery): IssueFilter | null {
  const filter: IssueFilter = {limit: query.limit};
  if (query.assignee === 'me') filter.assignee = 'me';
  else if (query.assignee !== undefined) filter.assignee = query.assignee.login;
  if (query.state !== undefined) filter.state = query.state;
  if (query.unresolved !== undefined) filter.unresolved = query.unresolved;
  if (query.text !== undefined) {
    const text = meaningfulText(query.text);
    if (text === '') return null;
    filter.text = text;
    filter.textMode = 'any';
  }
  return filter;
}

/**
 * The failure a voice turn sees. A `TrackerFailure` keeps its kind, with one exception for calls naming one issue: a
 * `validation` failure with no HTTP status is the binding's own refusal of a key that is malformed or outside the
 * project (a misheard "open, um, two" asks for `UM-2`), which to a listener is an issue that does not exist, so it
 * becomes `not-found`, and the core's filler fallback and "no issue with that id" still work. A server's 400 or 422
 * says nothing about whether the issue exists, so it becomes `unavailable` rather than "that issue is gone".
 * Anything that is not a `TrackerFailure` becomes `unavailable`: a read cannot have changed anything. The HTTP status,
 * when there is one, is kept for logs; the message is redacted.
 */
export function voiceFailure(
  error: unknown,
  namesIssue: boolean,
  redact: (text: string) => string,
): VoiceTrackerFailure {
  if (error instanceof TrackerFailure && PORT_KINDS.has(error.kind)) {
    // YouTrackError carries the HTTP status; a local refusal has none.
    const raw = (error as {status?: unknown}).status;
    const status = typeof raw === 'number' ? raw : undefined;
    let kind = error.kind;
    if (error.kind === 'validation' && status !== undefined) kind = 'unavailable';
    else if (error.kind === 'validation' && namesIssue) kind = 'not-found';
    return new VoiceTrackerFailure(kind, redact(error.message), status);
  }
  return new VoiceTrackerFailure('unavailable', 'Tracker call failed');
}

/** Comments oldest first, as the port promises; sorted again so a provider's order can never renumber them. */
function commentsOldestFirst(comments: readonly VoiceComment[]): VoiceComment[] {
  return comments
    .map((comment, index) => ({comment, index}))
    .sort((left, right) => left.comment.created - right.comment.created || left.index - right.index)
    .map(({comment}) => comment);
}

/** Whether `key` is `<project>-<digits>`, compared the way the adapter checks a requested key. */
function inProject(key: string, project: string): boolean {
  return key.startsWith(`${project}-`) && /^\d+$/.test(key.slice(project.length + 1));
}

/**
 * The distinct assignees of `issues`, first seen first, at most `limit`, and whether there were more. Each carries the
 * full name as the tracker has it, or '' for none. Nobody is left out for want of a name: the core decides what can be
 * said (`speakablePersonName`), so it also knows a login it must not repeat back. `unnamed` counts them, for logs.
 */
export function distinctAssignees(
  issues: readonly TrackerIssue[],
  limit: number,
): {people: {login: string; name: string}[]; overLimit: boolean; unnamed: number} {
  const seen = new Set<string>();
  const people: {login: string; name: string}[] = [];
  let unnamed = 0;
  for (const issue of issues) {
    const login = issue.workflow.assignee;
    if (login === null || login === '' || seen.has(login)) continue;
    seen.add(login);
    const name = (issue.assigneeName ?? '').trim();
    if (speakablePersonName(login, name) === null) unnamed++;
    people.push({login, name});
  }
  return {people: people.slice(0, Math.max(0, limit)), overLimit: people.length > limit, unnamed};
}

export function createVoiceTracker(port: VoiceTrackerPort, options: VoiceTrackerOptions = {}): VoiceTracker {
  const redact = options.redact ?? ((text: string) => text);
  const log: VoiceLogger = options.log ?? (() => {});
  const requestId = options.requestId;

  const run = async <T>(method: VoiceTrackerMethod, call: () => Promise<T>): Promise<T> => {
    if (options.signal?.aborted) {
      throw new VoiceTrackerFailure('unavailable', 'Turn deadline passed; tracker call not started');
    }
    try {
      await options.beforeCall?.();
      return await call();
    } catch (error) {
      const failure = voiceFailure(error, method !== 'listIssues', redact);
      log('info', 'voice.binding.callFailed', {requestId, method, kind: failure.kind, status: failure.status});
      throw failure;
    }
  };

  const checkedIssue = (issue: TrackerIssue): TrackerIssue => {
    if (options.project !== undefined && !inProject(issue.key, options.project)) {
      // Local refusal, no status: mapped to not-found like any key outside the project.
      throw new TrackerFailure('validation', 'Issue resolved outside the configured project');
    }
    return issue;
  };

  return {
    listIssues: (query) =>
      run('listIssues', async () => {
        const filter = issueFilter(query);
        if (filter === null) {
          log('info', 'voice.binding.searchEmpty', {requestId});
          return {issues: [], complete: true};
        }
        const list = await port.listIssues(filter);
        return {issues: list.issues, complete: list.complete};
      }),
    getIssue: (key) => run('getIssue', async () => checkedIssue(await port.getIssue(key))),
    listComments: (key, limit) =>
      run('listComments', async () => {
        const list = await port.listComments(key, limit);
        const comments = list.comments.map((comment): VoiceComment => ({
          // A name that is the login, an email or login-shaped is passed on as none (recheck R2): the core says
          // "someone without a name in the tracker".
          authorName: speakablePersonName(comment.authorLogin ?? null, comment.authorName) ?? '',
          created: comment.created,
          text: comment.text,
        }));
        return {comments: commentsOldestFirst(comments), complete: list.complete};
      }),
    listAssignees: (limit) =>
      run('listAssignees', async () => {
        const scan = options.assigneeScanLimit ?? DEFAULT_ASSIGNEE_SCAN_LIMIT;
        const list = await port.listIssues({unresolved: true, limit: scan});
        const found = distinctAssignees(list.issues, limit);
        const complete = list.complete && !found.overLimit;
        log('info', 'voice.binding.assignees', {
          requestId,
          issues: list.issues.length,
          issuesComplete: list.complete,
          people: found.people.length,
          unnamed: found.unnamed,
          complete,
        });
        return {people: found.people, complete};
      }),
  };
}
