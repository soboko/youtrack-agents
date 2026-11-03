/**
 * The conversation core (YA-13, packet docs/architecture/YA-10.md). `converse` loads the speaker's state, takes one
 * turn with `step`, saves, and answers. `step` depends only on its ports and an injected clock: no platform object,
 * no network, no timers. Stage 1 reads only; later-stage intents answer "not yet".
 *
 * Logging: intents, slot names, counts, timings, state versions and gating decisions go to `info`; tracker content,
 * slot values, ids, author names, utterances and speech go to `debug` only, because logs leave the house.
 *
 * Concurrency: saves are optimistic (`UserStateStore` versions). When two turns for one person overlap, the later
 * save is refused, logged at `warn` and not retried, so the other turn's state stands.
 */
import type {TrackerFailureKind, TrackerIssue} from '../../tracker.ts';
import {isExactName, matchesEveryWord, matchPeople, nameWords, rankBySummary, searchWords} from './fuzzy.ts';
import {canonicalSlotValue, FALLBACK_ORDINAL_SLOT, parseUtterance} from './grammar.ts';
import {INTENT_CATALOGUE} from './intents.ts';
import {cursorAtIndex, indexAtCursor, pageBackward, pageForward} from './paging.ts';
import type {Cursor, PageRange} from './paging.ts';
import * as phrasing from './phrasing.ts';
import type {Reply} from './phrasing.ts';
import {parseOrdinal, parseRate, resolveEnum, spokenId} from './slots.ts';
import {
  asSentence,
  MAX_NAME_CHARS,
  nameForSpeech,
  speakableBlocks,
  speakableInline,
  speakablePersonName,
  splitForSpeech,
} from './speakable.ts';
import {
  DEFAULT_RATE_PERCENT,
  LIST_SCOPES,
  MAX_RATE_PERCENT,
  MIN_RATE_PERCENT,
  PARTS,
  START,
  VERBOSITIES,
  initialState,
  parseState,
  serialiseState,
} from './state.ts';
import type {ConversationState, Focus, ListScope, ListSource, Part, Verbosity, WorkingSet} from './state.ts';
import type {
  AdapterCapabilities,
  AirLookupContext,
  AirQualityNamed,
  AirQualityPort,
  AirQualityResult,
  ConversationDeps,
  DeviceLocation,
  Converse,
  IntentName,
  IntentSpec,
  Speaker,
  SpeechSegment,
  VoiceComment,
  VoiceInput,
  VoiceIssueQuery,
  VoiceLogger,
  VoicePolicy,
  VoiceRequest,
  VoiceResponse,
  VoiceTracker,
} from './types.ts';

/** The packet's default policy for personal use: reads on a recognised voice or the linked account. */
export const DEFAULT_POLICY: VoicePolicy = {
  readAccepts: ['person', 'account'],
  writeAccepts: ['person'],
  workingSetTtlMs: 12 * 60 * 60 * 1000,
};

/** Most issues fetched into one working set. More than this is spoken as "at least". */
export const LIST_FETCH_LIMIT = 50;
/** "Recent issues" is the most recently updated few, not a count of everything. */
export const RECENT_LIMIT = 10;
export const COMMENT_FETCH_LIMIT = 50;
/** Most people a spoken name is matched against. More than this, and "nobody called" says "among the first". */
export const PEOPLE_FETCH_LIMIT = 50;
/** A spoken person who is the speaker: "issues for me" is "my issues". */
const SELF_WORDS: ReadonlySet<string> = new Set(['me', 'my', 'mine', 'myself']);
/** A spoken person who is everybody: "issues for everyone" is the open issues (review F7). */
const EVERYONE_WORDS: ReadonlySet<string> = new Set(['all', 'everyone', 'everybody']);
/** A list the voice client does not read: closed work. Said in a person's place, it gets a short refusal. */
const CLOSED_WORDS: ReadonlySet<string> = new Set(['closed', 'resolved', 'fixed', 'done']);
/** The most words of a spoken name kept for matching, echoing and storing (review F6). */
const MAX_NAME_WORDS = 6;
/** The tracker's name for work in progress. YouTrack's default; the binding (YA-15) may map it. */
export const IN_PROGRESS_STATE = 'In Progress';
/** Recogniser confidence below this is treated as not heard, rather than acted on. */
export const MIN_CONFIDENCE = 0.3;

export const RATE_STEP_PERCENT = 25;
export {MAX_RATE_PERCENT, MIN_RATE_PERCENT};

/**
 * The smallest `maxSpeechChars` the core pages cleanly within. Below it a single piece plus its lead and hint can
 * still exceed the limit, and the last-resort trim (logged at `warn`) cuts the reply.
 */
export const MIN_SUPPORTED_SPEECH_CHARS = 250;

/** List pieces per page. Brief is at most five (design rule 3). */
const ITEMS_PER_PAGE: Readonly<Record<Verbosity, number>> = {brief: 5, normal: 10, full: 20};
/** Paragraph or comment pieces per page: one at a time unless full. */
const UNITS_PER_PAGE: Readonly<Record<Verbosity, number>> = {brief: 1, normal: 1, full: 50};
/**
 * Characters kept back from a piece's budget for the page lead and footer. The longest lead is about 35 characters
 * ("Issues 11 to 15 of at least 50.") and the longest footer about 70.
 */
const PAGE_RESERVE_CHARS = 110;
/** The smallest piece a long text is split into. */
const MIN_PIECE_CHARS = 40;
/** A summary inside another sentence ("You were reading the comments of ...") is cut to this, with words saying so. */
const TITLE_IN_SENTENCE_CHARS = 150;
/** An author name in a comment header is cut to this, so a pasted signature cannot crowd out the comment. */
const AUTHOR_IN_HEADER_CHARS = 60;

/**
 * Intents that reveal tracker content, so need `readAccepts` evidence. Everything at stage 1 not listed in
 * `UNGATED_INTENTS` is gated; the tests derive the gated set the same way, so a new read intent is gated by default.
 */
export const UNGATED_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'help',
  'setVerbosity',
  'setRate',
  'cancel',
  'stop',
  // Public sensor data, no tracker content (YA-36): any speaker may ask, linked or not.
  'airQuality',
  'airQualityPlace',
  'airQualityIndoor',
]);

/** "Yes", "no" and "done" before anything asks for them. */
const ANSWER_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>(['confirm', 'deny', 'finishDictation']);

const SPECS: ReadonlyMap<IntentName, IntentSpec> = new Map(INTENT_CATALOGUE.map((spec) => [spec.name, spec]));

/** Everything a turn can use. Built by `converse` from the request and the deps. */
export interface StepContext {
  tracker: VoiceTracker;
  policy: VoicePolicy;
  now: () => number;
  log: VoiceLogger;
  capabilities: AdapterCapabilities;
  speaker: Speaker;
  requestId: string;
  /** A valid IANA zone, or undefined: dates are then absolute. */
  timeZone?: string;
  /** The turn's deadline. Once aborted, no further tracker call is made. */
  signal?: AbortSignal;
  /** The air-quality service, when configured (YA-36). */
  airQuality?: AirQualityPort;
  /** The device's postal code and country, when the adapter has them. */
  deviceLocation?: DeviceLocation;
  /** Epoch ms by which the adapter must answer. */
  deadline?: number;
}

export interface StepResult {
  reply: Reply;
  state: ConversationState;
  /** The intent handled, or `launch`, `sessionEnded`, `unmatched`. For logs. */
  handled: string;
  /** Whether "repeat" should replay this reply later. False for refusals, misses, goodbyes and repeats. */
  remember: boolean;
}

interface Turn {
  intent: IntentName;
  slots: Partial<Record<string, string>>;
}

type Slots = Partial<Record<string, string>>;

interface Handled {
  reply: Reply;
  state: ConversationState;
}

// ---------------------------------------------------------------------------------------------------------------
// Ports, with timings and failure kinds logged.

type FailureKind = TrackerFailureKind | 'aborted';

type Outcome<T> = {ok: true; value: T} | {ok: false; kind: FailureKind};

const KNOWN_FAILURES: readonly string[] = [
  'validation',
  'not-found',
  'permission',
  'conflict',
  'unsupported',
  'unavailable',
];

function failureKindOf(error: unknown): TrackerFailureKind {
  // TrackerFailure carries a kind; anything else thrown by a binding is unknown.
  if (typeof error === 'object' && error !== null && 'kind' in error && typeof error.kind === 'string') {
    return KNOWN_FAILURES.includes(error.kind) ? (error.kind as TrackerFailureKind) : 'unknown';
  }
  return 'unknown';
}

function aborted(ctx: StepContext): boolean {
  return ctx.signal?.aborted === true;
}

