/**
 * The voice client's shared contract (YA-10, packet docs/architecture/YA-10.md). Owned by the YA-10 Director:
 * builders import it and never edit it; a change needs a coordination comment on YA-10 first.
 *
 * What crosses this boundary is plain data. No platform SDK type, HTTP object or tracker credential reaches the
 * conversation core, and the core never learns how a speaker was identified, only what evidence there is.
 *
 * Revisions:
 * - 1 (YA-10 review): `VoiceRequest.timeZone`, the meaning of `maxSpeechChars`, versioned state, the turn deadline.
 * - 2 (YA-35): `VoiceIssueQuery.assignee` may be `{login}`; `VoiceTracker.listAssignees`.
 * - 3 (YA-36, Director-authorised, purely additive): the `airQuality` intent (slot `place`); `VoiceRequest.deviceLocation`
 *   (country and postal code only, never a street address); the `AirQualityPort` and its result types; the optional
 *   `ConversationDeps.airQuality` and `ConversationDeps.deadline`. After review: named lookups are one call
 *   (`lookupNamed`, place or sensor or a choice), results may be `busy`, and lookups take an `AirLookupContext`.
 *   Air quality reads no tracker content, so it needs neither a linked account nor `readAccepts` evidence.
 */
import type {TrackerIssue} from '../../tracker.ts';

// ---------------------------------------------------------------------------------------------------------------
// Who is speaking.

/**
 * The evidence an adapter has for who is speaking. Deliberately not a score and not ordered: a recognised voice
 * profile and a caller id are different kinds of weak, and policy says which kinds each action accepts.
 */
export type SpeakerEvidence =
  /** The platform recognised the individual (an Alexa voice profile matched to the enrolled person). */
  | 'person'
  /** The request came from the linked account, but anyone near the device could be speaking. */
  | 'account'
  /** A phone call from an enrolled number. Spoofable; never enough for a write on its own. */
  | 'caller-id'
  /** A factor entered off-air, such as a keypad PIN on a call. Never a spoken PIN. */
  | 'keypad-pin'
  /** Nothing. */
  | 'none';

export interface Speaker {
  /** Stable per-person key for stored state, namespaced by adapter, e.g. `alexa:person:<id>`. Never spoken. */
  userId: string;
  evidence: readonly SpeakerEvidence[];
}

// ---------------------------------------------------------------------------------------------------------------
// What was said.

/**
 * The canonical intents. Adapters with their own language understanding (Alexa) map to these; adapters without it
 * (text, telephony) send an utterance and the core's own grammar maps it. Staged: read-only intents are stage 1,
 * the rest are declared now so adapters can reserve them, and answer "not yet" until their stage lands.
 */
export type IntentName =
  // Stage 1: reading.
  | 'list' // slots: scope ('mine' | 'in-progress' | 'open' | 'recent'), or person (a name, as spoken)
  | 'find' // slots: words (summary words to match)
  | 'open' // slots: ordinal (position in the working set, 1-based)
  | 'openById' // slots: spelled (the id as spelled, letters and digits, phonetic words allowed)
  | 'read' // slots: part ('summary' | 'description' | 'comments' | 'fields')
  | 'more'
  | 'previous'
  | 'repeat'
  | 'where' // "where am I": which list, which issue, which part
  | 'help'
  | 'setVerbosity' // slots: level ('brief' | 'normal' | 'full')
  | 'setRate' // slots: rate ('slower' | 'faster' | 'normal' | a percentage)
  | 'cancel'
  | 'stop'
  | 'airQuality' // here/home: no slots, deliberately separate from SearchQuery place requests (YA-37)
  | 'airQualityPlace' // slots: place (a town, a postal code or a PurpleAir sensor's name, as spoken)
  | 'airQualityIndoor' // configured indoor PurpleAir sensor (YA-37)
  // Stage 3: writes, always confirmed by summary read-back.
  | 'comment' // slots: text (may be absent: the core then asks for it)
  | 'setState' // slots: state
  | 'confirm'
  | 'deny'
  // Stage 4: creation and dictation.
  | 'create' // slots: summary (may be absent)
  | 'dictate' // slots: text
  | 'finishDictation';

/** How a slot's value is captured. Adapters map these to their own slot types. */
export type SlotKind =
  /** A position in the working set: "two", "the second one", "number 2". */
  | 'ordinal'
  /** One of `values`. */
  | 'enum'
  /**
   * Free text. On Alexa this is AMAZON.SearchQuery, which cannot share a sample phrasing with any other slot, so
   * a phrasing with a `phrase` slot holds carrier words and that one slot only.
   */
  | 'phrase'
  /** An identifier spelled out: letters, digits and phonetic-alphabet words. */
  | 'spelled';

