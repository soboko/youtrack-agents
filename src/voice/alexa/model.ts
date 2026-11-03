/**
 * The core's intent catalogue -> the Alexa interaction model JSON (YA-14). The catalogue is the single source of
 * truth for what can be said; this module only translates it, and refuses to produce a model Amazon would reject or
 * that would silently misbehave. Every rule enforced here cites the page it comes from in docs/voice/alexa.md.
 *
 * Schema: https://developer.amazon.com/en-US/docs/alexa/smapi/interaction-model-schema.html
 */
import type {IntentName, IntentSpec, SlotKind, SlotSpec} from '../core/types.ts';
import {
  ALWAYS_EMITTED_BUILT_INS,
  BUILT_IN_FOR,
  COMPANION_SLOT_SEPARATOR,
  customIntentName,
  ordinalCompanionSlot,
} from './intent-names.ts';

export interface ModelSlot {
  name: string;
  type: string;
}

export interface ModelIntent {
  name: string;
  slots?: ModelSlot[];
  samples: string[];
}

export interface ModelSlotTypeValue {
  id: string;
  name: {value: string};
}

export interface ModelSlotType {
  name: string;
  values: ModelSlotTypeValue[];
}

export interface InteractionModel {
  interactionModel: {
    languageModel: {
      invocationName: string;
      intents: ModelIntent[];
      types: ModelSlotType[];
    };
  };
}

/**
 * Obviously not a real name, and refused by validation, so a model is never generated without a chosen invocation
 * name: the CLI exits non-zero until `--invocation-name` is given.
 */
export const INVOCATION_NAME_PLACEHOLDER = 'replace with invocation name';

export interface ModelOptions {
  invocationName?: string;
}

/** The catalogue breaks one or more rules. Every problem is listed, not just the first. */
export class ModelRuleError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`interaction model refused:\n- ${problems.join('\n- ')}`);
    this.name = 'ModelRuleError';
    this.problems = problems;
  }
}

/**
 * Alexa slot types per slot kind.
 * - ordinal: AMAZON.NUMBER ("two") with an AMAZON.Ordinal companion slot ("the second one").
 * - enum: a generated custom slot type whose value ids are the catalogue's values, so entity resolution hands the
 *   core its own canonical value.
 * - phrase: AMAZON.SearchQuery, free text, under its one-slot-plus-carrier rule. It is also how a person is named
 *   (YA-35, the list intent's `person`): AMAZON.FirstName holds first names only, so neither "Chris Coulter" nor "the
 *   household" would be heard, and a custom type is biased to the values it lists, which would go stale as people
 *   join the project. The core matches the words against the tracker's own list of people. The air-quality `place`
 *   (YA-36) is one too: AMAZON.City would not carry postal codes or PurpleAir sensor names, and AMAZON.US_CITY is
 *   deprecated (slot-type-reference, checked 2026-09-14).
 * - spelled: AMAZON.AlphaNumeric (public beta), which "converts letters, numbers, hyphens, and periods into
 *   alphanumeric sequences"; SearchQuery would return words ("why ay one four"), and a custom type cannot hold
 *   open-ended sequences. See docs/voice/alexa.md for the caveats.
 */
const BUILT_IN_SLOT_TYPE: Readonly<Record<Exclude<SlotKind, 'enum'>, string>> = {
  ordinal: 'AMAZON.NUMBER',
  phrase: 'AMAZON.SearchQuery',
  spelled: 'AMAZON.AlphaNumeric',
};
const ORDINAL_COMPANION_TYPE = 'AMAZON.Ordinal';