async function callTracker<T>(
  ctx: StepContext,
  method: 'listIssues' | 'getIssue' | 'listComments' | 'listAssignees',
  run: () => Promise<T>,
  describe: (value: T) => Record<string, unknown>,
): Promise<Outcome<T>> {
  if (aborted(ctx)) {
    ctx.log('info', 'voice.tracker.skipped', {requestId: ctx.requestId, method, reason: 'aborted'});
    return {ok: false, kind: 'aborted'};
  }
  const started = ctx.now();
  try {
    const value = await run();
    ctx.log('info', 'voice.tracker.call', {
      requestId: ctx.requestId,
      method,
      ms: ctx.now() - started,
      ...describe(value),
    });
    return {ok: true, value};
  } catch (error) {
    const kind = failureKindOf(error);
    ctx.log('warn', 'voice.tracker.failed', {requestId: ctx.requestId, method, ms: ctx.now() - started, kind});
    ctx.log('debug', 'voice.tracker.failedDetail', {
      requestId: ctx.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {ok: false, kind};
  }
}

function failureReply(kind: FailureKind): Reply {
  return kind === 'permission' ? phrasing.trackerRefused() : phrasing.trackerUnavailable();
}

// ---------------------------------------------------------------------------------------------------------------
// Input to a turn.

function slotNames(slots: Slots): string[] {
  return Object.keys(slots).sort();
}

function resolveTurn(input: VoiceInput, ctx: StepContext): Turn | null {
  if (input.kind === 'utterance') {
    ctx.log('debug', 'voice.grammar.text', {requestId: ctx.requestId, text: input.text});
    if (input.confidence !== undefined && input.confidence < MIN_CONFIDENCE) {
      ctx.log('info', 'voice.grammar.lowConfidence', {requestId: ctx.requestId, confidence: input.confidence});
      return null;
    }
    const parsed = parseUtterance(input.text);
    if (!parsed.matched) {
      ctx.log('info', 'voice.grammar.unmatched', {
        requestId: ctx.requestId,
        words: parsed.normalised === '' ? 0 : parsed.normalised.split(' ').length,
      });
      return null;
    }
    ctx.log('info', 'voice.intent', {
      requestId: ctx.requestId,
      source: 'grammar',
      intent: parsed.intent,
      slots: slotNames(parsed.slots),
      sample: parsed.sample,
      score: parsed.score,
    });
    ctx.log('debug', 'voice.intent.slots', {requestId: ctx.requestId, slots: parsed.slots});
    return {intent: parsed.intent, slots: parsed.slots};
  }
  if (input.kind === 'intent') {
    const spec = SPECS.get(input.intent);
    if (spec === undefined) {
      ctx.log('warn', 'voice.intent.unknown', {requestId: ctx.requestId, source: 'adapter'});
      return null;
    }
    // Adapter slot values go through the same parsers as the grammar's, and a value that does not parse is absent.
    const slots: Slots = {};
    const dropped: string[] = [];
    for (const slot of spec.slots) {
      const raw = input.slots[slot.name];
      if (raw === undefined || raw.trim() === '') continue;
      const value = canonicalSlotValue(slot, raw);
      if (value === null) {
        dropped.push(slot.name);
      } else {
        slots[slot.name] = value;
      }
    }
    // Alexa may put a name in the scope slot, which is not an enumeration ("chris issues" as scope "chris"). A scope
    // that is no scope, with no person, is heard as the person, rather than quietly read as "my issues".
    const raw = input.slots.scope;
    const person = spec.slots.find((slot) => slot.name === 'person');
    if (dropped.includes('scope') && slots.person === undefined && person !== undefined && raw !== undefined) {
      const value = canonicalSlotValue(person, raw);
      if (value !== null) {
        slots.person = value;
        dropped.splice(dropped.indexOf('scope'), 1);
        ctx.log('info', 'voice.intent.scopeAsPerson', {requestId: ctx.requestId});
      }
    }
    ctx.log('info', 'voice.intent', {
      requestId: ctx.requestId,
      source: 'adapter',
      intent: spec.name,
      slots: slotNames(slots),
      dropped,
    });
    ctx.log('debug', 'voice.intent.slots', {requestId: ctx.requestId, slots: input.slots});
    return {intent: spec.name, slots};
  }
  return null;
}

function mayRead(ctx: StepContext, intent: string): boolean {
  const allowed = ctx.speaker.evidence.some((kind) => ctx.policy.readAccepts.includes(kind));
  ctx.log('info', 'voice.gate', {
    requestId: ctx.requestId,
    action: 'read',
    intent,
    allowed,
    evidence: ctx.speaker.evidence,
    accepts: ctx.policy.readAccepts,
  });
  return allowed;
}

// ---------------------------------------------------------------------------------------------------------------
// Speech budget and paged content.

/** Expired strictly after the lifetime: a list heard exactly `workingSetTtlMs` ago still answers. */
function isExpired(workingSet: WorkingSet, ctx: StepContext): boolean {
  const ageMs = ctx.now() - workingSet.capturedAt;
  // A capture time in the future (a clock moved back, or a bad store) is not trusted either.
  const expired = ageMs > ctx.policy.workingSetTtlMs || ageMs < 0;
  if (expired) {
    ctx.log('info', 'voice.workingSet.expired', {requestId: ctx.requestId, ageMs, ttlMs: ctx.policy.workingSetTtlMs});
  }
  return expired;
}

function speechChars(segments: readonly SpeechSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0);
}

function fits(reply: Reply, ctx: StepContext): boolean {
  return speechChars(reply.segments) <= ctx.capabilities.maxSpeechChars;
}

/** How long a piece of text may be once its label is counted and room is kept for the page's lead and footer. */
function pieceBudget(ctx: StepContext, labelChars: number): number {
  return Math.max(ctx.capabilities.maxSpeechChars - PAGE_RESERVE_CHARS - labelChars, MIN_PIECE_CHARS);
}

/** A summary short enough to sit inside another sentence, with words saying when it was cut. */
function titleInSentence(summary: string, ctx: StepContext): string {
  const limit = Math.min(TITLE_IN_SENTENCE_CHARS, pieceBudget(ctx, 60));
  const pieces = splitForSpeech(summary, limit);
  return pieces.length > 1 ? `${pieces[0].replace(/[.!?]+$/, '')}${phrasing.TITLE_CUT_WORDS}` : summary;
}

/** One piece of paged speech: its position and its segments (label or header included). */
interface Piece {
  unit: number;
  piece: number;
  segments: SpeechSegment[];
}

interface Content {
  pieces: Piece[];
  /** Units (items, paragraphs, comments) in the whole sequence. */
  total: number;
  complete: boolean;
}

function flatten(pieces: readonly Piece[], range: PageRange): SpeechSegment[] {
  return pieces.slice(range.start, range.end).flatMap((piece) => piece.segments);
}

/** Pieces of a list: one per item, more for an item too long to say in one response (design rule 3). */
function listPieces(workingSet: WorkingSet, verbosity: Verbosity, ctx: StepContext): Piece[] {
  const pieces: Piece[] = [];
  workingSet.items.forEach((item, unit) => {
    const labelChars = phrasing.listItemLabel(unit + 1, true).length;
    splitForSpeech(phrasing.listItemBody(item, verbosity), pieceBudget(ctx, labelChars)).forEach((text, piece) => {
      pieces.push({
        unit,
        piece,
        segments: [{text: `${phrasing.listItemLabel(unit + 1, piece > 0)}${text}`, pauseAfter: 'short'}],
      });
    });
  });
  return pieces;
}

function renderListPage(workingSet: WorkingSet, pieces: readonly Piece[], range: PageRange): Reply {
  const total = workingSet.items.length;
  if (pieces.length === 0) {
    return phrasing.listPage({
      source: workingSet.source,
      total,
      complete: workingSet.complete,
      segments: [],
      first: true,
      from: 0,
      to: 0,
      remaining: 0,
      midItem: false,
    });
  }
  const last = pieces[range.end - 1];
  const next = pieces[range.end];
  return phrasing.listPage({
    source: workingSet.source,
    total,
    complete: workingSet.complete,
    segments: flatten(pieces, range),
    first: range.start === 0,
    from: pieces[range.start].unit + 1,
    to: last.unit + 1,
    remaining: total - (last.unit + 1),
    midItem: next !== undefined && next.unit === last.unit,
  });
}

type PageMode = 'first' | 'next' | 'previous';

function speakList(state: ConversationState, workingSet: WorkingSet, mode: PageMode, ctx: StepContext): Handled {
  if (workingSet.source.kind === 'places') {
    // A choice between places has no pages: "more", "previous" and resuming all ask it again.
    return {
      reply: phrasing.airWhichPlace(workingSet.items.map((item) => item.summary)),
      state: {...state, active: 'list'},
    };
  }
  if (workingSet.source.kind === 'people' && workingSet.source.confirming && workingSet.items.length > 0) {
    // A yes-or-no question has no pages: "more", "previous" and resuming all ask it again.
    return {reply: phrasing.didYouMean(workingSet.items[0].summary), state: {...state, active: 'list'}};
  }
  const pieces = listPieces(workingSet, state.verbosity, ctx);
  const perPage = ITEMS_PER_PAGE[state.verbosity];
  const fitsPage = (range: PageRange): boolean => fits(renderListPage(workingSet, pieces, range), ctx);

  let range: PageRange | null;
  if (pieces.length === 0) {
    range = {start: 0, end: 0};
  } else if (mode === 'first') {
    range = pageForward(0, pieces.length, perPage, fitsPage);
  } else if (mode === 'next') {
    range = pageForward(indexAtCursor(pieces, workingSet.pageEnd), pieces.length, perPage, fitsPage);
    if (range === null) {
      return {reply: phrasing.endOfList(workingSet.source, workingSet.complete, workingSet.items.length), state};
    }
  } else {
    range = pageBackward(indexAtCursor(pieces, workingSet.pageStart), perPage, fitsPage);
    if (range === null) return {reply: phrasing.startOfList(), state};
  }
  if (range === null) {
    return {reply: phrasing.endOfList(workingSet.source, workingSet.complete, workingSet.items.length), state};
  }

  ctx.log('info', 'voice.page', {
    requestId: ctx.requestId,
    what: 'list',
    mode,
    start: range.start,
    end: range.end,
    pieces: pieces.length,
    total: workingSet.items.length,
    complete: workingSet.complete,
  });
  const updated: WorkingSet = {
    ...workingSet,
    pageStart: cursorAtIndex(pieces, range.start),
    pageEnd: cursorAtIndex(pieces, range.end),
  };
  return {reply: renderListPage(workingSet, pieces, range), state: {...state, workingSet: updated, active: 'list'}};
}

function scopeQuery(scope: ListScope): VoiceIssueQuery {
  switch (scope) {
    case 'mine':
      return {assignee: 'me', unresolved: true, limit: LIST_FETCH_LIMIT};
    case 'in-progress':
      return {assignee: 'me', state: IN_PROGRESS_STATE, limit: LIST_FETCH_LIMIT};
    case 'open':
      return {unresolved: true, limit: LIST_FETCH_LIMIT};
    case 'recent':
      return {limit: RECENT_LIMIT};
    default:
      return {assignee: 'me', unresolved: true, limit: LIST_FETCH_LIMIT};
  }
}

function capturedItems(issues: readonly TrackerIssue[]): WorkingSet['items'] {
  return issues.map((issue) => ({
    key: issue.key,
    summary: speakableInline(issue.summary),
    state: issue.workflow.state === null ? null : speakableInline(issue.workflow.state),
  }));
}

function describeList(value: {issues: TrackerIssue[]; complete: boolean}): Record<string, unknown> {
  return {count: value.issues.length, complete: value.complete};
}

function newFocus(issue: TrackerIssue, ordinal: number | null): Focus {
  return {
    key: issue.key,
    summary: speakableInline(issue.summary),
    ordinal,
    part: null,
    pageStart: START,
    pageEnd: START,
    progress: null,
  };
}

/** The opened-issue reply, with an over-long summary cut to its first piece and the way to hear the rest. */
function openedReply(issue: TrackerIssue, ordinal: number | null, id: string | null, ctx: StepContext): Reply {
  const summary = speakableInline(issue.summary);
  const base: phrasing.OpenedInput = {
    ordinal,
    spokenId: id === null ? null : spokenId(id),
    summary: '',
    summaryContinues: true,
    state: issue.workflow.state === null ? null : speakableInline(issue.workflow.state),
  };
  // The summary gets what the reply's other lines, measured as they will be spoken, leave of the response.
  const otherChars = speechChars(phrasing.opened(base).segments) + 1;
  const pieces = splitForSpeech(summary, Math.max(ctx.capabilities.maxSpeechChars - otherChars, MIN_PIECE_CHARS));
  return phrasing.opened({...base, summary: pieces[0], summaryContinues: pieces.length > 1});
}

// ---------------------------------------------------------------------------------------------------------------
// Lists, search and opening.

/** A new list replaces the working set, and closes the open issue: its number belonged to the old list. */
function withNewList(state: ConversationState, workingSet: WorkingSet): ConversationState {
  return {...state, workingSet, focus: null};
}

async function handleList(state: ConversationState, slots: Slots, ctx: StepContext): Promise<Handled> {
  if (slots.scope === undefined && slots.person !== undefined) {
    const said = nameForSpeech(nameWords(slots.person).slice(0, MAX_NAME_WORDS).join(' ')).slice(0, MAX_NAME_CHARS);
    if (said === '') return {reply: phrasing.whoseIssues(), state};
    const closed = CLOSED_WORDS.has(said);
    // "Issues for me" keeps today's meaning, "issues for everyone" is the open issues, and a scope said in a person's
    // place is still that scope.
    const scope = SELF_WORDS.has(said)
      ? 'mine'
      : EVERYONE_WORDS.has(said)
        ? 'open'
        : resolveEnum('scope', LIST_SCOPES, said);
    ctx.log('info', 'voice.person.heard', {
      requestId: ctx.requestId,
      words: said.split(' ').length,
      asScope: scope,
      closed,
    });
    if (closed) return {reply: phrasing.onlyOpenIssues(), state};
    if (scope === null) return handlePerson(state, said, ctx);
    return handleList(state, {scope}, ctx);
  }
  const scope = LIST_SCOPES.find((value) => value === slots.scope) ?? 'mine';
  const query = scopeQuery(scope);
  const result = await callTracker(ctx, 'listIssues', () => ctx.tracker.listIssues(query), describeList);
  if (!result.ok) return {reply: failureReply(result.kind), state};

  const workingSet: WorkingSet = {
    source: {kind: 'scope', scope},
    items: capturedItems(result.value.issues),
    // "The 10 most recent" is a true statement however many there are, so a recent list is never "at least".
    complete: scope === 'recent' ? true : result.value.complete,
    capturedAt: ctx.now(),
    pageStart: START,
    pageEnd: START,
  };
  ctx.log('info', 'voice.workingSet.captured', {
    requestId: ctx.requestId,
    source: 'scope',
    scope,
    items: workingSet.items.length,
    complete: workingSet.complete,
  });
  return speakList(withNewList(state, workingSet), workingSet, 'first', ctx);
}

/** The list still being heard, for a reply that must not cost it; null when there is none or it has expired. */
function currentList(state: ConversationState, ctx: StepContext): ListSource | null {
  const previous = state.workingSet;
  return previous !== null && !isExpired(previous, ctx) ? previous.source : null;
}

/**
 * A name (YA-35): matched against the people with open issues in the project. One match lists their issues; several
 * are read as a numbered list to choose from, so "two" answers; none is said, and the list being heard is kept.
 */
async function handlePerson(state: ConversationState, said: string, ctx: StepContext): Promise<Handled> {
  const result = await callTracker(
    ctx,
    'listAssignees',
    () => ctx.tracker.listAssignees(PEOPLE_FETCH_LIMIT),
    (value) => ({count: value.people.length, complete: value.complete}),
  );
  if (!result.ok) return {reply: failureReply(result.kind), state};
  // Whatever the tracker binding did, nobody is matched or spoken by a login or an email (review F1). Anyone left out
  // makes the people incomplete, so "nobody called" is never said about them (F3).
  const named = result.value.people.flatMap((person) => {
    const name = speakablePersonName(person.login, person.name);
    return name === null ? [] : [{login: person.login, name}];
  });
  const complete = result.value.complete && named.length === result.value.people.length;
  const match = matchPeople(said, named);
  const only = match.people[0];
  const exact = match.people.length === 1 && isExactName(said, only);
  // What was said is echoed back ("Nobody called Sam"), unless it is some person's login or unsayable name: then it is
  // not repeated, so a login never reaches speech even when the listener said one (review F1).
  const echo = loginShaped(said, result.value.people) ? '' : said;
  ctx.log('info', 'voice.person.match', {
    requestId: ctx.requestId,
    candidates: result.value.people.length,
    unnamed: result.value.people.length - named.length,
    complete,
    matched: match.people.length,
    tier: match.tier,
    exact,
  });
  if (match.people.length === 0) {
    const stillIn = currentList(state, ctx);
    return {reply: phrasing.nobodyCalled(echo, complete, stillIn), state};
  }
  // One person by their whole name, first name or login is not a guess. One by a surname, a prefix or a near miss is
  // asked about by name before anything is read (review F4).
  if (exact) return listForPerson(state, only, ctx);
  if (match.people.length === 1) {
    const check: WorkingSet = {
      source: {kind: 'people', said: echo, confirming: true},
      items: [{key: only.login, summary: only.name, state: null}],
      complete,
      capturedAt: ctx.now(),
      pageStart: START,
      pageEnd: {unit: 1, piece: 0},
    };
    ctx.log('info', 'voice.person.confirming', {requestId: ctx.requestId, tier: match.tier});
    return {reply: phrasing.didYouMean(only.name), state: {...withNewList(state, check), active: 'list'}};
  }

  const workingSet: WorkingSet = {
    source: {kind: 'people', said: echo},
    items: match.people.map((person) => ({key: person.login, summary: person.name, state: null})),
    // Others by that name may be beyond the people the tracker gave.
    complete,
    capturedAt: ctx.now(),
    pageStart: START,
    pageEnd: START,
  };
  ctx.log('info', 'voice.workingSet.captured', {
    requestId: ctx.requestId,
    source: 'people',
    items: workingSet.items.length,
    complete,
  });
  return speakList(withNewList(state, workingSet), workingSet, 'first', ctx);
}

/** Whether spoken words are some person's login, or a name of theirs that may not be said (an email, their login). */
function loginShaped(said: string, people: readonly {login: string; name: string}[]): boolean {
  const compact = said.replace(/ /g, '');
  return people.some((person) => {
    const login = nameWords(person.login);
    if (login.join(' ') === said || login.join('') === compact) return true;
    if (speakablePersonName(person.login, person.name) !== null) return false;
    const name = nameWords(person.name);
    return name.join(' ') === said || name.join('') === compact;
  });
}

/** One person's open issues, read like "my issues". The login is only ever a query value. */
async function listForPerson(
  state: ConversationState,
  person: {login: string; name: string},
  ctx: StepContext,
): Promise<Handled> {
  const query: VoiceIssueQuery = {assignee: {login: person.login}, unresolved: true, limit: LIST_FETCH_LIMIT};
  const result = await callTracker(ctx, 'listIssues', () => ctx.tracker.listIssues(query), describeList);
  if (!result.ok) return {reply: failureReply(result.kind), state};
  const workingSet: WorkingSet = {
    source: {kind: 'assignee', login: person.login, name: nameForSpeech(person.name)},
    items: capturedItems(result.value.issues),
    complete: result.value.complete,
    capturedAt: ctx.now(),
    pageStart: START,
    pageEnd: START,
  };
  ctx.log('info', 'voice.workingSet.captured', {
    requestId: ctx.requestId,
    source: 'assignee',
    items: workingSet.items.length,
    complete: workingSet.complete,
  });
  return speakList(withNewList(state, workingSet), workingSet, 'first', ctx);
}

async function handleFind(state: ConversationState, slots: Slots, ctx: StepContext): Promise<Handled> {
  const words = slots.words;
  if (words === undefined || searchWords(words).length === 0) return {reply: phrasing.findWhat(), state};
  const query: VoiceIssueQuery = {text: words, limit: LIST_FETCH_LIMIT};
  const result = await callTracker(ctx, 'listIssues', () => ctx.tracker.listIssues(query), describeList);
  if (!result.ok) return {reply: failureReply(result.kind), state};

  if (result.value.issues.length === 0) {
    // A misheard search must not cost the list the person was on.
    const stillIn = currentList(state, ctx);
    ctx.log('info', 'voice.find.none', {requestId: ctx.requestId, keptList: stillIn !== null});
    return {reply: phrasing.noMatches(stillIn), state};
  }

  const ranked = rankBySummary(words, result.value.issues, (issue) => issue.summary);
  const workingSet: WorkingSet = {
    source: {kind: 'find', words},
    items: capturedItems(ranked),
    complete: result.value.complete,
    capturedAt: ctx.now(),
    pageStart: START,
    pageEnd: START,
  };
  ctx.log('info', 'voice.workingSet.captured', {
    requestId: ctx.requestId,
    source: 'find',
    items: workingSet.items.length,
    complete: workingSet.complete,
  });

  const only = ranked[0];
  if (ranked.length === 1 && workingSet.complete && matchesEveryWord(words, only.summary)) {
    // One match on every word is not a guess: open it, as number 1 of a list of one.
    const focus = newFocus(only, 1);
    const opened = openedReply(only, 1, null, ctx);
    const reply: Reply = {
      ...opened,
      segments: [{text: phrasing.listCount(workingSet.source, 1, true), pauseAfter: 'short'}, ...opened.segments],
    };
    const captured = {...workingSet, pageStart: START, pageEnd: {unit: 1, piece: 0}};
    return {reply, state: {...withNewList(state, captured), focus, active: 'issue'}};
  }
  return speakList(withNewList(state, workingSet), workingSet, 'first', ctx);
}

async function handleOpen(state: ConversationState, slots: Slots, ctx: StepContext): Promise<Handled> {
  const workingSet = state.workingSet;
  if (workingSet === null) return {reply: phrasing.noList(), state};
  const ordinal = slots.ordinal === undefined ? null : parseOrdinal(slots.ordinal);
  if (ordinal === null) return {reply: phrasing.whichNumber(), state};
  // Expiry is checked before the position, so an old list never answers anything about its contents.
  if (isExpired(workingSet, ctx)) return {reply: phrasing.listExpired(workingSet.source), state};

  const total = workingSet.items.length;
  const position = ordinal === 'last' ? total : ordinal;
  if (position < 1 || position > total) {
    ctx.log('info', 'voice.open.outOfRange', {requestId: ctx.requestId, position, total});
    return {reply: phrasing.noSuchNumber(Math.max(position, 1), total, workingSet.complete, workingSet.source), state};
  }
  const item = workingSet.items[position - 1];
  if (workingSet.source.kind === 'places') return handleAirChoice(state, workingSet, position, ctx);
  if (workingSet.source.kind === 'people') {
    // Choosing between people: the number picks the person, whose issues are read next.
    ctx.log('info', 'voice.person.chosen', {requestId: ctx.requestId, position, total});
    return listForPerson(state, {login: item.key, name: item.summary}, ctx);
  }
  const key = item.key;
  // Re-fetched on open: the working set holds what was heard, the tracker holds what is true now.
  const result = await callTracker(
    ctx,
    'getIssue',
    () => ctx.tracker.getIssue(key),
    () => ({}),
  );
  if (!result.ok) {
    if (result.kind === 'not-found') return {reply: phrasing.issueGone(position, workingSet.source), state};
    return {reply: failureReply(result.kind), state};
  }
  ctx.log('info', 'voice.focus', {requestId: ctx.requestId, via: 'ordinal', position});
  return {
    reply: openedReply(result.value, position, null, ctx),
    state: {...state, focus: newFocus(result.value, position), active: 'issue'},
  };
}

async function handleOpenById(state: ConversationState, slots: Slots, ctx: StepContext): Promise<Handled> {
  const id = slots.spelled;
  if (id === undefined) return {reply: phrasing.badId(), state};
  const result = await callTracker(
    ctx,
    'getIssue',
    () => ctx.tracker.getIssue(id),
    () => ({}),
  );
  if (!result.ok) {
    if (result.kind !== 'not-found') return {reply: failureReply(result.kind), state};
    const fallback = slots[FALLBACK_ORDINAL_SLOT];
    if (fallback === undefined) return {reply: phrasing.idNotFound(spokenId(id)), state};
    // "open, um, two": no issue UM-2, so the filler was a pause. Open position 2 of the current list; the reply
    // says "Number 2" and the summary, so a wrong guess is heard at once and costs only a read.
    if (state.workingSet === null) {
      ctx.log('info', 'voice.open.fillerFallback', {requestId: ctx.requestId, outcome: 'no-list'});
      return {reply: phrasing.idNotFoundNoList(spokenId(id)), state};
    }
    ctx.log('info', 'voice.open.fillerFallback', {requestId: ctx.requestId, outcome: 'ordinal'});
    return handleOpen(state, {ordinal: fallback}, ctx);
  }
  ctx.log('info', 'voice.focus', {requestId: ctx.requestId, via: 'id'});
  return {
    reply: openedReply(result.value, null, id, ctx),
    state: {...state, focus: newFocus(result.value, null), active: 'issue'},
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading parts.

function textPieces(
  unit: number,
  text: string,
  labelChars: number,
  label: (piece: number) => SpeechSegment[],
  ctx: StepContext,
): Piece[] {
  return splitForSpeech(text, pieceBudget(ctx, labelChars)).map((body, piece) => ({
    unit,
    piece,
    segments: [...label(piece), {text: body, pauseAfter: 'long'}],
  }));
}

function descriptionContent(issue: TrackerIssue, ctx: StepContext): Content {
  const blocks = speakableBlocks(issue.description);
  const pieces = blocks.flatMap((block, unit) => {
    const headerChars = phrasing.paragraphHeader(unit + 1, blocks.length, true).length;
    return textPieces(
      unit,
      block,
      headerChars,
      (piece) =>
        blocks.length > 1 || piece > 0
          ? [{text: phrasing.paragraphHeader(unit + 1, blocks.length, piece > 0), pauseAfter: 'short'}]
          : [],
      ctx,
    );
  });
  return {pieces, total: blocks.length, complete: true};
}

/** An author name short enough for a comment header, with words saying when it was cut. */
function authorInHeader(name: string): string {
  const pieces = splitForSpeech(name, AUTHOR_IN_HEADER_CHARS);
  return pieces.length > 1 ? `${pieces[0].replace(/[.!?,]+$/, '')}${phrasing.TITLE_CUT_WORDS}` : name;
}

function commentsContent(comments: readonly VoiceComment[], complete: boolean, ctx: StepContext): Content {
  const pieces = comments.flatMap((comment, unit) => {
    const header = (continued: boolean): string =>
      phrasing.commentHeader(
        unit + 1,
        comments.length,
        complete,
        // No login, email or login-shaped name is read as an author (recheck R2).
        speakablePersonName(null, comment.authorName) === null
          ? phrasing.NO_NAME_WORDS
          : authorInHeader(speakableInline(comment.authorName)),
        comment.created,
        ctx.now(),
        continued,
        ctx.timeZone,
      );
    const headerChars = Math.max(header(false).length, header(true).length);
    const body = speakableBlocks(comment.text).join(' ');
    if (body === '') return [{unit, piece: 0, segments: [{text: header(false), pauseAfter: 'short' as const}]}];
    return textPieces(unit, body, headerChars, (piece) => [{text: header(piece > 0), pauseAfter: 'short'}], ctx);
  });
  return {pieces, total: comments.length, complete};
}

function summaryContent(issue: TrackerIssue, ctx: StepContext): Content {
  const summary = speakableInline(issue.summary);
  const texts = splitForSpeech(summary, pieceBudget(ctx, 20));
  const pieces = texts.map((text, piece) => ({
    unit: 0,
    piece,
    segments: phrasing.summaryPiece(piece === texts.length - 1 ? asSentence(text) : text, piece > 0),
  }));
  return {pieces, total: 1, complete: true};
}

function fieldsContent(issue: TrackerIssue, ctx: StepContext): Content {
  const spoken = (value: string | null): string | null => (value === null ? null : speakableInline(value));
  const segments = phrasing.fieldsUnit({
    state: spoken(issue.workflow.state),
    // The full name when there is one that can be said; never the login or an email (review F1).
    assigned: issue.workflow.assignee !== null,
    assignee: speakablePersonName(issue.workflow.assignee, issue.assigneeName),
    subsystem: spoken(issue.workflow.subsystem),
    updated: issue.updated,
    now: ctx.now(),
    timeZone: ctx.timeZone,
  });
  return {pieces: [{unit: 0, piece: 0, segments}], total: 1, complete: true};
}

async function loadPart(part: Part, issue: TrackerIssue, ctx: StepContext): Promise<Outcome<Content>> {
  switch (part) {
    case 'summary':
      return {ok: true, value: summaryContent(issue, ctx)};
    case 'fields':
      return {ok: true, value: fieldsContent(issue, ctx)};
    case 'description':
      return {ok: true, value: descriptionContent(issue, ctx)};
    case 'comments': {
      const result = await callTracker(
        ctx,
        'listComments',
        () => ctx.tracker.listComments(issue.key, COMMENT_FETCH_LIMIT),
        (value) => ({count: value.comments.length, complete: value.complete}),
      );
      if (!result.ok) return result;
      return {ok: true, value: commentsContent(result.value.comments, result.value.complete, ctx)};
    }
    default:
      return {ok: true, value: {pieces: [], total: 0, complete: true}};
  }
}

/**
 * Where the last page of a part started and ended, as piece indexes. A focus migrated from version 1 carries piece
 * indexes already; they are trusted only if the piece they start at is in the paragraph or comment that version 1
 * recorded as last heard. Otherwise the reading restarts at the start of that paragraph or comment: text may be heard
 * twice, but none is skipped.
 */
function storedIndexes(
  focus: Focus,
  pieces: readonly Piece[],
  ctx: StepContext,
): {startIndex: number; endIndex: number} {
  const legacy = focus.v1Offsets;
  if (legacy === undefined) {
    return {startIndex: indexAtCursor(pieces, focus.pageStart), endIndex: indexAtCursor(pieces, focus.pageEnd)};
  }
  const heardUnit = (focus.progress?.current ?? 1) - 1;
  const trusted =
    legacy.pageStart < legacy.pageEnd &&
    legacy.pageEnd <= pieces.length &&
    pieces[legacy.pageStart]?.unit === heardUnit;
  ctx.log('info', 'voice.state.v1Resumed', {requestId: ctx.requestId, trusted});
  if (trusted) return {startIndex: legacy.pageStart, endIndex: legacy.pageEnd};
  const restart = indexAtCursor(pieces, {unit: heardUnit, piece: 0});
  return {startIndex: restart, endIndex: restart};
}

async function readPart(
  state: ConversationState,
  focus: Focus,
  part: Part,
  mode: PageMode,
  ctx: StepContext,
): Promise<Handled> {
  const fetched = await callTracker(
    ctx,
    'getIssue',
    () => ctx.tracker.getIssue(focus.key),
    () => ({}),
  );
  if (!fetched.ok) {
    if (fetched.kind === 'not-found') {
      // The issue is gone: close it, rather than keep a place in something that no longer exists.
      return {reply: phrasing.openIssueGone(), state: {...state, focus: null, active: null}};
    }
    // A passing failure keeps the place exactly, so the next "more" reads what this one would have.
    return {reply: failureReply(fetched.kind), state};
  }
  const issue = fetched.value;
  const loaded = await loadPart(part, issue, ctx);
  if (!loaded.ok) return {reply: failureReply(loaded.kind), state};
  const {pieces, total, complete} = loaded.value;
  const samePart = focus.part === part;
  const baseFocus: Focus = {...focus, summary: speakableInline(issue.summary), part};

  if (pieces.length === 0) {
    ctx.log('info', 'voice.page', {requestId: ctx.requestId, what: part, mode, start: 0, end: 0, total: 0});
    return {
      reply: phrasing.emptyPart(part),
      state: {...state, focus: {...baseFocus, pageStart: START, pageEnd: START, progress: null}, active: 'issue'},
    };
  }

  const render = (range: PageRange): Reply =>
    phrasing.partPage({
      part,
      units: pieces.slice(range.start, range.end).map((piece) => piece.segments),
      first: range.start === 0,
      last: range.end === pieces.length,
      total,
      complete,
    });
  const perPage = UNITS_PER_PAGE[state.verbosity];
  const fitsPage = (range: PageRange): boolean => fits(render(range), ctx);

  const {startIndex, endIndex} = storedIndexes(focus, pieces, ctx);
  let range: PageRange | null;
  if (mode === 'first') {
    range = pageForward(0, pieces.length, perPage, fitsPage);
  } else if (mode === 'next') {
    range = pageForward(samePart ? endIndex : 0, pieces.length, perPage, fitsPage);
    if (range === null) {
      ctx.log('info', 'voice.page.end', {requestId: ctx.requestId, what: part, pieces: pieces.length});
      return {reply: phrasing.endOfPart(part, complete, total), state: {...state, active: 'issue'}};
    }
  } else {
    range = pageBackward(samePart ? startIndex : 0, perPage, fitsPage);
    if (range === null) return {reply: phrasing.startOfPart(part), state: {...state, active: 'issue'}};
  }
  if (range === null) return {reply: phrasing.emptyPart(part), state};

  ctx.log('info', 'voice.page', {
    requestId: ctx.requestId,
    what: part,
    mode,
    start: range.start,
    end: range.end,
    pieces: pieces.length,
    total,
    complete,
  });
  const {v1Offsets: _migrated, ...rest} = baseFocus;
  const focusAfter: Focus = {
    ...rest,
    pageStart: cursorAtIndex(pieces, range.start),
    pageEnd: cursorAtIndex(pieces, range.end),
    // The last one heard, so "where am I" after a page of several says where the reading actually got to.
    progress: {current: pieces[range.end - 1].unit + 1, total, complete},
  };
  return {reply: render(range), state: {...state, focus: focusAfter, active: 'issue'}};
}

async function handleRead(state: ConversationState, slots: Slots, ctx: StepContext): Promise<Handled> {
  if (state.focus === null) return {reply: phrasing.noIssueOpen(), state};
  const part = PARTS.find((value) => value === slots.part) ?? 'description';
  return readPart(state, state.focus, part, 'first', ctx);
}

async function handleMore(state: ConversationState, ctx: StepContext): Promise<Handled> {
  const workingSet = state.workingSet;
  if (state.active === 'list' && workingSet !== null) {
    if (isExpired(workingSet, ctx)) return {reply: phrasing.listExpired(workingSet.source), state};
    return speakList(state, workingSet, 'next', ctx);
  }
  if (state.active === 'issue' && state.focus !== null) {
    const focus = state.focus;
    return focus.part === null
      ? readPart(state, focus, 'description', 'first', ctx)
      : readPart(state, focus, focus.part, 'next', ctx);
  }
  return {reply: phrasing.nothingToContinue(), state};
}

async function handlePrevious(state: ConversationState, ctx: StepContext): Promise<Handled> {
  const workingSet = state.workingSet;
  if (state.active === 'list' && workingSet !== null) {
    if (isExpired(workingSet, ctx)) return {reply: phrasing.listExpired(workingSet.source), state};
    return speakList(state, workingSet, 'previous', ctx);
  }
  if (state.active === 'issue' && state.focus !== null) {
    const focus = state.focus;
    if (focus.part === null) return {reply: phrasing.startOfPart(null), state};
    return readPart(state, focus, focus.part, 'previous', ctx);
  }
  return {reply: phrasing.nothingToContinue(), state};
}

function heardRange(workingSet: WorkingSet): {from: number; to: number} | null {
  const start: Cursor = workingSet.pageStart;
  const end: Cursor = workingSet.pageEnd;
  const heardSomething = end.unit > start.unit || (end.unit === start.unit && end.piece > start.piece);
  if (!heardSomething) return null;
  const to = Math.min(end.piece > 0 ? end.unit + 1 : end.unit, workingSet.items.length);
  return {from: Math.min(start.unit + 1, to), to};
}

function handleWhere(state: ConversationState, ctx: StepContext): Reply {
  const workingSet = state.workingSet;
  const focus = state.focus;
  const listActive = state.active === 'list';
  return phrasing.where({
    list:
      workingSet === null
        ? null
        : {
            source: workingSet.source,
            total: workingSet.items.length,
            complete: workingSet.complete,
            expired: isExpired(workingSet, ctx),
            heard: listActive ? heardRange(workingSet) : null,
          },
    issue:
      focus === null || listActive
        ? null
        : {
            ordinal: focus.ordinal,
            summary: titleInSentence(focus.summary, ctx),
            part: focus.part,
            progress: focus.progress,
          },
  });
}

function handleVerbosity(state: ConversationState, slots: Slots): Handled {
  const level = VERBOSITIES.find((value) => value === slots.level);
  if (level === undefined) return {reply: phrasing.whichVerbosity(), state};
  // Positions are cursors, so the next "more" continues from the same place at the new size.
  return {reply: phrasing.verbositySet(level), state: {...state, verbosity: level}};
}

function handleRate(state: ConversationState, slots: Slots, ctx: StepContext): Handled {
  const requested = slots.rate === undefined ? null : parseRate(slots.rate);
  if (requested === null) return {reply: phrasing.whichRate(), state};
  const current = state.ratePercent;
  let target: number;
  if (requested === 'faster') {
    target = current + RATE_STEP_PERCENT;
  } else if (requested === 'slower') {
    target = current - RATE_STEP_PERCENT;
  } else if (requested === 'normal') {
    target = DEFAULT_RATE_PERCENT;
  } else {
    target = requested;
  }
  const clamped = Math.min(MAX_RATE_PERCENT, Math.max(MIN_RATE_PERCENT, target));
  ctx.log('info', 'voice.preference.rate', {requestId: ctx.requestId, from: current, requested: target, to: clamped});
  if (clamped !== target && clamped === current) {
    return {reply: phrasing.rateLimit(clamped, target > current), state};
  }
  return {reply: phrasing.rateSet(clamped), state: {...state, ratePercent: clamped}};
}

function handleLaunch(state: ConversationState, ctx: StepContext): {reply: Reply; gated: boolean} {
  if (!mayRead(ctx, 'launch')) return {reply: phrasing.launchGated(), gated: true};
  if (state.active === 'issue' && state.focus !== null) {
    return {
      reply: phrasing.launchResumeIssue(titleInSentence(state.focus.summary, ctx), state.focus.part),
      gated: false,
    };
  }
  if (state.active === 'list' && state.workingSet !== null && !isExpired(state.workingSet, ctx)) {
    return {reply: phrasing.launchResumeList(), gated: false};
  }
  return {reply: phrasing.launchFresh(), gated: false};
}

// ---------------------------------------------------------------------------------------------------------------
// Air quality (YA-36).

/** Words in the place slot that mean "here": the device's location, or else home. */
export const AIR_HERE_WORDS: ReadonlySet<string> = new Set([
  'here',
  'home',
  'at home',
  'my home',
  'my house',
  'this house',
  'outside',
  'around here',
  'near me',
  'near here',
  'me',
  'my area',
  'my location',
  'this area',
  'today',
  'right now',
]);

/** The reply for one lookup's outcome at `where`. */
function airReply(result: AirQualityResult, where: phrasing.AirWhere, said: string | undefined): phrasing.Reply {
  switch (result.kind) {
    case 'reading':
      return phrasing.airReading({where, ...result.reading});
    case 'stale':
      return phrasing.airStale(where, result.ageMinutes);
    case 'noSensors':
      return where.kind === 'sensor'
        ? phrasing.airSensorNoReading(where.said)
        : phrasing.airNoSensors(where, result.radiusKm);
    case 'notFound':
      return phrasing.airNotFound(said ?? '');
    case 'noLocation':
      return said === undefined ? phrasing.airNoLocation() : phrasing.airNotFound(said);
    case 'busy':
      return phrasing.airBusy();
    case 'unavailable':
      return phrasing.airUnavailable();
    default:
      return phrasing.airUnavailable();
  }
}

/** The turn as the air service needs it: its deadline signal and time, and the speaker for the rate limit. */
function airContext(ctx: StepContext, chosen = false): AirLookupContext {
  const context: AirLookupContext = {speaker: ctx.speaker.userId};
  if (ctx.signal !== undefined) context.signal = ctx.signal;
  if (ctx.deadline !== undefined) context.deadline = ctx.deadline;
  if (chosen) context.chosen = true;
  return context;
}

/** The reply for a named lookup, and the state: a choice between places becomes a list to pick from by number. */
function namedReply(state: ConversationState, named: AirQualityNamed, said: string, ctx: StepContext): Handled {
  switch (named.matched) {
    case 'place':
      return {
        reply: airReply(
          named.result,
          {kind: 'place', said, ...(named.name === undefined ? {} : {name: named.name})},
          said,
        ),
        state,
      };
    case 'sensor':
      return {reply: airReply(named.result, {kind: 'sensor', said}, said), state};
    case 'choice': {
      const workingSet: WorkingSet = {
        source: {kind: 'places', said},
        items: named.places.map((name) => ({key: name, summary: name, state: null})),
        complete: true,
        capturedAt: ctx.now(),
        pageStart: START,
        pageEnd: {unit: named.places.length, piece: 0},
      };
      ctx.log('info', 'voice.air.choice', {requestId: ctx.requestId, places: named.places.length});
      return {reply: phrasing.airWhichPlace(named.places), state: {...withNewList(state, workingSet), active: 'list'}};
    }
    default:
      return {reply: airReply(named.result, {kind: 'place', said}, said), state};
  }
}

/**
 * "Air quality", "air quality in Missoula". Without a place, or with "here": the device's location, else home. With
 * one: the service resolves it near the household as a sensor, a place, or a choice between places. Speaks only what
 * the person said, "near you", "at home", or a place name the geocoder gave; never coordinates, ids, sensor names,
 * addresses or the device's postal code.
 */
async function handleAirQuality(state: ConversationState, slots: Slots, ctx: StepContext): Promise<Handled> {
  const port = ctx.airQuality;
  if (port === undefined) {
    ctx.log('info', 'voice.air.notSetUp', {requestId: ctx.requestId});
    return {reply: phrasing.airNotSetUp(), state};
  }
  if (aborted(ctx)) {
    ctx.log('info', 'voice.air.skipped', {requestId: ctx.requestId, reason: 'aborted'});
    return {reply: phrasing.airUnavailable(), state};
  }
  const started = ctx.now();
  const said = slots.place === undefined ? undefined : slots.place.split(' ').slice(0, 12).join(' ');
  const device = ctx.deviceLocation;

  if (said === undefined || AIR_HERE_WORDS.has(said)) {
    const here = await port.lookupHere(device, airContext(ctx));
    ctx.log('info', 'voice.air.here', {
      requestId: ctx.requestId,
      devicePresent: device !== undefined,
      used: here.used,
      outcome: here.result.kind,
      ms: ctx.now() - started,
    });
    if (here.result.kind === 'busy' || here.result.kind === 'unavailable')
      return {reply: airReply(here.result, {kind: 'home'}, undefined), state};
    if (here.used === 'none') return {reply: phrasing.airNoLocation(), state};
    return {reply: airReply(here.result, here.used === 'device' ? {kind: 'device'} : {kind: 'home'}, undefined), state};
  }

  const named = await port.lookupNamed(said, device, airContext(ctx));
  ctx.log('info', 'voice.air.named', {
    requestId: ctx.requestId,
    devicePresent: device !== undefined,
    matched: named.matched,
    outcome: named.matched === 'choice' ? 'choice' : named.result.kind,
    ms: ctx.now() - started,
  });
  return namedReply(state, named, said, ctx);
}

/** The separately-modelled configured indoor sensor (YA-37). */
async function handleAirIndoor(state: ConversationState, ctx: StepContext): Promise<Handled> {
  const port = ctx.airQuality;
  if (port === undefined) return {reply: phrasing.airNotSetUp(), state};
  const result = await port.lookupIndoor(airContext(ctx));
  return {reply: airReply(result, {kind: 'indoor'}, undefined), state};
}

/** A place picked by number from "Did you mean ...?": its air quality, and the choice is done with. */
async function handleAirChoice(
  state: ConversationState,
  workingSet: WorkingSet,
  position: number,
  ctx: StepContext,
): Promise<Handled> {
  const port = ctx.airQuality;
  const source = workingSet.source;
  if (port === undefined || source.kind !== 'places') return {reply: phrasing.airNotSetUp(), state};
  const name = workingSet.items[position - 1].key;
  const named = await port.lookupNamed(name, ctx.deviceLocation, airContext(ctx, true));
  ctx.log('info', 'voice.air.chosen', {
    requestId: ctx.requestId,
    position,
    matched: named.matched,
    outcome: named.matched === 'choice' ? 'choice' : named.result.kind,
  });
  const done = {...state, workingSet: null, active: null};
  const answered = named.matched === 'choice' ? ({matched: 'none', result: {kind: 'notFound'}} as const) : named;
  return namedReply(
    done,
    answered.matched === 'place' ? {...answered, name: answered.name ?? name} : answered,
    source.said,
    ctx,
  );
}

/** The intents that answer, or replay, a pending "Did you mean ...?". */
const CHECK_ANSWERS: ReadonlySet<IntentName> = new Set<IntentName>(['confirm', 'deny', 'open', 'repeat']);

/** The state with any pending "Did you mean ...?" dropped, and the drop logged. */
function withoutCheck(state: ConversationState, cause: string, ctx: StepContext): ConversationState {
  if (pendingPerson(state) === null) return state;
  ctx.log('info', 'voice.person.checkDropped', {requestId: ctx.requestId, cause});
  return {...state, workingSet: null, active: null};
}

/** The "Did you mean ...?" check the listener is answering, if that is what they last heard. */
function pendingPerson(state: ConversationState): WorkingSet | null {
  const workingSet = state.workingSet;
  const waiting =
    state.active === 'list' &&
    workingSet !== null &&
    workingSet.source.kind === 'people' &&
    workingSet.source.confirming === true &&
    workingSet.items.length === 1;
  return waiting ? workingSet : null;
}

/**
 * Takes one turn: input and state in, reply and new state out. Tracker failures become spoken failures with the
 * state unchanged; anything thrown is caught by `converse`.
 */
export async function step(input: VoiceInput, state: ConversationState, ctx: StepContext): Promise<StepResult> {
  if (input.kind === 'sessionEnded') {
    ctx.log('info', 'voice.session.ended', {requestId: ctx.requestId, reason: input.reason});
    return {
      reply: phrasing.silent(),
      state: withoutCheck(state, 'sessionEnded', ctx),
      handled: 'sessionEnded',
      remember: false,
    };
  }
  if (input.kind === 'launch') {
    // A "Did you mean ...?" from an earlier session was not heard in this one, so a later "yes" must not answer it.
    const fresh = withoutCheck(state, 'launch', ctx);
    const launched = handleLaunch(fresh, ctx);
    return {reply: launched.reply, state: fresh, handled: 'launch', remember: !launched.gated};
  }

  const turn = resolveTurn(input, ctx);
  if (turn === null) return {reply: phrasing.didNotCatch(), state, handled: 'unmatched', remember: false};
  const {intent, slots} = turn;
  const spec = SPECS.get(intent);
  // Only an answer keeps the question open: yes, no, a number, or "repeat" to hear it again. Anything else, help
  // included, drops it (recheck R3).
  if (!CHECK_ANSWERS.has(intent)) state = withoutCheck(state, intent, ctx);
  const check = pendingPerson(state);
  if ((intent === 'confirm' || intent === 'deny') && check !== null) {
    // "Did you mean Mary Jones?": the only question stage 1 asks. A yes reads, so it is gated like a list.
    if (!mayRead(ctx, intent)) return {reply: phrasing.gated(), state, handled: intent, remember: false};
    if (isExpired(check, ctx)) {
      return {reply: phrasing.listExpired(check.source), state, handled: intent, remember: false};
    }
    ctx.log('info', 'voice.person.answered', {requestId: ctx.requestId, intent});
    if (intent === 'deny') {
      return {
        reply: phrasing.notThatPerson(),
        state: {...state, workingSet: null, active: null},
        handled: intent,
        remember: true,
      };
    }
    const person = check.items[0];
    const outcome = await listForPerson(state, {login: person.key, name: person.summary}, ctx);
    return {reply: outcome.reply, state: outcome.state, handled: intent, remember: true};
  }
  if (ANSWER_INTENTS.has(intent)) {
    // Nothing at stage 1 ever asks a question, so there is never anything to answer.
    ctx.log('info', 'voice.intent.nothingPending', {requestId: ctx.requestId, intent});
    const reply = intent === 'finishDictation' ? phrasing.nothingToFinish() : phrasing.nothingToConfirm();
    return {reply, state, handled: intent, remember: false};
  }
  if (spec === undefined || spec.stage > 1) {
    ctx.log('info', 'voice.intent.notYet', {requestId: ctx.requestId, intent, stage: spec?.stage});
    return {reply: phrasing.notYet(), state, handled: intent, remember: false};
  }
  // Choosing a place by number reads no tracker content either (YA-36).
  const choosingPlace = intent === 'open' && state.workingSet?.source.kind === 'places';
  if (!UNGATED_INTENTS.has(intent) && !choosingPlace && !mayRead(ctx, intent)) {
    return {reply: phrasing.gated(), state, handled: intent, remember: false};
  }

  let outcome: Handled;
  let remember = true;
  switch (intent) {
    case 'list':
      outcome = await handleList(state, slots, ctx);
      break;
    case 'find':
      outcome = await handleFind(state, slots, ctx);
      break;
    case 'open':
      outcome = await handleOpen(state, slots, ctx);
      break;
    case 'openById':
      outcome = await handleOpenById(state, slots, ctx);
      break;
    case 'read':
      outcome = await handleRead(state, slots, ctx);
      break;
    case 'more':
      outcome = await handleMore(state, ctx);
      break;
    case 'previous':
      outcome = await handlePrevious(state, ctx);
      break;
    case 'repeat': {
      const last = state.lastReply;
      ctx.log('info', 'voice.repeat', {requestId: ctx.requestId, available: last !== null});
      const reply: Reply =
        last === null
          ? phrasing.nothingToRepeat()
          : {segments: last.segments, earcon: last.earcon, listen: true, reprompt: last.reprompt};
      return {reply, state, handled: intent, remember: false};
    }
    case 'where':
      outcome = {reply: handleWhere(state, ctx), state};
      break;
    case 'help':
      outcome = {reply: phrasing.help(), state};
      break;
    case 'setVerbosity':
      outcome = handleVerbosity(state, slots);
      break;
    case 'setRate':
      outcome = handleRate(state, slots, ctx);
      break;
    case 'cancel':
      outcome = {reply: phrasing.cancelled(), state};
      remember = false;
      break;
    case 'stop':
      outcome = {reply: phrasing.goodbye(), state};
      remember = false;
      break;
    case 'airQuality':
    case 'airQualityPlace':
      outcome = await handleAirQuality(state, slots, ctx);
      break;
    case 'airQualityIndoor':
      outcome = await handleAirIndoor(state, ctx);
      break;
    default:
      outcome = {reply: phrasing.notYet(), state};
      remember = false;
      break;
  }
  return {reply: outcome.reply, state: outcome.state, handled: intent, remember};
}

// ---------------------------------------------------------------------------------------------------------------
// The entry point.

/**
 * Keeps a reply under the platform's limit. Paging makes this a no-op at or above `MIN_SUPPORTED_SPEECH_CHARS`;
 * below it the reply is cut and the cut is logged.
 */
function withinBudget(reply: Reply, maxChars: number, ctx: StepContext): Reply {
  const total = speechChars(reply.segments);
  if (total <= maxChars) return reply;
  ctx.log('warn', 'voice.speech.overBudget', {requestId: ctx.requestId, chars: total, maxChars});
  // Whole segments are kept in order while they fit, and the rest are dropped whole: a hint is either said or not,
  // never cut to "Say 'descriptio". Only a first segment that cannot fit alone is cut, and then at a word boundary.
  const kept: SpeechSegment[] = [];
  let used = 0;
  for (const segment of reply.segments) {
    if (used + segment.text.length <= maxChars) {
      kept.push(segment);
      used += segment.text.length;
      continue;
    }
    if (kept.length === 0) kept.push({...segment, text: splitForSpeech(segment.text, maxChars)[0].slice(0, maxChars)});
    break;
  }
  return {...reply, segments: kept};
}

function toResponse(reply: Reply, ratePercent: number, capabilities: AdapterCapabilities): VoiceResponse {
  const response: VoiceResponse = {segments: reply.segments, listen: reply.listen, ratePercent};
  if (reply.earcon !== undefined) response.earcon = reply.earcon;
  if (reply.listen) response.reprompt = reply.reprompt ?? phrasing.REPROMPT_DEFAULT;
  if (capabilities.display && reply.segments.length > 0) {
    response.card = {
      title: reply.cardTitle ?? phrasing.CARD_TITLE,
      text: reply.segments.map((segment) => segment.text).join('\n'),
    };
  }
  return response;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** A valid IANA zone name, or undefined. */
function checkedTimeZone(timeZone: string | undefined, log: VoiceLogger, requestId: string): string | undefined {
  if (timeZone === undefined) return undefined;
  try {
    new Intl.DateTimeFormat('en-GB', {timeZone});
    return timeZone;
  } catch {
    log('warn', 'voice.timeZone.invalid', {requestId});
    return undefined;
  }
}

async function takeTurn(request: VoiceRequest, deps: ConversationDeps, log: VoiceLogger): Promise<VoiceResponse> {
  const started = deps.now();
  const {speaker, capabilities, requestId} = request;
  log('info', 'voice.turn.received', {
    requestId,
    input: request.input.kind,
    locale: request.locale,
    timeZone: request.timeZone !== undefined,
    deviceLocation: request.deviceLocation !== undefined,
    evidence: speaker.evidence,
    maxSpeechChars: capabilities.maxSpeechChars,
    followUp: capabilities.followUp,
    display: capabilities.display,
  });
  log('debug', 'voice.turn.speaker', {requestId, userId: speaker.userId});

  let state: ConversationState;
  let unchangedFrom: string | null = null;
  let loadedVersion: string | null = null;
  let loadFailed = false;
  try {
    const stored = await deps.store.load(speaker.userId);
    const parsed = parseState(stored?.serialized ?? null);
    state = parsed.state;
    loadedVersion = stored?.version ?? null;
    // A turn that ends with exactly this state has nothing to save (a migrated or repaired state does).
    if (parsed.outcome === 'loaded' || parsed.outcome === 'fresh') unchangedFrom = serialiseState(state);
    log(parsed.outcome === 'discarded' ? 'warn' : 'info', 'voice.state.loaded', {
      requestId,
      outcome: parsed.outcome,
      reason: parsed.reason,
      version: parsed.state.version,
      bytes: stored?.serialized.length ?? 0,
      ms: deps.now() - started,
    });
  } catch (error) {
    // Without the stored state this turn runs fresh, and is not saved, so a passing outage cannot wipe a place.
    loadFailed = true;
    state = initialState();
    log('error', 'voice.state.loadFailed', {requestId, error: errorName(error)});
  }

  const ctx: StepContext = {
    tracker: deps.tracker,
    policy: deps.policy,
    now: deps.now,
    log,
    capabilities,
    speaker,
    requestId,
    timeZone: checkedTimeZone(request.timeZone, log, requestId),
    signal: deps.signal,
  };
  if (deps.airQuality !== undefined) ctx.airQuality = deps.airQuality;
  if (request.deviceLocation !== undefined) ctx.deviceLocation = request.deviceLocation;
  if (deps.deadline !== undefined) ctx.deadline = deps.deadline;

  let result: StepResult;
  try {
    result = await step(request.input, state, ctx);
  } catch (error) {
    // The state from before the turn stands: nothing half-done is saved over it.
    log('error', 'voice.turn.failed', {requestId, error: errorName(error)});
    log('debug', 'voice.turn.failedDetail', {requestId, message: error instanceof Error ? error.stack : String(error)});
    result = {reply: phrasing.somethingWentWrong(), state, handled: 'error', remember: false};
  }

  const reply = withinBudget(result.reply, capabilities.maxSpeechChars, ctx);
  const nextState: ConversationState = {
    ...result.state,
    updatedAt: deps.now(),
    lastReply:
      result.remember && reply.segments.length > 0
        ? {segments: reply.segments, earcon: reply.earcon, reprompt: reply.reprompt}
        : result.state.lastReply,
  };

  if (aborted(ctx)) {
    log('info', 'voice.state.notSaved', {requestId, reason: 'aborted'});
  } else if (result.handled === 'error') {
    // A turn that failed changed nothing worth keeping, and must not bump the stored version either.
    log('info', 'voice.state.notSaved', {requestId, reason: 'turn-failed'});
  } else if (unchangedFrom !== null && serialiseState({...nextState, updatedAt: state.updatedAt}) === unchangedFrom) {
    // Nothing changed ("where am I", "repeat", a refusal, a session end): not saving keeps a no-op turn from
    // overwriting a slow turn that did change something.
    log('info', 'voice.state.notSaved', {requestId, reason: 'unchanged'});
  } else if (!loadFailed) {
    const saveStarted = deps.now();
    const serialized = serialiseState(nextState);
    try {
      const saved = await deps.store.save(speaker.userId, serialized, loadedVersion);
      if (saved) {
        log('info', 'voice.state.saved', {
          requestId,
          version: nextState.version,
          bytes: serialized.length,
          ms: deps.now() - saveStarted,
        });
      } else {
        // Another turn saved first. Its state stands; this turn's changes are dropped, not merged or retried.
        log('warn', 'voice.state.conflict', {requestId, ms: deps.now() - saveStarted});
      }
    } catch (error) {
      log('error', 'voice.state.saveFailed', {requestId, error: errorName(error)});
    }
  }

  const response = toResponse(reply, nextState.ratePercent, capabilities);
  log('info', 'voice.turn.completed', {
    requestId,
    handled: result.handled,
    segments: response.segments.length,
    chars: speechChars(response.segments),
    earcon: response.earcon,
    listen: response.listen,
    active: nextState.active,
    stateVersion: nextState.version,
    aborted: aborted(ctx),
    ms: deps.now() - started,
  });
  log('debug', 'voice.speech', {requestId, segments: response.segments.map((segment) => segment.text)});
  return response;
}

/** The entry point. It never rejects: whatever fails inside a turn is logged and answered. */
export const converse: Converse = async (request, deps) => {
  const log: VoiceLogger = (level, event, fields) => {
    try {
      deps.log(level, event, fields);
    } catch {
      // A failing logger must never cost the person their answer.
    }
  };
  try {
    return await takeTurn(request, deps, log);
  } catch (error) {
    log('error', 'voice.turn.failed', {requestId: request.requestId, error: errorName(error), stage: 'outside-step'});
    return toResponse(phrasing.somethingWentWrong(), DEFAULT_RATE_PERCENT, request.capabilities);
  }
};
