/** Provider-neutral operations used by agent workflows (YA-8). */
export interface WorkflowFields {
  state: string | null;
  role: string | null;
  assignee: string | null;
  recommendedModel: string | null;
  subsystem: string | null;
}

/** A tracker issue with provider-independent workflow fields. */
export interface TrackerIssue {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  url: string;
  updated: number;
  workflow: WorkflowFields;
  /**
   * The assignee's full name, for people to read or hear, when the provider reports one; `workflow.assignee` stays the
   * login. Read-only: absent from `IssueChanges`, so it can never be written. Optional, so providers that cannot say
   * are still valid.
   */
  assigneeName?: string | null;
}

/** Optional provider-specific fields are an explicit escape hatch, not workflow state. */
export interface IssueChanges {
  summary?: string;
  description?: string;
  workflow?: Partial<WorkflowFields>;
  extraFields?: Record<string, string | string[] | number | null>;
}

export interface NewIssue extends IssueChanges {
  summary: string;
}

export interface IterationTarget {
  scopeId: string;
  scopeName: string;
  iterationId: string;
  iterationName: string;
}

/** Results must distinguish unavailable placement from a project with no iterations. */
export interface IterationDiscovery {
  targets: IterationTarget[];
  unavailable: string[];
  /** Scopes with iterations enabled but no active current iteration (between sprints); not a failure. */
  withoutCurrent: string[];
}

/** Structured filters cover workflow queries; native query strings stay in the provider API. */
export interface IssueFilter {
  state?: string;
  role?: string;
  subsystem?: string;
  recommendedModel?: string;
  /** `me` is the login the tracker credential belongs to; any other value is a login. */
  assignee?: string;
  /**
   * Words matched against summaries, never interpreted as query syntax. Punctuation is removed from each word and a
   * word with no letter or digit is dropped; text with no words left adds no text condition at all.
   */
  text?: string;
  /**
   * `all` (the default) needs every word in the summary. `any` needs at least one, which suits spoken queries with
   * extra or misheard words; rank the results client-side. Either way the words stay inside one group that is
   * and-ed with the project and the other filters.
   */
  textMode?: 'all' | 'any';
  /** Unresolved issues only. */
  unresolved?: boolean;
  /** At most this many issues (default 50). */
  limit?: number;
}

/** `complete` is false when more issues match than the limit returned; never present such a list as all of them. */
export interface IssueList {
  issues: TrackerIssue[];
  complete: boolean;
}

export interface TrackerComment {
  authorName: string;
  /** The author's login, when the provider reports one, so a reader can tell a real name from a login. Never shown. */
  authorLogin?: string | null;
  created: number;
  text: string;
}

/** `complete` is false when the issue has more comments than the limit returned. */
export interface CommentList {
  comments: TrackerComment[];
  complete: boolean;
}

/** No implicit promise of atomic multi-request writes or compare-and-swap support. */
export interface TrackerCapabilities {
  iterations: boolean;
  conditionalUpdates: boolean;
  atomicAccounting: boolean;
}

export type TrackerFailureKind =
  'validation' | 'not-found' | 'permission' | 'conflict' | 'unsupported' | 'unavailable' | 'unknown';

/** `unknown` means a mutation may have reached the provider and must not be blindly retried. */
export class TrackerFailure extends Error {
  readonly kind: TrackerFailureKind;

  constructor(kind: TrackerFailureKind, message: string) {
    super(message);
    this.name = 'TrackerFailure';
    this.kind = kind;
  }
}

/** The application depends on this port; provider administration is intentionally absent. */
export interface TrackerPort {
  readonly capabilities: TrackerCapabilities;
  getIssue(key: string): Promise<TrackerIssue>;
  listIssues(filter: IssueFilter): Promise<IssueList>;
  /** The first `limit` comments, oldest first. */
  listComments(key: string, limit: number): Promise<CommentList>;
  createIssue(input: NewIssue): Promise<TrackerIssue>;
  updateIssue(key: string, changes: IssueChanges): Promise<TrackerIssue>;
  addComment(key: string, text: string): Promise<{id: string}>;
  currentActor(): Promise<{id: string; name: string}>;
  discoverIterations(key: string): Promise<IterationDiscovery>;
  /** `issueId` is the provider entity id when the caller already has it; without it the provider reads the issue. */
  placeInIteration(key: string, target: IterationTarget, issueId?: string): Promise<void>;
}

export type WorkflowStatus = 'completed' | 'partial' | 'rejected' | 'unknown';

/** Applied steps are confirmed, pending steps were not attempted, and uncertain steps need reconciliation. */
export interface WorkflowResult {
  status: WorkflowStatus;
  issue?: TrackerIssue;
  applied: string[];
  pending: string[];
  uncertain: string[];
  message?: string;
}
