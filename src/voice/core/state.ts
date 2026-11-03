/**
 * Per-person conversation state (YA-13). The core owns this shape and versions it; adapters store it as an opaque
 * string through `UserStateStore`. What it holds, and why:
 *
 * - the working set: the keys (and summaries, for re-reading pages) captured when a list was read, and when, so
 *   an ordinal always means what the person heard, and expires rather than being guessed. A list of people to choose
 *   between (YA-35) is a working set too, of logins and full names;
 * - focus: the open issue, the part being read and the reading offset, so "more" resumes after a closed session;
 * - the last reply, for "repeat";
 * - preferences: verbosity and speech rate.
 *
 * It holds issue summaries and the last spoken reply, so a store is as private as the tracker it serves.
 */
import type {Cursor} from './paging.ts';
import type {Earcon, SpeechSegment} from './types.ts';

/**
 * Version 2 replaced page offsets (numbers) with cursors (`{unit, piece}`), so a position survives a change of
 * verbosity or speech limit. Version 1 states are migrated. The `assignee` and `people` list sources (YA-35) only
 * widen what version 2 accepts, as does `places` (YA-36), so every stored version 2 state still loads unchanged.
 */
export const STATE_VERSION = 2;

export type Verbosity = 'brief' | 'normal' | 'full';
export type ListScope = 'mine' | 'in-progress' | 'open' | 'recent';
export type Part = 'summary' | 'description' | 'comments' | 'fields';

export const VERBOSITIES: readonly Verbosity[] = ['brief', 'normal', 'full'];
export const LIST_SCOPES: readonly ListScope[] = ['mine', 'in-progress', 'open', 'recent'];
export const PARTS: readonly Part[] = ['summary', 'description', 'comments', 'fields'];

export const DEFAULT_RATE_PERCENT = 100;
export const MIN_RATE_PERCENT = 50;
export const MAX_RATE_PERCENT = 250;

const EARCONS: readonly Earcon[] = ['success', 'failure', 'endOfList', 'listening'];

/** Where a working set came from, so "where am I" can name it and an expired list can say how to get it back. */
export interface ScopeSource {
  kind: 'scope';
  scope: ListScope;
}

export interface FindSource {
  kind: 'find';
  words: string;
}

/** Someone else's open issues (YA-35). The login is for re-running the query and is never spoken. */
export interface AssigneeSource {
  kind: 'assignee';
  login: string;
  name: string;
}

/**
 * The people a spoken name matched more than one of, as a numbered list to choose from. Each item's `key` is a login
 * and its `summary` the full name; opening one lists that person's issues.
 */
export interface PeopleSource {
  kind: 'people';
  /** The name as it was said, filler words removed, at most six words. */
  said: string;
  /**
   * A single close match waiting for yes or no ("Did you mean Mary Jones?", review F4). Its one item is the person;
   * "yes" or "one" lists their issues, "no" drops the question.
   */
  confirming?: true;
}

/**
 * Places of one name to choose from (YA-36 review C3): "Did you mean Springfield, Illinois, or Springfield, Missouri?".
 * Each item's `key` and `summary` are the place name, as the geocoder gave it; choosing one looks up its air quality.
 */
export interface PlacesSource {
  kind: 'places';
  /** The words as said, at most twelve. */
  said: string;
}

export type ListSource = ScopeSource | FindSource | AssigneeSource | PeopleSource | PlacesSource;

export interface WorkingSetItem {
  /** An issue key; in a list of people, a login. Never spoken. */
  key: string;
  summary: string;
  state: string | null;
}

export interface WorkingSet {
  source: ListSource;
  items: WorkingSetItem[];
  /** False when the tracker capped the list: the count is "at least". */
  complete: boolean;
  capturedAt: number;
  /** The page last read: where it started, and where the next one starts. */
  pageStart: Cursor;
  pageEnd: Cursor;
}

/** Human position within a part, e.g. paragraph 2 of 5: the last one heard. */
export interface Progress {
  current: number;
  total: number;
  /** False when the total is "at least" (a capped comment list). */
  complete: boolean;
}

