/**
 * Alexa request envelope -> VoiceRequest (YA-14). Pure: no clock, no network, no logging. The handler decides what
 * to do with the result; this module only says what the request is and who might be speaking.
 */
import type {
  AdapterCapabilities,
  IntentName,
  SessionEndedInput,
  SpeakerEvidence,
  VoiceInput,
  VoiceRequest,
} from '../core/types.ts';
import {MAX_SPEECH_CHARS, type AlexaSkillConfig} from './config.ts';
import type {AlexaSlot, AlexaSystem, RequestEnvelope} from './envelope.ts';
import {canonicalIntent, COMPANION_SLOT_SEPARATOR} from './intent-names.ts';
import {idTag} from './log.ts';

/** The envelope is not shaped like an Alexa request. Its message never contains envelope values. */
export class InvalidEnvelopeError extends Error {
  constructor(problem: string) {
    super(`invalid Alexa request envelope: ${problem}`);
    this.name = 'InvalidEnvelopeError';
  }
}

/** A well-formed Alexa request of a type this skill does not handle, such as `System.ExceptionEncountered`. */
export class UnsupportedRequestError extends Error {
  readonly requestType: string;
  /** Every application id the envelope named, so the caller checks the skill before answering at all. */
  readonly applicationIds: readonly string[];

