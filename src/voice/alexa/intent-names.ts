/**
 * How the core's canonical intents are named in the Alexa interaction model, in both directions. The generator
 * (model.ts) and the request mapper (request.ts) both use this table, so a generated model and the handler that
 * receives its intents cannot disagree.
 */
import type {IntentName} from '../core/types.ts';

/**
 * Every canonical intent. A `Record<IntentName, ...>` makes the compiler refuse this object when the contract gains
 * or loses an intent, which a plain array could not.
 */
const ALL_INTENTS: Readonly<Record<IntentName, true>> = {
  list: true,
  find: true,
  open: true,
  openById: true,
  read: true,
  more: true,
  previous: true,
  repeat: true,
  where: true,
  help: true,
  setVerbosity: true,
  setRate: true,
  cancel: true,
  stop: true,
  airQuality: true,
  airQualityPlace: true,
  airQualityIndoor: true,
  comment: true,
  setState: true,
  confirm: true,
  deny: true,
  create: true,
  dictate: true,
  finishDictation: true,
};

export const INTENT_NAMES = Object.keys(ALL_INTENTS) as readonly IntentName[];

/**
 * Canonical intents that Alexa already understands through a built-in intent. The generator emits the built-in
 * (extended with the catalogue's own samples) rather than a custom intent that would compete with it.
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/standard-built-in-intents.html
 */
export const BUILT_IN_FOR: Readonly<Partial<Record<IntentName, string>>> = {
  help: 'AMAZON.HelpIntent',
  stop: 'AMAZON.StopIntent',
  cancel: 'AMAZON.CancelIntent',
  repeat: 'AMAZON.RepeatIntent',
  more: 'AMAZON.NextIntent',
  previous: 'AMAZON.PreviousIntent',
  confirm: 'AMAZON.YesIntent',
  deny: 'AMAZON.NoIntent',
};

/**
 * Built-ins that reach the skill without a catalogue entry of their own. `AMAZON.FallbackIntent` is absent on
 * purpose: it maps to an unrecognised utterance, not to an intent. `AMAZON.MoreIntent` is not here: it is a
 * screen-navigation intent the model never emits. `AMAZON.NavigateHomeIntent` is emitted for screen devices, but Alexa
 * handles it and ends the session without delivering it to the skill (standard-built-in-intents, Oct 07, 2025); the
 * mapping only makes a delivered one, should Amazon ever send it, stop rather than read as unrecognised.
 */
const EXTRA_BUILT_INS: Readonly<Record<string, IntentName>> = {
  'AMAZON.NavigateHomeIntent': 'stop',
};

export const FALLBACK_INTENT = 'AMAZON.FallbackIntent';

/** Built-ins the generator always emits, whatever the catalogue holds. */
export const ALWAYS_EMITTED_BUILT_INS: readonly string[] = [
  'AMAZON.HelpIntent',
  'AMAZON.StopIntent',
  'AMAZON.CancelIntent',
  'AMAZON.NavigateHomeIntent',
  FALLBACK_INTENT,
];

/** Separates a slot's name from the suffix of its companion slot, so catalogue slot names may not contain it. */
export const COMPANION_SLOT_SEPARATOR = '_';

/** The companion slot that carries "the second one" (AMAZON.Ordinal) beside `{name}` (AMAZON.NUMBER). */
export function ordinalCompanionSlot(slotName: string): string {
  return `${slotName}${COMPANION_SLOT_SEPARATOR}ordinal`;
}

/** `openById` -> `OpenByIdIntent`. Custom intent names allow letters and underscores only. */
export function customIntentName(name: IntentName): string {
  if (name === 'airQuality') return 'AirQualityHereIntent';
  if (name === 'airQualityPlace') return 'AirQualityPlaceIntent';
  if (name === 'airQualityIndoor') return 'AirQualityIndoorIntent';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}Intent`;
}

/** The Alexa intent name the model uses for a canonical intent. */
export function alexaIntentName(name: IntentName): string {
  return BUILT_IN_FOR[name] ?? customIntentName(name);
}

const CANONICAL_BY_ALEXA_NAME: ReadonlyMap<string, IntentName> = new Map<string, IntentName>([
  ...INTENT_NAMES.map((name): [string, IntentName] => [alexaIntentName(name), name]),
  // The deployed YA-36 model can remain live while the YA-37 model is built and then uploaded.
  ['AirQualityIntent', 'airQuality'],
  ...Object.entries(EXTRA_BUILT_INS),
]);

/** The canonical intent for an Alexa intent name, or `undefined` for Fallback and for names this skill never defined. */
export function canonicalIntent(alexaName: string): IntentName | undefined {
  return CANONICAL_BY_ALEXA_NAME.get(alexaName);
}