export interface SlotSpec {
  name: string;
  kind: SlotKind;
  values?: readonly string[];
}

/**
 * One entry of the core's intent catalogue (`src/voice/core/intents.ts`, owned by YA-13). The text grammar and the
 * Alexa interaction model are both generated from the catalogue, so they cannot drift apart.
 */
export interface IntentSpec {
  name: IntentName;
  /** The stage that implements it; earlier stages answer "not yet" for later intents. */
  stage: 1 | 3 | 4;
  slots: readonly SlotSpec[];
  /** Sample phrasings in the catalogue's locale, slots written `{name}`. */
  samples: readonly string[];
}

export interface UtteranceInput {
  kind: 'utterance';
  text: string;
  /** Recogniser confidence in [0, 1], when the platform reports one. */
  confidence?: number;
}

export interface IntentInput {
  kind: 'intent';
  intent: IntentName;
  /** Slot values as the platform resolved them; absent slots are absent keys, never empty strings. */
  slots: Readonly<Partial<Record<string, string>>>;
}

/** The session opened with no request in it ("Alexa, open my tracker"). */
export interface LaunchInput {
  kind: 'launch';
}

/** The platform closed the session. No speech can be returned; state is saved. */
export interface SessionEndedInput {
  kind: 'sessionEnded';
  reason: 'user' | 'silence' | 'error';
}

export type VoiceInput = UtteranceInput | IntentInput | LaunchInput | SessionEndedInput;

/** What an adapter's platform can do with a response. The core never assumes more than this. */
export interface AdapterCapabilities {
  ssml: boolean;
  earcons: boolean;
  /** A screen exists. Never the only carrier of information. */
  display: boolean;
  /** The platform can listen for a reply without the wake word. */
  followUp: boolean;
  /**
   * The most plain characters of `SpeechSegment.text`, summed over one response, that the adapter can deliver whole.
   * The core pages below it. The adapter sets it with headroom for its own worst-case markup (SSML escaping, breaks,
   * prosody), so the core never has to know how speech is rendered.
   */
  maxSpeechChars: number;
}

export interface VoiceRequest {
  input: VoiceInput;
  speaker: Speaker;
  /** BCP 47, e.g. `en-GB`. */
  locale: string;
  capabilities: AdapterCapabilities;
  /** The platform's request id, for logs. Never spoken. */
  requestId: string;
  /**
   * The listener's IANA time zone (`Europe/London`) when the adapter knows it. Without it the core speaks absolute
   * dates ("12 September") and never relative ones ("today", "yesterday"), which would be wrong for hours a day.
   */
  timeZone?: string;
  /**
   * Where the device is, when the adapter knows it and the listener allowed it (Alexa: the device address permission
   * for country and postal code). Never a street address. Used only for air quality, and never spoken except as the
   * postal code a reading is for.
   */
  deviceLocation?: DeviceLocation;
}

/** A device's coarse location: exactly what the Alexa country-and-postal-code permission gives. */
export interface DeviceLocation {
  /** ISO 3166-1 alpha-2, e.g. `US`. */
  countryCode: string;
  /** As the platform gave it, e.g. `59802` or `SW1A 1AA`. */
  postalCode: string;
}

// ---------------------------------------------------------------------------------------------------------------
// What is said back.

export type Earcon = 'success' | 'failure' | 'endOfList' | 'listening';

/** One unit of speech. Adapters pause between segments; SSML adapters render the pause as a break. */
export interface SpeechSegment {
  /** Plain speakable text: markdown, URLs and ids already made speakable or removed by the core. */
  text: string;
  pauseAfter?: 'short' | 'long';
}

