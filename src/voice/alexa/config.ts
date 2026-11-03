/**
 * Configuration and platform limits for the Alexa adapter. Every number that comes from Amazon cites where it was
 * read; docs/voice/alexa.md repeats them with the dates checked.
 */
import type {SpeakerEvidence, VoicePolicy} from '../core/types.ts';

/**
 * "outputSpeech can't exceed 8000 characters", for the whole SSML string, markup included.
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html
 */
export const OUTPUT_SPEECH_LIMIT = 8000;

/** "All of the text included in a card can't exceed 8000 characters", title included. Same page. */
export const CARD_TEXT_LIMIT = 8000;

/**
 * `AdapterCapabilities.maxSpeechChars`: plain characters of speech, summed over one response, that this adapter can
 * deliver whole (contract revision 1). Half the SSML limit, because escaping can double code-shaped text (`&amp;` is
 * five characters for one; a 5871-character code snippet escapes to 11572) and breaks, prosody and earcon tags add
 * more. Measured by the YA-14 judge: at this budget code-shaped text renders to 7759 SSML characters, JSON to 6760.
 * The renderer's cut (response.ts) is the guard for anything worse, and says aloud that it cut.
 */
export const MAX_SPEECH_CHARS = 4000;

/**
 * `<prosody rate>` bounds, in percent. Alexa: "The minimum value you can provide is 20%" and names no maximum.
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/speech-synthesis-markup-language-ssml-reference.html
 * The maximum is Amazon Polly's documented range, "20-200%", as Alexa documents none.
 * https://docs.aws.amazon.com/polly/latest/dg/prosody-tag.html
 */
export const PROSODY_RATE_MIN = 20;
export const PROSODY_RATE_MAX = 200;

/**
 * "The skill has approximately eight seconds to return a full response", and progressive responses do not extend
 * it. Up to five progressive responses may precede the full response; this adapter sends at most one.
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html
 */
export const ALEXA_RESPONSE_LIMIT_MS = 8000;

/**
 * Hosts that `context.System.apiEndpoint` may name. The apiAccessToken is only ever sent to one of these, even if a
 * malformed envelope names another. Amazon documents North America, Europe and, for the Far East, `api.fe.amazon.com`:
 * https://developer.amazon.com/en-US/docs/alexa/smapi/skill-messaging-api-reference.html
 * `api.fe.amazonalexa.com` follows the other regions' pattern and is allowed too, though no page checked names it.
 */
export const DEFAULT_API_ENDPOINT_HOSTS: readonly string[] = [
  'api.amazonalexa.com',
  'api.eu.amazonalexa.com',
  'api.fe.amazonalexa.com',
  'api.fe.amazon.com',
];

export interface AlexaSkillConfig {
  /** The skill id (`amzn1.ask.skill.…`). Requests for any other application are rejected. */
  skillId: string;
  /**
   * The `personId` of the enrolled household member's voice profile, for this skill and this Amazon account.
   * Only a request carrying exactly this id, with that person's own linked token, is `person` evidence.
   * Undefined until the owner has read it from the enrolment log (runbook step 6).
   */
  enrolledPersonId?: string;
  /**
   * Whether a speaker with no person-level token may use the Amazon account's linked token (as `account` evidence).
   * Off by default (YA-14 J1, Owner decision OD1 option A): an unrecognised voice is refused and the account-level
   * token is never used. On only as a deliberate deploy parameter, together with `account` in READ_ACCEPTS.
   */
  accountTokenFallback: boolean;
  /** Send Simple cards to screen devices and the Alexa app. Off by default (OD2): nothing but speech leaves the room. */
  cards: boolean;
  /** Log the recognised personId at info, for the short enrolment window of runbook step 6. Off by default. */
  enrolmentLog: boolean;
  policy: VoicePolicy;
  /** Send a progressive response if the core has not answered this long after the request. */
  progressiveAfterMs: number;
  /** Answer honestly, without the core, if it has not answered this long after the request. */
  answerByMs: number;
  apiEndpointHosts: readonly string[];
  /**
   * Send the device-address consent card when the permission is missing (YA-36). Off by default: turn it on only after
   * the permission is declared on the console's Build > Permissions page (review P2-11).
   */
  addressConsentCard?: boolean;
}

/** Budget defaults: a progressive response at 5 s, an honest answer at 7 s, one second inside Amazon's ~8 s. */
export const DEFAULT_PROGRESSIVE_AFTER_MS = 5000;
export const DEFAULT_ANSWER_BY_MS = 7000;

/**
 * The Device Address API's country-and-postal-code call (YA-36): `GET {apiEndpoint}/v1/devices/{deviceId}/settings/
 * address/countryAndPostalCode`, bearer `apiAccessToken`, 200 with `countryCode` and `postalCode`, 403 when the customer
 * has not granted the permission, 204 when granted but empty, 429 and 500 otherwise. The scope below is also the
 * manifest permission and the consent card's. Checked 2026-09-14 (the older device-address-api.html page is gone):
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/use-device-address.html and
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/device-settings-api-reference.html
 */
export const COUNTRY_AND_POSTAL_CODE_SCOPE = 'read::alexa:device:all:address:country_and_postal_code';
/** The longest the device-address lookup may take, on an air-quality turn only. Longer, and home is used instead. */
export const DEVICE_ADDRESS_TIMEOUT_MS = 500;

/** The longest the time-zone lookup may take, once per session. Longer, and the turn goes ahead without it. */
export const TIME_ZONE_TIMEOUT_MS = 300;
/** The longest a progressive-response POST may take before it is aborted. */
export const PROGRESSIVE_TIMEOUT_MS = 1000;
/** The longest the full answer waits for an in-flight progressive response to finish. */
export const PROGRESSIVE_SETTLE_MS = 300;
/** A request stamped further in the past than this is treated as clock skew, and the budget counts from arrival. */
export const MAX_TIMESTAMP_AGE_MS = 60_000;

