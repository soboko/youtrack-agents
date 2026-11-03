import {inspect} from 'node:util';
import type {AgentIdentity} from '../identity.ts';
import {loadConfig} from '../config.ts';
import type {Config} from '../config.ts';
import {YouTrackAdmin} from './admin.ts';
import {YouTrackTransport, segment} from './transport.ts';
import type {CollectionPage, WriteCounts} from './transport.ts';
import type {ClientOptions, ProjectField, Issue, Comment, WorkItem, CreateIssueInput} from './types.ts';
import {encodeField} from './fields.ts';
import {parseTokens} from './tokens.ts';
import {validateActual, assertAccountingSupported} from '../accounting/actuals.ts';
import {TrackerFailure} from '../tracker.ts';

/** A human-readable issue id (`PRJ-12`) or an internal entity id (`2-7`). */
const ISSUE_ID = /^(?:[A-Za-z][A-Za-z0-9_]*-\d+|\d+-\d+)$/;

/** Rejects anything that is not an issue id before it reaches a request path or command. */
function checkIssueId(idReadable: string): string {
  if (typeof idReadable !== 'string' || !ISSUE_ID.test(idReadable)) {
    throw new TrackerFailure('validation', 'Invalid issue id; expected PRJ-123');
  }
  return idReadable;
}

/** A comment with its author's display name, for listings that are spoken or shown to people. */
export interface NamedComment extends Comment {
  authorName: string | null;
}

export class YouTrackClient {
  readonly baseUrl: string;
  readonly project: string;
  readonly board: string; // YOUTRACK_BOARD: the main kanban board's name ('' = first visible board)
  readonly sprintBoard: string; // YOUTRACK_SPRINT_BOARD: the board sprint commands default to (falls back to board)
  readonly identity: AgentIdentity;
  // Non-enumerable (set in the constructor): the config and transport hold the credential and must never serialise.
  declare readonly config: Config;
  private readonly admin: YouTrackAdmin;
  declare private readonly transport: YouTrackTransport;
  readonly log: (msg: string) => void;
  private projectId: string | null = null;
  private fieldCache: ProjectField[] | null = null;

  readonly configSource: string;

  constructor(opts: ClientOptions) {
    const cfg = opts.config ?? loadConfig(opts);
    Object.defineProperty(this, 'config', {value: cfg, enumerable: false});
    this.admin = new YouTrackAdmin(this);
    Object.defineProperty(this, 'transport', {value: new YouTrackTransport(cfg, opts), enumerable: false});
    this.baseUrl = cfg.baseUrl;
    this.project = cfg.project;
    this.board = cfg.board;
    this.sprintBoard = cfg.sprintBoard;
    this.configSource = cfg.source;
    this.identity = opts.identity;
    this.log = opts.log ?? (() => {});
    this.log(
      `youtrack ${this.baseUrl} project ${this.project} (config: ${this.configSource}; agent ${this.identity.model} / ${this.identity.session})`,
    );
  }

