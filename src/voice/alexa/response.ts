/**
 * VoiceResponse -> Alexa response JSON (YA-14). Pure. The core never emits SSML: segments become escaped text with
 * breaks between them, the rate preference becomes a clamped `<prosody rate>`, and earcons become sounds from the
 * Alexa Skills Kit Sound Library.
 */
import type {AdapterCapabilities, Earcon, SpeechSegment, VoiceResponse} from '../core/types.ts';
import {CARD_TEXT_LIMIT, OUTPUT_SPEECH_LIMIT, PROSODY_RATE_MAX, PROSODY_RATE_MIN} from './config.ts';
import type {AlexaResponseBody, ResponseEnvelope, SsmlOutputSpeech} from './envelope.ts';
import {MESSAGES} from './messages.ts';

/**
 * Short sounds from the Alexa Skills Kit Sound Library, chosen for being under a second so a fast listener is not
 * held up. Paths and durations were read from the library's published index on 2026-09-12:
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/ask-soundlibrary.html
 * They are a first guess to change after the household hears them. The Progressive Response API cannot play these.
 */
export const EARCON_SOUNDS: Readonly<Record<Earcon, string>> = {
  // "Bell Short Chime (1)", 0.71 s.
  success: 'soundbank://soundlibrary/musical/amzn_sfx_bell_short_chime_01',
  // "Gameshow Negative Response (1)", 0.58 s.
  failure: 'soundbank://soundlibrary/ui/gameshow/amzn_ui_sfx_gameshow_negative_response_01',
  // "Tone (3)", 0.81 s.
  endOfList: 'soundbank://soundlibrary/alarms/beeps_and_bloops/tone_03',
  // "Bell (1)", 0.57 s.
  listening: 'soundbank://soundlibrary/alarms/beeps_and_bloops/bell_01',
};

/** Earcons that close what was said rather than announce it. */
const TRAILING_EARCONS: ReadonlySet<Earcon> = new Set<Earcon>(['endOfList', 'listening']);

/** Pause lengths between segments. Well under Alexa's 10-second break maximum. */
export const PAUSE_MS = {short: 350, long: 900} as const;

// XML 1.0 forbids these control characters outright, and a lone UTF-16 surrogate is not a character at all; escaping
// cannot make either valid, so both are removed.
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escapes the five characters SSML reserves and removes characters XML cannot carry.
 * https://docs.aws.amazon.com/polly/latest/dg/escapees.html
 */
export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A rate preference clamped to what Alexa accepts, as a whole percentage. Non-finite input means the default. */
export function clampRate(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(PROSODY_RATE_MAX, Math.max(PROSODY_RATE_MIN, Math.round(percent)));
}

export interface RenderedSsml {
  ssml: string;
  /** Segments not spoken in full because the SSML would have exceeded the limit: the cut one and all after it. */
  cutSegments: number;
  /** Plain characters of speech that were not spoken. */
  cutChars: number;
}

export interface SsmlOptions {
  ratePercent: number;
  earcon?: Earcon;
  /** Defaults to OUTPUT_SPEECH_LIMIT; tests pass a smaller one. */
  limit?: number;
  /** Spoken in place of whatever did not fit. Defaults to MESSAGES.speechCut. */
  cutNotice?: string;
}

function earconAudio(earcon: Earcon | undefined): string {
  if (earcon === undefined || !Object.hasOwn(EARCON_SOUNDS, earcon)) return '';
  return `<audio src="${EARCON_SOUNDS[earcon]}"/>`;
}

function pauseBreak(pause: SpeechSegment['pauseAfter']): string {
  if (pause === undefined || !Object.hasOwn(PAUSE_MS, pause)) return '';
  return `<break time="${PAUSE_MS[pause]}ms"/>`;
}

/**
 * The longest prefix of `text` whose escaped form fits in `available` characters, ending at a word boundary when
 * there is one (else after a sentence end, else anywhere that does not split a surrogate pair). Escaping the prefix
 * as a whole means an entity such as `&amp;` is never split.
 */