export interface Focus {
  key: string;
  summary: string;
  /**
   * Its position in the working set when opened by number; null when opened by id. A new working set clears the
   * focus, so this number always refers to the current list.
   */
  ordinal: number | null;
  /** The part being read, or null if the issue was opened and nothing read yet. */
  part: Part | null;
  /** The page of the part last read: where it started, and where the next one starts. */
  pageStart: Cursor;
  pageEnd: Cursor;
  progress: Progress | null;
  /**
   * Only on a focus migrated from version 1, whose page offsets counted pieces of the part (a long paragraph split in
   * two took two), not paragraphs. The next read resolves them against the content and then drops them.
   */
  v1Offsets?: {pageStart: number; pageEnd: number};
}

export interface StoredReply {
  segments: SpeechSegment[];
  earcon?: Earcon;
  reprompt?: SpeechSegment[];
}

export interface ConversationState {
  version: typeof STATE_VERSION;
  verbosity: Verbosity;
  ratePercent: number;
  workingSet: WorkingSet | null;
  focus: Focus | null;
  /** What "more" and "previous" move through. */
  active: 'list' | 'issue' | null;
  lastReply: StoredReply | null;
  updatedAt: number;
}

export const START: Cursor = {unit: 0, piece: 0};

export function initialState(): ConversationState {
  return {
    version: STATE_VERSION,
    verbosity: 'brief',
    ratePercent: DEFAULT_RATE_PERCENT,
    workingSet: null,
    focus: null,
    active: null,
    lastReply: null,
    updatedAt: 0,
  };
}

export function serialiseState(state: ConversationState): string {
  return JSON.stringify(state);
}

/** How a stored string turned into state, for logs. */
export type StateOutcome = 'fresh' | 'loaded' | 'migrated' | 'discarded';

export interface ParsedState {
  state: ConversationState;
  outcome: StateOutcome;
  /** Why a stored state was discarded; never contains the state itself. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSegments(value: unknown): value is SpeechSegment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) =>
        isRecord(segment) &&
        isString(segment.text) &&
        (segment.pauseAfter === undefined || segment.pauseAfter === 'short' || segment.pauseAfter === 'long'),
    )
  );
}

function isSource(value: unknown): value is ListSource {
  if (!isRecord(value)) return false;
  if (value.kind === 'scope') return LIST_SCOPES.includes(value.scope as ListScope);
  if (value.kind === 'assignee') return isString(value.login) && isString(value.name);
  if (value.kind === 'places') return isString(value.said);
  if (value.kind === 'people') {
    return isString(value.said) && (value.confirming === undefined || value.confirming === true);
  }
  return value.kind === 'find' && isString(value.words);
}

/** A cursor, clamped to non-negative whole numbers; null if it is not one. Version 1 stored a plain unit offset. */
function readCursor(value: unknown, version: number): Cursor | null {
  if (version === 1) return isFiniteNumber(value) ? {unit: Math.max(0, Math.floor(value)), piece: 0} : null;
  if (!isRecord(value) || !isFiniteNumber(value.unit) || !isFiniteNumber(value.piece)) return null;
  return {unit: Math.max(0, Math.floor(value.unit)), piece: Math.max(0, Math.floor(value.piece))};
}

function readWorkingSet(value: unknown, version: number): WorkingSet | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isSource(value.source) ||
    !Array.isArray(value.items) ||
    !value.items.every(
      (item) =>
        isRecord(item) && isString(item.key) && isString(item.summary) && (item.state === null || isString(item.state)),
    ) ||
    typeof value.complete !== 'boolean' ||
    !isFiniteNumber(value.capturedAt)
  ) {
    return undefined;
  }
  const pageStart = readCursor(value.pageStart, version);
  const pageEnd = readCursor(value.pageEnd, version);
  if (pageStart === null || pageEnd === null) return undefined;
  return {
    source: value.source,
    items: value.items as WorkingSetItem[],
    complete: value.complete,
    capturedAt: value.capturedAt,
    pageStart,
    pageEnd,
  };
}