  /** Serialises without the credential. */
  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      project: this.project,
      board: this.board,
      sprintBoard: this.sprintBoard,
      configSource: this.configSource,
      identity: this.identity,
      token: '[redacted]',
    };
  }

  [inspect.custom](): string {
    return `YouTrackClient { baseUrl: '${this.baseUrl}', project: '${this.project}', token: [redacted] }`;
  }

  issueUrl(idReadable: string): string {
    return `${this.baseUrl}/issue/${idReadable}`;
  }

  // ---- raw HTTP ----
  /** Mutating requests sent through this client so far; compare two snapshots to classify a failure. */
  get writes(): WriteCounts {
    return this.transport.writes;
  }

  async request<T>(method: string, apiPath: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    return this.transport.request<T>(method, apiPath, body, query);
  }

  /** Retrieves all pages for APIs whose result must be exhaustive. */
  async collect<T>(apiPath: string, query: Record<string, string> = {}, limit?: number): Promise<T[]> {
    return this.transport.collect<T>(apiPath, query, limit);
  }

  /** Retrieves at most `limit` items and says whether the provider holds more. */
  async collectPage<T>(apiPath: string, query: Record<string, string>, limit: number): Promise<CollectionPage<T>> {
    return this.transport.collectPage<T>(apiPath, query, limit);
  }

  // ---- identity ----
  async whoami(): Promise<{
    id: string;
    login: string;
    fullName: string;
    email: string | null;
  }> {
    return this.request('GET', 'users/me', undefined, {
      fields: 'id,login,fullName,email',
    });
  }

  // ---- project + fields ----
  async getProjectId(): Promise<string> {
    if (this.projectId) return this.projectId;
    const list = await this.collect<{id: string; shortName: string}>('admin/projects', {
      fields: 'id,shortName',
      $top: '100',
    });
    const p = list.find((x) => x.shortName === this.project);
    if (!p)
      throw new TrackerFailure(
        'not-found',
        `project ${this.project} not found; have ${list.map((x) => x.shortName).join(', ')}`,
      );
    this.projectId = p.id;
    return p.id;
  }

  invalidateFields(): void {
    this.fieldCache = null;
  }

  async fields(force = false): Promise<ProjectField[]> {
    if (this.fieldCache && !force) return this.fieldCache;
    const pid = await this.getProjectId();
    type Raw = {
      id: string;
      canBeEmpty: boolean;
      field: {name: string; fieldType: {id: string}};
      bundle?: {id?: string; values?: {name: string; ordinal?: number}[]};
    };
    const raw = await this.collect<Raw>(`admin/projects/${segment(pid)}/customFields`, {
      $top: '100',
      fields: 'id,canBeEmpty,field(name,fieldType(id)),bundle(id,values(name,ordinal))',
    });
    const fields: ProjectField[] = [];
    for (const field of raw) {
      const bundleType = field.field.fieldType.id.split('[')[0];
      const pagedBundle = ['enum', 'state', 'ownedField', 'version', 'build'].includes(bundleType);
      const values =
        pagedBundle && field.bundle?.id
          ? await this.collect<{name: string; ordinal?: number}>(
              `admin/customFieldSettings/bundles/${segment(bundleType)}/${segment(field.bundle.id)}/values`,
              {fields: 'name,ordinal'},
            )
          : (field.bundle?.values ?? []);
      fields.push({
        id: field.id,
        name: field.field.name,
        type: field.field.fieldType.id,
        canBeEmpty: field.canBeEmpty,
        values: values
          .slice()
          .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))
          .map((value) => value.name),
      });
    }
    this.fieldCache = fields;
    return this.fieldCache;
  }

  async field(name: string): Promise<ProjectField> {
    const all = await this.fields();
    const f = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!f)
      throw new TrackerFailure(
        'validation',
        `no field "${name}" on ${this.project}; have ${all.map((x) => x.name).join(', ')}`,
      );
    return f;
  }

  /** Looks up project metadata before encoding a field value. */
  async fieldPayload(name: string, value: string | string[] | number | null): Promise<Record<string, unknown>> {
    return encodeField(await this.field(name), value);
  }

  // ---- issues ----
  private static readonly ISSUE_FIELDS =
    'id,idReadable,summary,description,resolved,created,updated,reporter(login),customFields(name,value(name,login,fullName,presentation,minutes,id))';

  /** After a write, the reply is the receipt: a missing or null `customFields` cannot confirm what was applied. */
  private toIssue(raw: Record<string, unknown>, write = false): Issue {
    if (!raw || typeof raw.id !== 'string' || typeof raw.idReadable !== 'string') {
      throw new TrackerFailure('unknown', 'Invalid issue response; reconcile any attempted write before retrying');
    }
    const customFields = write ? raw.customFields : (raw.customFields ?? []);
    if (
      !Array.isArray(customFields) ||
      customFields.some((field) => field === null || typeof field !== 'object' || typeof field.name !== 'string')
    ) {
      throw new TrackerFailure(
        'unknown',
        'Invalid issue fields in response; reconcile any attempted write before retrying',
      );
    }
    const fields: Record<string, unknown> = {};
    const users: Record<string, {login: string; fullName: string | null}> = {};
    for (const cf of customFields as {name: string; value: unknown}[]) {
      const v = cf.value;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const {login, fullName} = v as Record<string, unknown>;
        if (typeof login === 'string') {
          users[cf.name] = {login, fullName: typeof fullName === 'string' && fullName.trim() !== '' ? fullName : null};
        }
      }
      const plain = (x: unknown): unknown => {
        if (x === null || x === undefined) return null;
        if (typeof x !== 'object') return x;
        const o = x as Record<string, unknown>;
        return o.name ?? o.login ?? o.presentation ?? o.id ?? null;
      };
      fields[cf.name] = Array.isArray(v) ? v.map(plain) : plain(v);
    }
    return {
      id: String(raw.id),
      idReadable: String(raw.idReadable),
      summary: String(raw.summary ?? ''),
      description: (raw.description as string | null) ?? null,
      resolved: (raw.resolved as number | null) ?? null,
      created: Number(raw.created),
      updated: Number(raw.updated),
      reporter: (raw.reporter as {login?: string} | null)?.login ?? null,
      fields,
      ...(Object.keys(users).length > 0 ? {users} : {}),
      url: this.issueUrl(String(raw.idReadable)),
    };
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const pid = await this.getProjectId();
    const fields: Record<string, string | string[] | number | null> = {
      'AI Model': this.identity.model,
      'AI Session ID': this.identity.session,
      ...(input.fields ?? {}),
    };
    const customFields = [];
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) customFields.push(await this.fieldPayload(k, v));
    const body = {
      project: {id: pid},
      summary: input.summary,
      description: input.description ?? '',
      customFields,
    };
    this.log(`create issue in ${this.project}`);
    const raw = await this.request<Record<string, unknown>>('POST', 'issues', body, {
      fields: YouTrackClient.ISSUE_FIELDS,
    });
    const issue = this.toIssue(raw, true);
    this.log(`created ${issue.idReadable} ${issue.url}`);
    return issue;
  }

  async getIssue(idReadable: string): Promise<Issue> {
    checkIssueId(idReadable);
    const raw = await this.request<Record<string, unknown>>('GET', `issues/${segment(idReadable)}`, undefined, {
      fields: YouTrackClient.ISSUE_FIELDS,
    });
    return this.toIssue(raw);
  }

  // YouTrack query language, e.g. "Stage: Develop", "#Unresolved sort by: updated desc". Scoped to the project.
  async listIssues(query = '', top = 50): Promise<Issue[]> {
    return (await this.searchIssues(query, top)).issues;
  }

  /** Like `listIssues`, and `complete` is false when more than `top` issues match. */
  async searchIssues(query = '', top = 50): Promise<{issues: Issue[]; complete: boolean}> {
    const q = `project: ${this.project}${query ? ' ' + query : ''}`;
    const page = await this.collectPage<Record<string, unknown>>(
      'issues',
      {
        query: q,
        fields: YouTrackClient.ISSUE_FIELDS,
      },
      top,
    );
    return {issues: page.values.map((r) => this.toIssue(r)), complete: !page.truncated};
  }

  async updateIssue(
    idReadable: string,
    patch: {
      summary?: string;
      description?: string;
      fields?: Record<string, string | string[] | number | null>;
    },
  ): Promise<Issue> {
    checkIssueId(idReadable);
    const body: Record<string, unknown> = {};
    if (patch.summary !== undefined) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.fields)
      body.customFields = await Promise.all(Object.entries(patch.fields).map(([k, v]) => this.fieldPayload(k, v)));
    this.log(`update ${idReadable}`);
    const raw = await this.request<Record<string, unknown>>('POST', `issues/${segment(idReadable)}`, body, {
      fields: YouTrackClient.ISSUE_FIELDS,
    });
    return this.toIssue(raw, true);
  }

  setFields(idReadable: string, fields: Record<string, string | string[] | number | null>): Promise<Issue> {
    return this.updateIssue(idReadable, {fields});
  }

  // The kanban board's columns are the State field and its swimlanes are Subsystem. Moving a card is setting State.
  // `boardColumns()` returns the columns as configured on the board. The default board name comes from YOUTRACK_BOARD;
  // with none set, the first board the token can see is used.
  setState(idReadable: string, state: string): Promise<Issue> {
    return this.setFields(idReadable, {State: state});
  }
  setSubsystem(idReadable: string, subsystem: string): Promise<Issue> {
    return this.setFields(idReadable, {Subsystem: subsystem});
  }

  async boardColumns(
    boardName: string = this.board,
  ): Promise<{field: string; columns: {name: string; values: string[]}[]}> {
    type Raw = {
      name: string;
      columnSettings: {
        field: {name: string};
        columns: {
          ordinal: number;
          presentation: string;
          fieldValues: {name: string}[];
        }[];
      };
    };
    const boards = await this.collect<Raw>('agiles', {
      fields: 'name,columnSettings(field(name),columns(ordinal,presentation,fieldValues(name)))',
    });
    const b = (boardName ? boards.find((x) => x.name === boardName) : undefined) ?? boards[0];
    if (!b) throw new TrackerFailure('not-found', 'no agile board visible to this token');
    const cols = b.columnSettings.columns.slice().sort((a, c) => a.ordinal - c.ordinal);
    return {
      field: b.columnSettings.field.name,
      columns: cols.map((c) => ({
        name: c.presentation,
        values: c.fieldValues.map((v) => v.name),
      })),
    };
  }
  assign(idReadable: string, login: string | null): Promise<Issue> {
    return this.setFields(idReadable, {Assignee: login});
  }

  // ---- custom fields ----
  // A single-value enum field, created globally (field prototype + enum bundle) and attached to the project. Idempotent:
  // an existing bundle or field of the same name is reused, and values missing from the bundle are added.
  async addEnumField(
    name: string,
    values: string[],
    opts: {description?: string; canBeEmpty?: boolean; emptyText?: string} = {},
  ): Promise<{field: string; bundle: string; values: string[]}> {
    return this.admin.addEnumField(name, values, opts);
  }

  // ---- sprints ----
  // Sprints live on a BOARD, not on the project: an issue's sprint is the board's own per-issue field, set with the
  // command language ("Board <board name> <sprint name>"). Sprints are named "Sprint 1", "Sprint 2", ... by convention.
  // Issues in Submitted stay off every sprint: that is the backlog.
  // every board (agile) that includes this project, for commands that act on all of them (yt take)
  async boards(): Promise<{id: string; name: string}[]> {
    const all = await this.collect<{id: string; name: string; projects: {shortName: string}[]}>('agiles', {
      fields: 'id,name,projects(shortName)',
      $top: '100',
    });
    return all
      .filter((a) => a.projects?.some((p) => p.shortName === this.project))
      .map((a) => ({id: a.id, name: a.name}));
  }
  async agile(boardName: string): Promise<{id: string; name: string}> {
    const boards = await this.collect<{id: string; name: string}>('agiles', {fields: 'id,name'});
    const b = boards.find((x) => x.name === boardName);
    if (!b)
      throw new TrackerFailure(
        'not-found',
        `no agile board named "${boardName}" (have: ${boards.map((x) => x.name).join(', ')})`,
      );
    return b;
  }
  async sprints(boardName: string): Promise<{
    board: string;
    enabled: boolean;
    current: string | null;
    sprints: {
      id: string;
      name: string;
      archived: boolean;
      start: number | null;
      finish: number | null;
      issues: number;
    }[];
  }> {
    const b = await this.agile(boardName);
    const board = await this.request<{
      name: string;
      sprintsSettings: {disableSprints: boolean};
      currentSprint: {name: string} | null;
    }>('GET', `agiles/${segment(b.id)}`, undefined, {
      fields: 'name,sprintsSettings(disableSprints),currentSprint(name)',
    });
    const sprints = board.sprintsSettings.disableSprints
      ? []
      : await this.collect<{
          id: string;
          name: string;
          archived: boolean;
          start: number | null;
          finish: number | null;
        }>(`agiles/${segment(b.id)}/sprints`, {fields: 'id,name,archived,start,finish'});
    const complete = [];
    for (const sprint of sprints) {
      const issues = await this.collect<{id: string}>(`agiles/${segment(b.id)}/sprints/${segment(sprint.id)}/issues`, {
        fields: 'id',
      });
      complete.push({...sprint, issues: issues.length});
    }
    return {
      board: board.name,
      enabled: !board.sprintsSettings.disableSprints,
      current: board.currentSprint?.name ?? null,
      sprints: complete,
    };
  }

  async setSprintsEnabled(boardName: string, enabled: boolean): Promise<void> {
    return this.admin.setSprintsEnabled(boardName, enabled);
  }

  async createSprint(boardName: string, name: string): Promise<{id: string; name: string}> {
    return this.admin.createSprint(boardName, name);
  }

  async renameSprint(boardName: string, from: string, to: string): Promise<{id: string; name: string}> {
    return this.admin.renameSprint(boardName, from, to);
  }

  // membership is a command: the board's per-issue field takes the sprint name
  addToSprint(ids: string[], boardName: string, sprintName: string): Promise<void> {
    return this.command(ids, `Board ${boardName} ${sprintName}`);
  }
  async teamGroupName(): Promise<string> {
    if (this.config.teamGroup) return this.config.teamGroup;
    const pid = await this.getProjectId();
    const p = await this.request<{name: string; team?: {name: string}}>(
      'GET',
      `admin/projects/${segment(pid)}`,
      undefined,
      {
        fields: 'name,team(name)',
      },
    );
    return p.team?.name ?? `${p.name} Team`;
  }
  // The board's backlog is a saved search: what it matches and is not on the current sprint shows in the backlog panel.
  // The search is created by the API user and would be PRIVATE to it -- the owner then sees "This board doesn't have a
  // backlog" -- so it is shared with the project's team group (YOUTRACK_TEAM_GROUP, default "<Project name> Team", the
  // group YouTrack creates with the project) for reading and updating, and the attach is read back and checked.
  async setBacklog(boardName: string, savedQueryName: string, query: string): Promise<void> {
    return this.admin.setBacklog(boardName, savedQueryName, query);
  }

  // ---- comments ----
  annotation(): string {
    return `\n\n---\n_agent: ${this.identity.model} · session: ${this.identity.session}_`;
  }

  async addComment(idReadable: string, text: string, annotate = true): Promise<Comment> {
    checkIssueId(idReadable);
    const full = annotate ? text.trimEnd() + this.annotation() : text;
    this.log(`comment on ${idReadable} (${full.length} chars)`);
    const raw = await this.request<{
      id: string;
      author?: {login?: string};
      text: string;
      created: number;
    }>(
      'POST',
      `issues/${segment(idReadable)}/comments`,
      {text: full, usesMarkdown: true},
      {fields: 'id,author(login),text,created'},
    );
    if (!raw || typeof raw.id !== 'string') {
      throw new TrackerFailure('unknown', 'Missing write receipt; reconcile before retrying');
    }
    return {
      id: raw.id,
      author: raw.author?.login ?? null,
      text: raw.text,
      created: raw.created,
    };
  }

  async comments(idReadable: string): Promise<Comment[]> {
    checkIssueId(idReadable);
    const raw = await this.collect<{id: string; author?: {login?: string}; text: string; created: number}>(
      `issues/${segment(idReadable)}/comments`,
      {
        fields: 'id,author(login),text,created',
        $top: '200',
      },
    );
    return raw.map((r) => ({
      id: r.id,
      author: r.author?.login ?? null,
      text: r.text,
      created: r.created,
    }));
  }

  /** The first `limit` comments in the provider's (chronological) order; `complete` is false when more exist. */
  async commentPage(idReadable: string, limit: number): Promise<{comments: NamedComment[]; complete: boolean}> {
    checkIssueId(idReadable);
    const page = await this.collectPage<{
      id: string;
      author?: {login?: string; fullName?: string} | null;
      text?: string | null;
      created?: unknown;
    }>(`issues/${segment(idReadable)}/comments`, {fields: 'id,author(login,fullName),text,created'}, limit);
    // Listings are spoken with relative times, so a comment without a real timestamp is a malformed reply (YA-25 F4).
    const comments = page.values.map((r): NamedComment => {
      if (r === null || typeof r !== 'object' || typeof r.created !== 'number' || !Number.isFinite(r.created)) {
        throw new TrackerFailure('unavailable', 'Malformed comment in YouTrack response: missing or invalid created');
      }
      return {
        id: r.id,
        author: r.author?.login ?? null,
        authorName: r.author?.fullName || r.author?.login || null,
        text: r.text ?? '',
        created: r.created,
      };
    });
    return {
      comments,
      complete: !page.truncated,
    };
  }

  // ---- time and tokens ----
  // `Spent time` is computed by YouTrack from work items and cannot be set directly; `Estimation` can. Both are
  // periods in YouTrack's presentation form ("2d 4h", "45m"; a day is 8 h and a week 5 d by project settings).
  // Work item types are whatever the project's time-tracking settings define (e.g. Development, Testing, Documentation).
  async workItemTypes(): Promise<{id: string; name: string}[]> {
    const pid = await this.getProjectId();
    const r = await this.request<{workItemTypes: {id: string; name: string}[]}>(
      'GET',
      `admin/projects/${segment(pid)}/timeTrackingSettings`,
      undefined,
      {fields: 'workItemTypes(id,name)'},
    );
    return r.workItemTypes ?? [];
  }

  async logWork(
    idReadable: string,
    duration: string,
    opts: {text?: string; type?: string; annotate?: boolean} = {},
  ): Promise<WorkItem> {
    checkIssueId(idReadable);
    validateActual({time: duration, text: opts.text, type: opts.type});
    let type: {id: string} | undefined;
    if (opts.type) {
      const types = await this.workItemTypes();
      const hit = types.find((t) => t.name.toLowerCase() === opts.type!.toLowerCase());
      if (!hit)
        throw new TrackerFailure(
          'validation',
          `"${opts.type}" is not a work item type; have ${types.map((t) => t.name).join(' | ')}`,
        );
      type = {id: hit.id};
    }
    const text = opts.text
      ? opts.annotate === false
        ? opts.text
        : opts.text.trimEnd() + this.annotation()
      : this.annotation().trim();
    this.log(`log work on ${idReadable}: ${duration}${opts.type ? ' ' + opts.type : ''}`);
    const raw = await this.request<{
      id: string;
      author?: {login?: string};
      duration?: {minutes?: number; presentation?: string};
      type?: {name?: string};
      text?: string;
      date: number;
    }>(
      'POST',
      `issues/${segment(idReadable)}/timeTracking/workItems`,
      {
        duration: {presentation: duration},
        text,
        usesMarkdown: true,
        ...(type ? {type} : {}),
      },
      {
        fields: 'id,author(login),duration(minutes,presentation),type(name),text,date',
      },
    );
    if (!raw || typeof raw.id !== 'string') {
      throw new TrackerFailure('unknown', 'Missing write receipt; reconcile before retrying');
    }
    return {
      id: raw.id,
      author: raw.author?.login ?? null,
      minutes: raw.duration?.minutes ?? 0,
      presentation: raw.duration?.presentation ?? duration,
      type: raw.type?.name ?? null,
      text: raw.text ?? null,
      date: raw.date,
    };
  }

  async workItems(idReadable: string): Promise<WorkItem[]> {
    checkIssueId(idReadable);
    const raw = await this.collect<{
      id: string;
      author?: {login?: string};
      duration?: {minutes?: number; presentation?: string};
      type?: {name?: string};
      text?: string;
      date: number;
    }>(`issues/${segment(idReadable)}/timeTracking/workItems`, {
      fields: 'id,author(login),duration(minutes,presentation),type(name),text,date',
      $top: '500',
    });
    return raw.map((r) => ({
      id: r.id,
      author: r.author?.login ?? null,
      minutes: r.duration?.minutes ?? 0,
      presentation: r.duration?.presentation ?? '',
      type: r.type?.name ?? null,
      text: r.text ?? null,
      date: r.date,
    }));
  }

  // Estimates are set once, by the agent that plans the work: `Estimation` is what a senior developer with domain
  // expertise in that code would need; `Token Estimate` is the expected agent token spend in millions.
  setEstimate(idReadable: string, est: {time?: string; tokens?: number | string}): Promise<Issue> {
    const fields: Record<string, string | number | null> = {};
    if (est.time !== undefined) fields.Estimation = est.time;
    if (est.tokens !== undefined) fields['Token Estimate'] = parseTokens(est.tokens);
    return this.setFields(idReadable, fields);
  }

  // Work time appends once. Token accumulation requires a provider concurrency guarantee that YouTrack lacks.
  async addActual(
    idReadable: string,
    actual: {
      time?: string;
      tokens?: number | string;
      text?: string;
      type?: string;
    },
  ): Promise<{issue: Issue; work: WorkItem | null}> {
    const validated = validateActual(actual);
    assertAccountingSupported(validated, {atomicAccounting: false});
    // Read before appending so a failed issue lookup cannot obscure a confirmed work item.
    const issue = await this.getIssue(idReadable);
    const work = validated.time
      ? await this.logWork(idReadable, validated.time, {
          text: validated.text,
          type: validated.type,
        })
      : null;
    // This is the pre-write issue snapshot; callers can explicitly refresh computed Spent time.
    return {issue, work};
  }

  // ---- subsystems ----
  // A subsystem lives in two places: the Subsystem field's bundle (so issues can carry it) and the kanban board's
  // swimlane value list (so its cards get a lane instead of "Uncategorized Cards"). Add both together.
  async addSubsystem(name: string, description = '', boardName = this.board): Promise<void> {
    return this.admin.addSubsystem(name, description, boardName);
  }

  async swimlanes(boardName = this.board): Promise<string[]> {
    const boards = await this.collect<{name: string; swimlaneSettings?: {values?: {name: string}[]}}>('agiles', {
      fields: 'name,swimlaneSettings(values(name))',
    });
    return (boards.find((x) => x.name === boardName)?.swimlaneSettings?.values ?? []).map((v) => v.name);
  }

  // ---- command language escape hatch ----
  // Anything the UI's command box accepts: "Stage Review", "for some-login", "tag regression", "Priority Major".
  // Several at once separated by spaces, as in the UI. The optional comment is annotated like addComment.
  async command(idReadables: string[], query: string, comment?: string): Promise<void> {
    for (const id of idReadables) checkIssueId(id);
    this.log(`command on ${idReadables.join(',')}`);
    await this.request('POST', 'commands', {
      query,
      issues: idReadables.map((id) => ({idReadable: id})),
      ...(comment ? {comment: comment.trimEnd() + this.annotation()} : {}),
    });
  }
}

export function createClient(identity: AgentIdentity, opts: Omit<ClientOptions, 'identity'> = {}): YouTrackClient {
  return new YouTrackClient({...opts, identity});
}