  constructor(requestType: string, applicationIds: readonly string[]) {
    super(`unsupported Alexa request type: ${requestType}`);
    this.name = 'UnsupportedRequestError';
    this.requestType = requestType;
    this.applicationIds = applicationIds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(owner: Record<string, unknown>, key: string, path: string): string {
  const value = owner[key];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidEnvelopeError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requireRecord(owner: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = owner[key];
  if (!isRecord(value)) throw new InvalidEnvelopeError(`${path}.${key} must be an object`);
  return value;
}

const HANDLED_TYPES = new Set(['LaunchRequest', 'IntentRequest', 'SessionEndedRequest']);

/**
 * Checks the fields this adapter reads and returns the envelope typed. Throws InvalidEnvelopeError for a malformed
 * event and UnsupportedRequestError for a request type the skill does not handle.
 */
export function parseRequestEnvelope(event: unknown): RequestEnvelope {
  if (!isRecord(event)) throw new InvalidEnvelopeError('event must be an object');

  const context = requireRecord(event, 'context', 'event');
  const system = requireRecord(context, 'System', 'context');
  const ids = [
    requireString(
      requireRecord(system, 'application', 'context.System'),
      'applicationId',
      'context.System.application',
    ),
  ];
  requireString(requireRecord(system, 'user', 'context.System'), 'userId', 'context.System.user');
  if (event.session !== undefined) {
    const session = requireRecord(event, 'session', 'event');
    ids.push(requireString(requireRecord(session, 'application', 'session'), 'applicationId', 'session.application'));
  }

  const request = requireRecord(event, 'request', 'event');
  const type = requireString(request, 'type', 'request');
  // The application ids are read before this gate, so even an unsupported request is checked against the skill.
  if (!HANDLED_TYPES.has(type)) throw new UnsupportedRequestError(type, ids);
  requireString(request, 'requestId', 'request');
  requireString(request, 'timestamp', 'request');

  if (type === 'IntentRequest') {
    requireString(requireRecord(request, 'intent', 'request'), 'name', 'request.intent');
  }
  // Every field read below this point was checked above or is optional and read defensively.
  return event as unknown as RequestEnvelope;
}

/** Every application id the envelope carries. The handler requires all of them to be the configured skill. */
export function applicationIds(envelope: RequestEnvelope): string[] {
  const ids = [envelope.context.System.application.applicationId];
  if (envelope.session) ids.push(envelope.session.application.applicationId);
  return ids;
}

/**
 * The state record the session's last core-reaching turn used, pinned into `sessionAttributes`: the list the listener
 * most recently heard lives there. `identity` says which tracker identity read it (see `trackerIdentity`).
 */
export interface PinnedSpeaker {
  key: string;
  identity: string;
}

export interface MappedRequest {
  voice: VoiceRequest;
  /**
   * The linked credential for this speaker: the recognised person's own token, or the account's only when
   * `accountTokenFallback` is on. Undefined when neither is usable. Handed to `trackerFor` and nowhere else.
   */
  accessToken?: string;
  /** Which link the token came from, for logs. */
  tokenSource: 'person' | 'account' | 'none';
  /** The tracker identity of the token this turn uses; undefined without a usable token. Never contains a raw id. */
  trackerIdentity?: string;
  /**
   * How `speaker.userId` was chosen: `own` (this turn's own record), `pinned` (the session's record, same tracker
   * identity) or `fresh` (a record for this session only, because the session's record belongs to another identity).
   */
  keyChoice: 'own' | 'pinned' | 'fresh';
  personId?: string;
  personMatched: boolean;
  /** The envelope carried an account-level token, used or not. For the refusal log. */
  accountTokenPresent: boolean;
  /** The Alexa intent name as sent, for logs. */
  alexaIntent?: string;
}

const PINNED_KEY = /^alexa:(person|user):./;
const IDENTITY = /^(person|account):[0-9a-f]{12}$/;

/** The pinned speaker in a continuing session's attributes, if it is well-formed. */
export function pinnedSpeaker(envelope: RequestEnvelope): PinnedSpeaker | undefined {
  const session = envelope.session;
  if (!session || session.new !== false || !isRecord(session.attributes)) return undefined;
  const speaker = session.attributes.speaker;
  if (!isRecord(speaker)) return undefined;
  const {key, identity} = speaker;
  if (typeof key !== 'string' || !PINNED_KEY.test(key)) return undefined;
  if (typeof identity !== 'string' || !IDENTITY.test(identity)) return undefined;
  return {key, identity};
}

/**
 * The tracker identity a token speaks for, without a tracker call: the kind of link plus a hash of the Alexa id that
 * holds the link. A person-level token belongs to the YouTrack account that person linked; an account-level token to
 * the one the Amazon account linked. One link per holder, so the holder names the identity, and it stays stable when
 * Alexa refreshes the token (a hash of the token itself would change every hour). Relinking a holder to a different
 * YouTrack account is not detected here; that needs the bound login from YA-15's binding (YA-14 judgement D2).
 */
export function trackerIdentity(tokenSource: 'person' | 'account', holderId: string): string {
  return `${tokenSource}:${idTag(holderId)}`;
}

/**
 * Maps a parsed envelope to the core's request.
 *
 * Gating (YA-14 J1): the token is the recognised person's own, or the account's only with `accountTokenFallback`.
 * Evidence is `person` only when the voice is the enrolled person's and the token is that person's own; anything else
 * is `account`, and with the fallback off an `account` request has no token and never reaches the core.
 *
 * State key (YA-14 J4, YA-21): a record belongs to one voice and one tracker identity. The own key is
 * `alexa:person:<personId>` or `alexa:user:<userId>`, with `:account` appended when a recognised voice reads through
 * the account link (and `:person` for a person token with no personId), so one voice's lists through two links never
 * mix. In a continuing session, the session's
 * pinned record is the list the listener just heard:
 * - same tracker identity: the turn uses the pinned record (an unrecognised "open 2" after a recognised list read
 *   through the same link);
 * - a different identity: the turn starts fresh, on a record for this session and this voice-and-link only, and never
 *   reads either the pinned record or its own older one, which the listener did not just hear.
 * Pinning never changes evidence.
 */
export function mapRequest(envelope: RequestEnvelope, config: AlexaSkillConfig): MappedRequest {
  const system = envelope.context.System;
  const person = system.person;
  const personId = nonEmpty(person?.personId);
  const personMatched = personId !== undefined && personId === nonEmpty(config.enrolledPersonId);

  const personToken = nonEmpty(person?.accessToken);
  const accountToken = nonEmpty(system.user.accessToken) ?? nonEmpty(envelope.session?.user.accessToken);
  const accessToken = personToken ?? (config.accountTokenFallback ? accountToken : undefined);
  const tokenSource = personToken ? 'person' : accessToken ? 'account' : 'none';
  const evidence: SpeakerEvidence[] = personMatched && tokenSource === 'person' ? ['person'] : ['account'];

  const userIdOfAccount = system.user.userId;
  const identity =
    tokenSource === 'none'
      ? undefined
      : trackerIdentity(tokenSource, tokenSource === 'person' ? (personId ?? '') : userIdOfAccount);
  // One key per voice and link. A voice's usual link carries no suffix (a recognised person's own link, the
  // account's link for an unrecognised voice); the unusual pairing is suffixed, so the two never share a record.
  const voiceKey = personId ? `alexa:person:${personId}` : `alexa:user:${userIdOfAccount}`;
  const unusualLink =
    (personId !== undefined && tokenSource === 'account') || (personId === undefined && tokenSource === 'person');
  const ownKey = unusualLink ? `${voiceKey}:${tokenSource}` : voiceKey;

  const pin = identity === undefined ? undefined : pinnedSpeaker(envelope);
  let keyChoice: MappedRequest['keyChoice'] = 'own';
  let userId = ownKey;
  if (pin !== undefined && pin.identity === identity) {
    keyChoice = 'pinned';
    userId = pin.key;
  } else if (pin !== undefined) {
    keyChoice = 'fresh';
    userId = `${ownKey}:session:${idTag(envelope.session?.sessionId ?? '')}`;
  }

  const request = envelope.request;
  const mapped: MappedRequest = {
    voice: {
      input: mapInput(envelope),
      speaker: {userId, evidence},
      locale: nonEmpty(request.locale) ?? 'en-US',
      capabilities: capabilitiesOf(envelope),
      requestId: request.requestId,
    },
    tokenSource,
    keyChoice,
    personMatched,
    accountTokenPresent: accountToken !== undefined,
  };
  if (accessToken) mapped.accessToken = accessToken;
  if (identity) mapped.trackerIdentity = identity;
  if (personId) mapped.personId = personId;
  if (request.type === 'IntentRequest') mapped.alexaIntent = request.intent.name;
  return mapped;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function mapInput(envelope: RequestEnvelope): VoiceInput {
  const request = envelope.request;
  switch (request.type) {
    case 'LaunchRequest':
      return {kind: 'launch'};
    case 'SessionEndedRequest':
      return {kind: 'sessionEnded', reason: endReason(request.reason)};
    case 'IntentRequest': {
      const intent: IntentName | undefined = canonicalIntent(request.intent.name);
      // AMAZON.FallbackIntent, or an intent this skill never defined: the platform heard speech it could not place.
      // Alexa sends neither the words nor a confidence, so the core receives an empty utterance and nothing else.
      if (!intent) return {kind: 'utterance', text: ''};
      return {kind: 'intent', intent, slots: mapSlots(request.intent.slots)};
    }
    default:
      // Unreachable: parseRequestEnvelope admits only the three types above.
      throw new UnsupportedRequestError((request as {type: string}).type, applicationIds(envelope));
  }
}

function endReason(reason: string): SessionEndedInput['reason'] {
  switch (reason) {
    case 'USER_INITIATED':
      return 'user';
    case 'EXCEEDED_MAX_REPROMPTS':
      return 'silence';
    default:
      return 'error';
  }
}

/**
 * Slot values, preferring an entity-resolution match's canonical id (the catalogue's enum value) over what was
 * heard. Unfilled slots are absent keys, never empty strings. A companion slot (`ordinal_ordinal`, from
 * AMAZON.Ordinal) fills its base slot only when the base slot itself is empty.
 */
export function mapSlots(slots: Record<string, AlexaSlot> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  const companions: Array<[string, string]> = [];

  for (const [key, slot] of Object.entries(slots ?? {})) {
    if (!isRecord(slot)) continue;
    const value = slotValue(slot);
    if (value === undefined) continue;

    const name = typeof slot.name === 'string' && slot.name !== '' ? slot.name : key;
    const separator = name.indexOf(COMPANION_SLOT_SEPARATOR);
    if (separator > 0) {
      companions.push([name.slice(0, separator), value]);
    } else {
      values[name] = value;
    }
  }
  for (const [base, value] of companions) {
    if (values[base] === undefined) values[base] = value;
  }
  return values;
}

function slotValue(slot: AlexaSlot): string | undefined {
  const authorities = slot.resolutions?.resolutionsPerAuthority;
  if (Array.isArray(authorities)) {
    for (const authority of authorities) {
      if (authority?.status?.code !== 'ER_SUCCESS_MATCH') continue;
      const match = authority.values?.[0]?.value;
      const canonical = nonEmpty(match?.id) ?? nonEmpty(match?.name);
      if (canonical) return canonical;
    }
  }
  const raw = typeof slot.value === 'string' ? slot.value.trim() : '';
  // AMAZON.NUMBER reports an unparseable number as "?": that is no value, not a value of "?".
  return raw === '' || raw === '?' ? undefined : raw;
}

const DISPLAY_INTERFACES = ['Display', 'Alexa.Presentation.APL'];

function capabilitiesOf(envelope: RequestEnvelope): AdapterCapabilities {
  return {
    ssml: true,
    earcons: true,
    display: hasDisplay(envelope.context.System, envelope.context.Viewport),
    followUp: true,
    maxSpeechChars: MAX_SPEECH_CHARS,
  };
}

function hasDisplay(system: AlexaSystem, viewport: unknown): boolean {
  if (isRecord(viewport)) return true;
  const interfaces = system.device?.supportedInterfaces;
  if (!isRecord(interfaces)) return false;
  return DISPLAY_INTERFACES.some((name) => name in interfaces);
}