export function fittingPrefix(text: string, available: number): string {
  if (available <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (escapeXml(text.slice(0, middle)).length <= available) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = low;
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  if (end === text.length) return text;

  const hard = text.slice(0, end);
  const space = hard.search(/\s\S*$/);
  if (space > 0) return hard.slice(0, space).trimEnd();
  const sentence = Math.max(hard.lastIndexOf('.'), hard.lastIndexOf('!'), hard.lastIndexOf('?'));
  if (sentence > 0) return hard.slice(0, sentence + 1);
  return hard;
}

/**
 * Renders segments as one `<speak>` document. Everything the core gave is spoken, in order, unless the SSML would
 * pass the limit. Then the segment that does not fit is cut at a word boundary, a fixed notice says so, and nothing
 * after it is spoken. The core sizes its pages under MAX_SPEECH_CHARS, so the cut is a last resort, never paging.
 */
export function renderSsml(segments: readonly SpeechSegment[], options: SsmlOptions): RenderedSsml {
  const limit = options.limit ?? OUTPUT_SPEECH_LIMIT;
  const rate = clampRate(options.ratePercent);
  const audio = earconAudio(options.earcon);
  const trailingEarcon = options.earcon !== undefined && TRAILING_EARCONS.has(options.earcon);
  const leading = trailingEarcon ? '' : audio;
  const trailing = trailingEarcon ? audio : '';
  const open = rate === 100 ? '' : `<prosody rate="${rate}%">`;
  const close = rate === 100 ? '' : '</prosody>';
  const notice = escapeXml(options.cutNotice ?? MESSAGES.speechCut);

  const spoken = segments
    .map((segment) => ({
      text: segment.text.replace(INVALID_XML_CHARS, '').replace(/\s+/g, ' ').trim(),
      pauseAfter: segment.pauseAfter,
    }))
    .filter((segment) => segment.text !== '');

  const overhead = '<speak>'.length + leading.length + open.length + close.length + trailing.length + '</speak>'.length;
  const room = limit - overhead;
  const separatorFor = (body: string) => (body === '' || body.endsWith('/>') ? '' : ' ');
  let body = '';
  let cutSegments = 0;
  let cutChars = 0;

  for (const [index, segment] of spoken.entries()) {
    const isLast = index === spoken.length - 1;
    const separator = separatorFor(body);
    const piece = `${separator}${escapeXml(segment.text)}${isLast ? '' : pauseBreak(segment.pauseAfter)}`;
    // Room for the notice stays reserved until the last segment, so a cut always has space to say it cut.
    const reserve = isLast ? 0 : 1 + notice.length;
    if (body.length + piece.length + reserve <= room) {
      body += piece;
      continue;
    }

    const prefix = fittingPrefix(segment.text, room - body.length - separator.length - 1 - notice.length);
    if (prefix !== '') body += `${separator}${escapeXml(prefix)}`;
    body += `${separatorFor(body)}${notice}`;
    cutSegments = spoken.length - index;
    cutChars =
      segment.text.length - prefix.length + spoken.slice(index + 1).reduce((sum, later) => sum + later.text.length, 0);
    break;
  }

  const inner = body === '' ? '' : `${open}${body}${close}`;
  return {ssml: `<speak>${leading}${inner}${trailing}</speak>`, cutSegments, cutChars};
}

function ssmlSpeech(ssml: string): SsmlOutputSpeech {
  return {type: 'SSML', ssml};
}

/** `text` cut to `length` code units without leaving half of a surrogate pair at the end. */
function cutWhole(text: string, length: number): string {
  const cut = text.slice(0, Math.max(0, length));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export interface RenderedResponse {
  envelope: ResponseEnvelope;
  cutSegments: number;
  cutChars: number;
  /** The core asked to listen but gave no reprompt, which the contract requires; a generic one was used. */
  repromptMissing: boolean;
}

export interface RenderOptions {
  /** Spoken when the core asked to listen without a reprompt. */
  fallbackReprompt: readonly SpeechSegment[];
  /** Whether Simple cards are enabled at all (OD2, default off). */
  cards: boolean;
}

/**
 * Renders the core's response. `listen` keeps the session open (`shouldEndSession: false`) with a reprompt; a card
 * is sent only when cards are enabled and the device has a screen, and always repeats what was spoken.
 */
export function renderResponse(
  voice: VoiceResponse,
  capabilities: AdapterCapabilities,
  options: RenderOptions,
): RenderedResponse {
  const speech = renderSsml(voice.segments, {ratePercent: voice.ratePercent, earcon: voice.earcon});
  const body: AlexaResponseBody = {outputSpeech: ssmlSpeech(speech.ssml), shouldEndSession: !voice.listen};

  let repromptMissing = false;
  let {cutSegments, cutChars} = speech;
  if (voice.listen) {
    const repromptSegments = voice.reprompt && voice.reprompt.length > 0 ? voice.reprompt : options.fallbackReprompt;
    repromptMissing = repromptSegments === options.fallbackReprompt;
    const reprompt = renderSsml(repromptSegments, {ratePercent: voice.ratePercent});
    cutSegments += reprompt.cutSegments;
    cutChars += reprompt.cutChars;
    body.reprompt = {outputSpeech: ssmlSpeech(reprompt.ssml)};
  }
  if (options.cards && capabilities.display && voice.card) {
    // The card repeats the speech, so cutting it to Amazon's limit loses nothing that was not also said.
    const title = cutWhole(voice.card.title, CARD_TEXT_LIMIT);
    body.card = {type: 'Simple', title, content: cutWhole(voice.card.text, CARD_TEXT_LIMIT - title.length)};
  }
  return {envelope: {version: '1.0', response: body}, cutSegments, cutChars, repromptMissing};
}

export interface AdapterSpeechOptions {
  listen: boolean;
  reprompt?: readonly SpeechSegment[];
  linkAccountCard?: boolean;
  earcon?: Earcon;
}

/** A response in the adapter's own words (messages.ts), for the turns where the core could not answer. */
export function adapterResponse(segments: readonly SpeechSegment[], options: AdapterSpeechOptions): ResponseEnvelope {
  const body: AlexaResponseBody = {
    outputSpeech: ssmlSpeech(renderSsml(segments, {ratePercent: 100, earcon: options.earcon}).ssml),
    shouldEndSession: !options.listen,
  };
  if (options.listen && options.reprompt) {
    body.reprompt = {outputSpeech: ssmlSpeech(renderSsml(options.reprompt, {ratePercent: 100}).ssml)};
  }
  if (options.linkAccountCard) body.card = {type: 'LinkAccount'};
  return {version: '1.0', response: body};
}

/** The response to a SessionEndedRequest or an unsupported request: Alexa accepts no speech there. */
export function emptyResponse(): ResponseEnvelope {
  return {version: '1.0', response: {}};
}