function readFocus(value: unknown, version: number): Focus | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isString(value.key) ||
    !isString(value.summary) ||
    !(value.ordinal === null || isFiniteNumber(value.ordinal)) ||
    !(value.part === null || PARTS.includes(value.part as Part))
  ) {
    return undefined;
  }
  const pageStart = readCursor(value.pageStart, version);
  const pageEnd = readCursor(value.pageEnd, version);
  if (pageStart === null || pageEnd === null) return undefined;
  let progress: Progress | null = null;
  const rawProgress = value.progress;
  if (rawProgress !== null) {
    if (
      !isRecord(rawProgress) ||
      !isFiniteNumber(rawProgress.current) ||
      !isFiniteNumber(rawProgress.total) ||
      typeof rawProgress.complete !== 'boolean'
    ) {
      return undefined;
    }
    const total = Math.max(0, Math.floor(rawProgress.total));
    progress = {
      current: Math.min(Math.max(1, Math.floor(rawProgress.current)), total),
      total,
      complete: rawProgress.complete,
    };
  }
  const ordinal = value.ordinal;
  const focus: Focus = {
    key: value.key,
    summary: value.summary,
    // A number below one is not a position; the issue is still open, just without a number.
    ordinal: ordinal !== null && ordinal >= 1 ? Math.floor(ordinal) : null,
    part: value.part as Part | null,
    pageStart,
    pageEnd,
    progress,
  };
  const rawOffsets = version === 1 ? {pageStart: value.pageStart, pageEnd: value.pageEnd} : value.v1Offsets;
  if (rawOffsets !== undefined && focus.part !== null) {
    if (!isRecord(rawOffsets) || !isFiniteNumber(rawOffsets.pageStart) || !isFiniteNumber(rawOffsets.pageEnd)) {
      return undefined;
    }
    // Version 1 offsets are piece indexes, so the unit cursors above are only a stand-in until the next read.
    focus.pageStart = START;
    focus.pageEnd = START;
    focus.v1Offsets = {
      pageStart: Math.max(0, Math.floor(rawOffsets.pageStart)),
      pageEnd: Math.max(0, Math.floor(rawOffsets.pageEnd)),
    };
  }
  return focus;
}

function isStoredReply(value: unknown): value is StoredReply {
  return (
    isRecord(value) &&
    isSegments(value.segments) &&
    (value.earcon === undefined || EARCONS.includes(value.earcon as Earcon)) &&
    (value.reprompt === undefined || isSegments(value.reprompt))
  );
}

function discard(reason: string): ParsedState {
  return {state: initialState(), outcome: 'discarded', reason};
}

/**
 * Parses a stored state. Absent state is fresh. A state that is malformed, or from a newer version this core does
 * not understand, is discarded and replaced with a fresh one: a lost place in a list is recoverable by asking
 * again, a crash on every turn is not. Version 1 is migrated. Numbers are range-checked as well as type-checked:
 * the rate is clamped, and negative offsets and positions are pulled back to the start.
 */
export function parseState(serialized: string | null): ParsedState {
  if (serialized === null) return {state: initialState(), outcome: 'fresh'};
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return discard('not-json');
  }
  if (!isRecord(raw)) return discard('not-an-object');
  if (!isFiniteNumber(raw.version)) return discard('no-version');
  if (raw.version > STATE_VERSION) return discard(`newer-version-${raw.version}`);
  if (raw.version !== 1 && raw.version !== 2) return discard(`unknown-version-${raw.version}`);
  const version = raw.version;

  const verbosity = VERBOSITIES.includes(raw.verbosity as Verbosity) ? (raw.verbosity as Verbosity) : null;
  const workingSet = readWorkingSet(raw.workingSet, version);
  let focus = readFocus(raw.focus, version);
  // Version 1 could keep a focus from a list that had since been replaced (review C3). With a list active, that
  // focus and its number no longer belong to anything the person heard, so it is dropped.
  if (version === 1 && raw.active === 'list' && focus !== undefined) focus = null;
  if (
    verbosity === null ||
    !isFiniteNumber(raw.ratePercent) ||
    workingSet === undefined ||
    focus === undefined ||
    !(raw.active === null || raw.active === 'list' || raw.active === 'issue') ||
    !(raw.lastReply === null || isStoredReply(raw.lastReply)) ||
    !isFiniteNumber(raw.updatedAt)
  ) {
    return discard(`malformed-v${version}`);
  }
  return {
    state: {
      version: STATE_VERSION,
      verbosity,
      ratePercent: Math.min(MAX_RATE_PERCENT, Math.max(MIN_RATE_PERCENT, raw.ratePercent)),
      workingSet,
      focus,
      active: raw.active,
      lastReply: raw.lastReply,
      updatedAt: raw.updatedAt,
    },
    outcome: version === STATE_VERSION ? 'loaded' : 'migrated',
  };
}