/**
 * The default policy pending Owner decision OD1 (YA-14 judgement): option A, reads and writes on `person` only.
 * Option B (`account` reads) is a deploy-parameter change: ACCOUNT_TOKEN_FALLBACK=true with READ_ACCEPTS=person,account.
 */
export const DEFAULT_POLICY: VoicePolicy = {
  readAccepts: ['person'],
  writeAccepts: ['person'],
  workingSetTtlMs: 12 * 60 * 60 * 1000,
};

/** The only evidence an Alexa request can carry. */
const ALEXA_EVIDENCE: readonly SpeakerEvidence[] = ['person', 'account'];

function evidenceList(
  value: string | undefined,
  name: string,
  fallback: readonly SpeakerEvidence[],
): readonly SpeakerEvidence[] {
  if (value === undefined) return fallback;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) throw new Error(`${name} is set but lists no evidence kind`);
  return items.map((item) => {
    const kind = ALEXA_EVIDENCE.find((candidate) => candidate === item);
    if (kind === undefined) throw new Error(`${name}: "${item}" is not Alexa evidence (person or account)`);
    return kind;
  });
}

function flag(value: string | undefined, name: string, on: string, off: string): boolean {
  if (value === undefined || value === off) return false;
  if (value === on) return true;
  throw new Error(`${name} must be "${on}" or "${off}"`);
}

function milliseconds(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive whole number of ms`);
  return parsed;
}

/**
 * Reads the Lambda's environment (set by deploy/template.yaml). Throws on a missing skill id, a malformed value or a
 * contradictory combination, so a misconfigured function fails at cold start, loudly, instead of answering with a
 * policy nobody chose. Error messages name variables and kinds, never values that could be secrets.
 *
 * SKILL_ID (required), ENROLLED_PERSON_ID, READ_ACCEPTS and WRITE_ACCEPTS (comma-separated evidence kinds),
 * ACCOUNT_TOKEN_FALLBACK (true/false), CARDS (on/off), ENROLMENT_LOG (true/false), PROGRESSIVE_AFTER_MS, ANSWER_BY_MS,
 * ADDRESS_CONSENT_CARD (on/off, default off).
 */
export function configFromEnvironment(env: Readonly<Record<string, string | undefined>>): AlexaSkillConfig {
  const skillId = env.SKILL_ID?.trim();
  if (!skillId) throw new Error('SKILL_ID is required');

  const progressiveAfterMs = milliseconds(
    env.PROGRESSIVE_AFTER_MS,
    'PROGRESSIVE_AFTER_MS',
    DEFAULT_PROGRESSIVE_AFTER_MS,
  );
  const answerByMs = milliseconds(env.ANSWER_BY_MS, 'ANSWER_BY_MS', DEFAULT_ANSWER_BY_MS);
  if (answerByMs >= ALEXA_RESPONSE_LIMIT_MS) throw new Error(`ANSWER_BY_MS must be under ${ALEXA_RESPONSE_LIMIT_MS}`);
  if (progressiveAfterMs >= answerByMs) throw new Error('PROGRESSIVE_AFTER_MS must be under ANSWER_BY_MS');

  const accountTokenFallback = flag(env.ACCOUNT_TOKEN_FALLBACK, 'ACCOUNT_TOKEN_FALLBACK', 'true', 'false');
  const readAccepts = evidenceList(env.READ_ACCEPTS, 'READ_ACCEPTS', DEFAULT_POLICY.readAccepts);
  const writeAccepts = evidenceList(env.WRITE_ACCEPTS, 'WRITE_ACCEPTS', DEFAULT_POLICY.writeAccepts);
  if (writeAccepts.includes('account')) throw new Error('WRITE_ACCEPTS must not include account');
  if (readAccepts.includes('account') && !accountTokenFallback) {
    throw new Error('READ_ACCEPTS includes account, which needs ACCOUNT_TOKEN_FALLBACK=true');
  }

  const config: AlexaSkillConfig = {
    skillId,
    accountTokenFallback,
    cards: flag(env.CARDS, 'CARDS', 'on', 'off'),
    enrolmentLog: flag(env.ENROLMENT_LOG, 'ENROLMENT_LOG', 'true', 'false'),
    policy: {readAccepts, writeAccepts, workingSetTtlMs: DEFAULT_POLICY.workingSetTtlMs},
    progressiveAfterMs,
    answerByMs,
    apiEndpointHosts: DEFAULT_API_ENDPOINT_HOSTS,
    addressConsentCard: flag(env.ADDRESS_CONSENT_CARD, 'ADDRESS_CONSENT_CARD', 'on', 'off'),
  };
  const enrolled = env.ENROLLED_PERSON_ID?.trim();
  if (enrolled) config.enrolledPersonId = enrolled;
  return config;
}

/**
 * The effective configuration as logged once at cold start: the policy and switches, no ids. Field names avoid the
 * words the logger redacts (log.ts), so `accountLinkFallback` rather than the setting's own name.
 */
export function describeConfig(config: AlexaSkillConfig): Record<string, unknown> {
  return {
    readAccepts: config.policy.readAccepts,
    writeAccepts: config.policy.writeAccepts,
    accountLinkFallback: config.accountTokenFallback,
    cards: config.cards,
    enrolmentLog: config.enrolmentLog,
    enrolledPersonConfigured: config.enrolledPersonId !== undefined,
    progressiveAfterMs: config.progressiveAfterMs,
    answerByMs: config.answerByMs,
    addressConsentCard: config.addressConsentCard === true,
  };
}