export interface VoiceResponse {
  earcon?: Earcon;
  segments: readonly SpeechSegment[];
  /** Keep the microphone open for a reply. */
  listen: boolean;
  /** Spoken if the user is silent while listening. Required when `listen` is true. */
  reprompt?: readonly SpeechSegment[];
  /** Screen text for adapters with a display. Everything in it is also in `segments`. */
  card?: {title: string; text: string};
  /** Speech rate preference in percent of the platform default; adapters clamp to what they support. */
  ratePercent: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Ports the core depends on. Adapters provide them.

export interface VoiceIssueQuery {
  /** `me` is the tracker login the request is running as; `{login}` is another user's login, never spoken. */
  assignee?: 'me' | {login: string};
  /** A workflow state name, as the tracker knows it. */
  state?: string;
  /** Unresolved issues only. */
  unresolved?: boolean;
  /** Words to match against summaries. */
  text?: string;
  limit: number;
}

export interface VoiceComment {
  authorName: string;
  created: number;
  text: string;
}

/**
 * The narrow tracker surface the voice core needs. Bound to YA-8's TrackerPort once the additions requested on
 * YA-8 land (assignee/text filters, comment listing); until then tests use the in-memory fake.
 * `complete: false` means the tracker capped the result, and the core must not speak it as "all of them".
 */
export interface VoiceTracker {
  listIssues(query: VoiceIssueQuery): Promise<{issues: TrackerIssue[]; complete: boolean}>;
  getIssue(key: string): Promise<TrackerIssue>;
  listComments(key: string, limit: number): Promise<{comments: VoiceComment[]; complete: boolean}>;
  /**
   * The distinct assignees of unresolved issues in the project, at most `limit`: each one's login (for queries, never
   * spoken) and full name (spoken). `complete: false` means there may be others, and the core says so when relevant.
   */
  listAssignees(limit: number): Promise<{people: {login: string; name: string}[]; complete: boolean}>;
}

export interface StoredState {
  serialized: string;
  /** Opaque to the core; the store's own concurrency token. */
  version: string;
}

/**
 * Per-person state, persisted between sessions because a tracker is used in bursts and every assistant closes
 * sessions on silence. Opaque to adapters: the core owns its shape and versions it. Saves are optimistic: two turns
 * for one person can overlap (a slow turn that outlives its platform deadline, or two devices), and a later save
 * must not silently erase the earlier one.
 */
export interface UserStateStore {
  load(userId: string): Promise<StoredState | null>;
  /**
   * Writes only if the stored version still equals `expectedVersion` (`null`: only if nothing is stored yet).
   * Returns `false` on a conflict and writes nothing. The core does not retry: the other turn's state stands, and the
   * conflict is logged at `warn`.
   */
  save(userId: string, serialized: string, expectedVersion: string | null): Promise<boolean>;
}

/** Which evidence each class of action accepts. Any one listed kind suffices. */
export interface VoicePolicy {
  readAccepts: readonly SpeakerEvidence[];
  writeAccepts: readonly SpeakerEvidence[];
  /** After this long a working set is stale, and ordinals into it are refused rather than guessed. */
  workingSetTtlMs: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Air quality (YA-36). A read of public sensor data: no tracker content, no credential of the speaker's.

/** The US EPA AQI categories. */
export type AqiCategory =
  'good' | 'moderate' | 'unhealthyForSensitiveGroups' | 'unhealthy' | 'veryUnhealthy' | 'hazardous';

/** A named sensor network behind a reading. More sources can be added without changing speech. */
export type AirSensorSource = 'PurpleAir';

export interface AirQualityReading {
  /** Explicitly selected sensor accepted despite low channel confidence; must be spoken. */
  lowConfidence?: boolean;
  /** US AQI for PM2.5, from EPA-corrected sensor readings. */
  aqi: number;
  category: AqiCategory;
  /** Sensors the figure comes from, after stale sensors and outliers were set aside. At least 1. */
  sensors: number;
  /** Count by network; source names are safe to say, unlike sensor names or identifiers. */
  sources?: Readonly<Partial<Record<AirSensorSource, number>>>;
  /** PurpleAir's `pm2.5_10minute` is a 10-minute average, not a real-time sample. */
  averaging?: '10-minute average';
  /** Fewer sensors than the service wants for a figure it trusts: the core says so. */
  fewSensors: boolean;
  /** How far around the point sensors were taken from, in whole kilometres. 0 for a named sensor. */
  radiusKm: number;
  /** Exact distance for the one nearest sensor, rounded to metres; absent for an area or named-sensor reading. */
  distanceMetres?: number;
  /** Whole minutes since the newest reading used. */
  ageMinutes: number;
  /**
   * Two groups of sensors disagreed wildly (a lone nearby sensor against those further out, or two sensors against
   * each other): `aqi` and `category` are the higher group's, and the core says that readings disagree.
   */
  disagreement?: {highAqi: number; highSensors: number; lowAqi: number; lowSensors: number};
}

/**
 * One lookup's outcome. Never coordinates, sensor ids, sensor names or an address: nothing in it can be spoken wrongly.
 * - `reading`: a figure.
 * - `stale`: sensors were found, but none has reported recently; `ageMinutes` is the newest one's age.
 * - `noSensors`: no outdoor sensor reported within `radiusKm`.
 * - `notFound`: the place (or, for a sensor search, the sensor name) matched nothing.
 * - `noLocation`: there is no point to search around (no device location that geocodes, and no home setting).
 * - `busy`: this speaker or this skill asked too often lately, or a spending budget is used up (YA-36 review S-P2).
 * - `unavailable`: the sensor network or the geocoder failed, refused, or ran out of time.
 */
export type AirQualityResult =
  | {kind: 'reading'; reading: AirQualityReading}
  | {kind: 'stale'; radiusKm: number; ageMinutes: number}
  | {kind: 'noSensors'; radiusKm: number}
  | {kind: 'notFound'}
  | {kind: 'noLocation'}
  | {kind: 'busy'}
  | {kind: 'unavailable'};

/** Which location "here" used: the device's postal code, the home setting, or neither. */
export interface AirQualityHere {
  used: 'device' | 'home' | 'none';
  result: AirQualityResult;
}

/**
 * What named words turned out to be (YA-36 review C3):
 * - `place`: a town or postal code. `name` is set when the words alone would mislead ("Portland, Oregon", for a place
 *   far from the household, or one chosen from several); it is a place name from the geocoder, never an address.
 * - `sensor`: a PurpleAir sensor near the household whose name matched the words.
 * - `choice`: two or three plausible places of that name, none near the household, as spoken names to choose from.
 * - `none`: nothing matched, or the lookup could not be made; `result` says which.
 */
export type AirQualityNamed =
  | {matched: 'place'; name?: string; result: AirQualityResult}
  | {matched: 'sensor'; result: AirQualityResult}
  | {matched: 'choice'; places: string[]}
  | {matched: 'none'; result: AirQualityResult};

/** What a lookup knows about the turn it serves. */
export interface AirLookupContext {
  /** The turn's deadline signal. */
  signal?: AbortSignal;
  /** Epoch ms by which the answer must be ready; optional steps (widening, a sensor search) are skipped near it. */
  deadline?: number;
  /** The speaker's opaque state key, for the per-speaker rate limit only. Never logged. */
  speaker?: string;
  /** The words are a place already chosen from a `choice`: take the best place match, ask nothing again. */
  chosen?: boolean;
}

/**
 * The air-quality service the core asks (`src/voice/air`). Every method resolves, never rejects: a failure is
 * `unavailable`.
 */
export interface AirQualityPort {
  /** The device's location if it geocodes, otherwise the home setting. */
  lookupHere(device: DeviceLocation | undefined, context?: AirLookupContext): Promise<AirQualityHere>;
  /**
   * A place name, a postal code or a PurpleAir sensor's name, resolved near the device (or else home): a strongly
   * matching nearby sensor first, then a nearby place, then a distant or ambiguous one.
   */
  lookupNamed(words: string, device: DeviceLocation | undefined, context?: AirLookupContext): Promise<AirQualityNamed>;
  /** The one indoor sensor configured for this household, if any. */
  lookupIndoor(context?: AirLookupContext): Promise<AirQualityResult>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured, levelled logs. Tracker content (summaries, descriptions, comments) and speech are logged only at
 * `debug`, because logs leave the house; intents, counts, timings and failure kinds are logged at `info`.
 */
export type VoiceLogger = (level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface ConversationDeps {
  /** Already scoped to the speaker's own tracker account. The core never sees the credential. */
  tracker: VoiceTracker;
  store: UserStateStore;
  policy: VoicePolicy;
  now: () => number;
  log: VoiceLogger;
  /**
   * The turn's deadline. Once aborted, the core makes no further tracker call and does not save, and the adapter has
   * already answered the platform. Tracker bindings must refuse to start a write after it fires. Required before any
   * write intent (stage 3) ships; optional for read-only stages.
   */
  signal?: AbortSignal;
  /** The air-quality service (YA-36). Absent: the core says air quality is not set up. */
  airQuality?: AirQualityPort;
  /** Epoch ms by which the adapter must answer, when it has such a limit (YA-36: bounds air lookups). */
  deadline?: number;
}

/** The core's entry point: load the speaker's state, take one turn, save, answer. Implemented in `converse.ts`. */
export type Converse = (request: VoiceRequest, deps: ConversationDeps) => Promise<VoiceResponse>;