const SLOT_REFERENCE = /\{([^{}]*)\}/g;
/** Letters only: the underscore is reserved for companion slots, and Alexa allows nothing else portable. */
const SLOT_NAME = /^[A-Za-z]+$/;
/** Words, spaces and slot references. Digits pass here and are refused by their own, clearer rule. */
const SAMPLE_CHARACTERS = /^[\p{L}\p{M}\p{N}' .{}-]+$/u;
const ENUM_VALUE = /^[a-z]+(?:[ -][a-z]+)*$/;
/** Words, spaces, possessive apostrophes, and single letters with a period (`n. p. r.`). */
const INVOCATION_WORD = /^(?:[a-z]+(?:'[a-z]+)?|[a-z]\.)$/;
/**
 * Words an invocation name must not contain: wake words ("computer" is one on the Italian page and a device wake word
 * everywhere) and "skill"/"app"; launch phrases and connecting words, which Alexa uses to parse "Alexa, ask <name> to".
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/choose-the-invocation-name-for-a-custom-skill.html
 */
const INVOCATION_WAKE_WORDS = new Set(['alexa', 'amazon', 'echo', 'computer', 'skill', 'app']);
const INVOCATION_LAUNCH_WORDS = new Set([
  'run',
  'start',
  'play',
  'resume',
  'use',
  'launch',
  'ask',
  'open',
  'tell',
  'load',
  'begin',
  'enable',
]);
const INVOCATION_CONNECTING_WORDS = new Set([
  'to',
  'from',
  'in',
  'using',
  'with',
  'about',
  'for',
  'that',
  'by',
  'if',
  'and',
  'whether',
]);

/** "Two-word invocation names are not allowed if one of the words is" one of these. */
const TWO_WORD_FORBIDDEN = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'about', 'up', 'by', 'at', 'off', 'with']);

/** Every Amazon invocation-name rule (English) this generator can check offline. */
export function invocationNameProblems(name: string): string[] {
  if (name === INVOCATION_NAME_PLACEHOLDER) {
    return ['the invocation name is the placeholder: pass --invocation-name with the name the household will say'];
  }
  const problems: string[] = [];
  const words = name.split(' ');
  if (name !== name.trim() || words.some((word) => word === '')) {
    problems.push(`invocation name "${name}" must be words separated by single spaces`);
  }
  const nonEmpty = words.filter((word) => word !== '');
  if (nonEmpty.some((word) => !INVOCATION_WORD.test(word))) {
    problems.push(
      `invocation name "${name}" must be lower-case letters, possessive apostrophes and letters with periods`,
    );
  }
  if (nonEmpty.length < 2) problems.push(`invocation name "${name}" must be at least two words`);
  if (nonEmpty.length === 2 && nonEmpty.some((word) => TWO_WORD_FORBIDDEN.has(word))) {
    problems.push(`two-word invocation name "${name}" must not include an article or a short preposition`);
  }
  for (const word of nonEmpty) {
    const bare = word.replace(/'[a-z]+$/, '');
    if (INVOCATION_WAKE_WORDS.has(bare)) problems.push(`invocation name must not contain "${bare}"`);
    if (INVOCATION_LAUNCH_WORDS.has(bare)) problems.push(`invocation name must not contain the launch word "${bare}"`);
    if (INVOCATION_CONNECTING_WORDS.has(bare)) {
      problems.push(`invocation name must not contain the connecting word "${bare}"`);
    }
  }
  return problems;
}

function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function normalizeSample(sample: string): string {
  return alexaSample(sample).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A possessive slot reference, `{person}'s`. */
const POSSESSIVE_SLOT = /\{([^{}]*)\}'s(?= |$)/g;

/**
 * A catalogue sample as the model writes it. Amazon's possessive rule: "Use `tell me a {Drink} ingredients`", not
 * "`tell me a {Drink}'s ingredients`" (create-intents-utterances-and-slots, Nov 28, 2023), so `{person}'s issues`
 * becomes `{person} issues` and the value arrives with its "'s" ("chris's").
 */
export function alexaSample(sample: string): string {
  return sample.replace(POSSESSIVE_SLOT, '{$1}');
}

/** The words spoken for an enum value: `in-progress` is said "in progress". */
export function spokenEnumValue(value: string): string {
  return value.replace(/-/g, ' ');
}

/** Every rule the catalogue breaks, as readable sentences. Empty means the model can be generated. */
export function validateCatalogue(catalogue: readonly IntentSpec[], options: ModelOptions = {}): string[] {
  const problems: string[] = [];
  problems.push(...invocationNameProblems(options.invocationName ?? INVOCATION_NAME_PLACEHOLDER));

  const seenIntents = new Set<IntentName>();
  const sampleOwner = new Map<string, IntentName>();

  for (const spec of catalogue) {
    const where = `intent ${spec.name}`;
    if (seenIntents.has(spec.name)) problems.push(`${where} appears more than once`);
    seenIntents.add(spec.name);

    const isBuiltIn = BUILT_IN_FOR[spec.name] !== undefined;
    if (isBuiltIn && spec.slots.length > 0) {
      problems.push(`${where} maps to ${BUILT_IN_FOR[spec.name]}, which cannot take slots`);
    }
    if (!isBuiltIn && spec.samples.length === 0) problems.push(`${where} has no samples`);

    const slots = new Map<string, SlotSpec>();
    for (const slot of spec.slots) {
      problems.push(...slotProblems(where, slot, slots));
      slots.set(slot.name, slot);
    }
    const phraseSlots = spec.slots.filter((slot) => slot.kind === 'phrase');
    if (phraseSlots.length > 1) {
      problems.push(`${where} has ${phraseSlots.length} phrase slots; AMAZON.SearchQuery allows one per intent`);
    }

    const referenced = new Set<string>();
    for (const sample of spec.samples) {
      const references = [...sample.matchAll(SLOT_REFERENCE)].map((match) => match[1] ?? '');
      references.forEach((name) => referenced.add(name));
      problems.push(...sampleProblems(where, sample, references, slots));

      const key = normalizeSample(sample);
      const owner = sampleOwner.get(key);
      if (owner !== undefined) {
        problems.push(
          owner === spec.name
            ? `${where} repeats the sample "${sample}"`
            : `sample "${sample}" is in both ${owner} and ${spec.name}; samples must be unique`,
        );
      } else {
        sampleOwner.set(key, spec.name);
      }
    }
    for (const name of slots.keys()) {
      if (!referenced.has(name)) problems.push(`${where} declares slot {${name}} but no sample uses it`);
    }
  }
  return problems;
}

function slotProblems(where: string, slot: SlotSpec, earlier: ReadonlyMap<string, SlotSpec>): string[] {
  const problems: string[] = [];
  const label = `${where} slot {${slot.name}}`;
  if (!SLOT_NAME.test(slot.name)) {
    problems.push(`${label}: slot names are letters only ("${COMPANION_SLOT_SEPARATOR}" is reserved)`);
  }
  if (earlier.has(slot.name)) problems.push(`${label} is declared twice`);
  if (slot.kind === 'enum') {
    if (!slot.values || slot.values.length === 0) problems.push(`${label} is an enum with no values`);
    for (const value of slot.values ?? []) {
      if (!ENUM_VALUE.test(value)) {
        problems.push(`${label} value "${value}" must be lower-case words joined by spaces or hyphens`);
      }
    }
    if (new Set(slot.values ?? []).size !== (slot.values ?? []).length) problems.push(`${label} repeats a value`);
    const spokenBy = new Map<string, string>();
    for (const value of new Set(slot.values ?? [])) {
      const spoken = spokenEnumValue(value);
      const earlier = spokenBy.get(spoken);
      if (earlier !== undefined) {
        problems.push(`${label} values "${earlier}" and "${value}" are both said "${spoken}"`);
      } else {
        spokenBy.set(spoken, value);
      }
    }
  } else if (slot.values !== undefined) {
    problems.push(`${label} has values but is a ${slot.kind} slot`);
  }
  return problems;
}

function sampleProblems(
  where: string,
  sample: string,
  references: readonly string[],
  slots: ReadonlyMap<string, SlotSpec>,
): string[] {
  const problems: string[] = [];
  const label = `${where} sample "${sample}"`;
  if (sample.trim() === '') return [`${where} has an empty sample`];
  if (/\d/.test(sample)) problems.push(`${label}: numbers must be written as words`);
  if (!SAMPLE_CHARACTERS.test(sample)) {
    problems.push(`${label}: only letters, spaces, apostrophes, periods and hyphens are allowed`);
  }
  if (new Set(references).size !== references.length) problems.push(`${label} uses the same slot twice`);

  for (const name of references) {
    if (!slots.has(name)) problems.push(`${label} uses undeclared slot {${name}}`);
  }
  for (const match of sample.matchAll(POSSESSIVE_SLOT)) {
    const slot = slots.get(match[1] ?? '');
    if (slot !== undefined && slot.kind !== 'phrase') {
      problems.push(`${label}: only a phrase slot can be possessive, not {${slot.name}} (${slot.kind})`);
    }
  }
  const phrase = references.find((name) => slots.get(name)?.kind === 'phrase');
  if (phrase !== undefined) {
    if (references.length > 1) {
      problems.push(`${label}: phrase slot {${phrase}} (AMAZON.SearchQuery) cannot share a sample with another slot`);
    }
    if (sample.replace(SLOT_REFERENCE, ' ').trim() === '') {
      problems.push(`${label}: phrase slot {${phrase}} (AMAZON.SearchQuery) needs carrier words around it`);
    }
  }
  return problems;
}

/** Builds the model, or throws ModelRuleError listing every broken rule. */
export function buildInteractionModel(catalogue: readonly IntentSpec[], options: ModelOptions = {}): InteractionModel {
  const problems = validateCatalogue(catalogue, options);
  if (problems.length > 0) throw new ModelRuleError(problems);

  const types = new SlotTypeNames();
  const intents: ModelIntent[] = catalogue.map((spec) => {
    const builtIn = BUILT_IN_FOR[spec.name];
    if (builtIn) return {name: builtIn, samples: dedupe(spec.samples.map(alexaSample))};

    const ordinalSlots = spec.slots.filter((slot) => slot.kind === 'ordinal').map((slot) => slot.name);
    const slots: ModelSlot[] = [];
    for (const slot of spec.slots) {
      if (slot.kind === 'enum') {
        slots.push({name: slot.name, type: types.nameFor(spec.name, slot)});
      } else {
        slots.push({name: slot.name, type: BUILT_IN_SLOT_TYPE[slot.kind]});
      }
      if (slot.kind === 'ordinal') slots.push({name: ordinalCompanionSlot(slot.name), type: ORDINAL_COMPANION_TYPE});
    }
    const samples = dedupe(spec.samples.map(alexaSample).flatMap((sample) => expandOrdinals(sample, ordinalSlots)));
    return slots.length > 0
      ? {name: customIntentName(spec.name), slots, samples}
      : {name: customIntentName(spec.name), samples};
  });

  const emitted = new Set(intents.map((intent) => intent.name));
  for (const name of ALWAYS_EMITTED_BUILT_INS) {
    if (!emitted.has(name)) intents.push({name, samples: []});
  }

  return {
    interactionModel: {
      languageModel: {
        invocationName: options.invocationName ?? INVOCATION_NAME_PLACEHOLDER,
        intents,
        types: types.all(),
      },
    },
  };
}

/** Each sample once as written (AMAZON.NUMBER) and once per ordinal slot swapped for its AMAZON.Ordinal companion. */
function expandOrdinals(sample: string, ordinalSlots: readonly string[]): string[] {
  let variants = [sample];
  for (const name of ordinalSlots) {
    const reference = `{${name}}`;
    if (!sample.includes(reference)) continue;
    variants = variants.flatMap((variant) => [variant, variant.replace(reference, `{${ordinalCompanionSlot(name)}}`)]);
  }
  return variants;
}

function dedupe(samples: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sample of samples) {
    const key = normalizeSample(sample);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * Custom slot type names: `ScopeValues` for a slot named `scope`. Two slots with the same name and the same values
 * share one type; the same name with different values gets the intent prefixed, `ListScopeValues`.
 */
class SlotTypeNames {
  private readonly types = new Map<string, ModelSlotType>();
  private readonly signatures = new Map<string, string>();

  nameFor(intent: IntentName, slot: SlotSpec): string {
    const values = slot.values ?? [];
    const signature = values.join('\n');
    for (const candidate of [`${upperFirst(slot.name)}Values`, `${upperFirst(intent)}${upperFirst(slot.name)}Values`]) {
      const existing = this.signatures.get(candidate);
      if (existing === signature) return candidate;
      if (existing === undefined) {
        this.signatures.set(candidate, signature);
        this.types.set(candidate, {
          name: candidate,
          values: values.map((value) => ({id: value, name: {value: spokenEnumValue(value)}})),
        });
        return candidate;
      }
    }
    // Unreachable: intent names are unique in a validated catalogue, so the prefixed name cannot clash.
    throw new Error(`no free slot type name for ${intent}.${slot.name}`);
  }

  all(): ModelSlotType[] {
    return [...this.types.values()];
  }
}
