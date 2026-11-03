/**
 * The utterance grammar for adapters without their own language understanding (text, telephony). It is compiled
 * from the intent catalogue, so a phrasing added to `intents.ts` is understood here and on Alexa alike.
 *
 * Matching is whole-utterance and deterministic: each sample becomes an anchored pattern, slot values must parse
 * (an ordinal must be a position, a spelled id must be letters then digits), and the most specific match wins. An
 * utterance nothing matches is reported as unmatched, never guessed.
 */
import {INTENT_CATALOGUE, SLOT_SYNONYMS} from './intents.ts';
import {
  FILLER_KEY_TOKENS,
  isLetterToken,
  isNumberToken,
  parseOrdinal,
  parseRate,
  parseSpelledId,
  resolveEnum,
} from './slots.ts';
import type {IntentName, IntentSpec, SlotSpec} from './types.ts';

/**
 * Words dropped wherever they occur. The hesitation sounds among them (`FILLER_KEY_TOKENS`) are kept in one place
 * only: directly before a number, and not after a spelled letter or "number". There they may be a project key
 * ("open issue MM-12", "mm twelve"). "please" is never a key, and a hesitation while spelling ("yankee alpha um one
 * three", "issue um yankee alpha") is always just a pause.
 */
export const FILLERS_ANYWHERE: ReadonlySet<string> = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'er',
  'erm',
  'hmm',
  'hm',
  'mm',
  'ah',
  'please',
]);

/** A hesitation after these words is a pause, never the start of a project key: "number um two". */
const KEY_BREAKERS = new Set(['number', 'no', 'item', 'position', 'the']);

/**
 * Politeness dropped from the middle of an utterance too, but only if the utterance does not match as said: "what
 * can you do" is a help phrasing, while "open can you two" is not anything.
 */
const POLITENESS_ANYWHERE: readonly string[] = ['can you please', 'could you please', 'can you', 'could you', 'now'];

/** Politeness and hesitation dropped from the start of an utterance, longest first, repeatedly. */
const LEADING_FILLERS: readonly string[] = [
  'i would like you to',
  "i'd like you to",
  'i would like to',
  "i'd like to",
  'could you please',
  'can you please',
  'go ahead and',
  'i want you to',
  'i want to',
  'can you',
  'could you',
  'would you',
  'will you',
  "let's",
  'okay',
  'ok',
  'so',
  'hey',
  'well',
  'and',
  'then',
  'just',
  'now',
  'right',
];

/** Dropped from the end of an utterance, longest first, repeatedly. */
const TRAILING_FILLERS: readonly string[] = ['thank you', 'thanks', 'for me', 'right now', 'now', 'okay', 'ok'];

/** The trailing fillers that are only politeness, stripped even from the end of a search ("find login thanks"). */
const TRAILING_POLITENESS: readonly string[] = ['thank you', 'thanks'];

/** Written and spoken forms that mean the same, so samples and utterances meet in one spelling. */
const CONTRACTIONS: Readonly<Record<string, string>> = {
  'what is': "what's",
  whats: "what's",
  'that is': "that's",
  thats: "that's",
  'i am': "i'm",
  im: "i'm",
  'let us': "let's",
  lets: "let's",
  'do not': "don't",
  dont: "don't",
  'x ray': 'xray',
};

/** Articles are optional before literal words and enum values: "read the description" and "read description". */
const ARTICLES = new Set(['the', 'a', 'an']);

/** Specificity scores: literal words dominate, then how constrained each slot kind is. */
const LITERAL_SCORE = 10;
const SLOT_SCORE: Readonly<Record<SlotSpec['kind'], number>> = {enum: 4, ordinal: 3, spelled: 2, phrase: 0};

function applyContractions(text: string): string {
  let result = ` ${text} `;
  for (const [long, short] of Object.entries(CONTRACTIONS)) {
    result = result.split(` ${long} `).join(` ${short} `);
  }
  return result.trim();
}

/**
 * Lower-cases, strips punctuation (keeping apostrophes, and reading `%` as "percent"), and folds contractions.
 * Hyphens become spaces, so "YA-13" is "ya 13" and "in-progress" is "in progress".
 */
export function normaliseText(text: string): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/%/g, ' percent ')
    // A minus sign before a number is kept as a word, so "-1" is never read as position 1.
    .replace(/(^|\s)-(?=\d)/g, '$1minus ')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/(^| )'+|'+( |$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return applyContractions(cleaned);
}

function stripPhrase(words: string[], phrases: readonly string[], atStart: boolean): boolean {
  for (const phrase of phrases) {
    const parts = phrase.split(' ');
    if (parts.length >= words.length) continue;
    const slice = atStart ? words.slice(0, parts.length) : words.slice(words.length - parts.length);
    if (slice.join(' ') === phrase) {
      words.splice(atStart ? 0 : words.length - parts.length, parts.length);
      return true;
    }
  }
  return false;
}

/**
 * Normalises an utterance and removes fillers ("um", "please", "can you", "thanks"). A filler is only removed when
 * something else remains, so "okay" on its own stays "okay" (and is then unmatched).
 */
export function normaliseUtterance(text: string, options: {forPhrase?: boolean} = {}): string {
  const all = normaliseText(text)
    .split(' ')
    .filter((word) => word !== '');
  const words = all.filter((word, index) => {
    if (!FILLERS_ANYWHERE.has(word)) return true;
    if (!FILLER_KEY_TOKENS.has(word)) return false;
    const next = all[index + 1];
    const previous = all[index - 1];
    const beforeNumber = next !== undefined && isNumberToken(next);
    const whileSpelling = previous !== undefined && (isLetterToken(previous) || KEY_BREAKERS.has(previous));
    return beforeNumber && !whileSpelling;
  });
  while (stripPhrase(words, LEADING_FILLERS, true)) {
    // Keep stripping.
  }
  // At the end of a search the last words may be the subject ("cards for me", "now playing"), so only thanks go.
  while (stripPhrase(words, options.forPhrase ? TRAILING_POLITENESS : TRAILING_FILLERS, false)) {
    // Keep stripping.
  }
  return words.join(' ');
}

interface CompiledSample {
  intent: IntentSpec;
  /** Spelled ids in this sample have no carrier word, so they are parsed strictly. */
  strictSpelled: boolean;
  sample: string;
  pattern: RegExp;
  /** Slot names in capture-group order. */
  slotOrder: SlotSpec[];
  score: number;
}

/** A grammar compiled from a catalogue. */
export interface Grammar {
  samples: readonly CompiledSample[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function enumAlternatives(slot: SlotSpec): string[] {
  const forms = new Set<string>();
  const synonyms = SLOT_SYNONYMS[slot.name] ?? {};
  // Exactly the listed synonyms. A canonical value that is not also listed is left to adapters, so the rate's
  // canonical "normal" never competes with the verbosity's spoken "normal".
  for (const value of slot.values ?? []) {
    for (const synonym of synonyms[value] ?? []) forms.add(normaliseText(synonym));
  }
  return [...forms].filter((form) => form !== '').sort((a, b) => b.length - a.length);
}

function compileSample(intent: IntentSpec, sample: string, strictSpelled = false): CompiledSample {
  const slotsByName = new Map(intent.slots.map((slot) => [slot.name, slot]));
  const pieces: string[] = [];
  const slotOrder: SlotSpec[] = [];
  let score = 0;
  const optionalArticle = '(?:(?:the|a|an) )?';

  // Fold multi-word contractions before tokenising, just as incoming utterances are folded.
  // Keep slot braces intact; normaliseText on the whole sample would erase them.
  for (const token of applyContractions(sample).split(' ')) {
    const slotMatch = /^\{(\w+)\}('s)?$/.exec(token);
    if (slotMatch) {
      const slot = slotsByName.get(slotMatch[1]);
      if (!slot) throw new Error(`Intent ${intent.name}: sample "${sample}" names unknown slot ${slotMatch[1]}`);
      if (slotMatch[2] !== undefined) {
        // A possessive phrase ("{person}'s issues"): the words said before "'s", which is required, so "close all my
        // issues" is not somebody's issues.
        if (slot.kind !== 'phrase') throw new Error(`Intent ${intent.name}: only a phrase slot can be possessive`);
        slotOrder.push(slot);
        pieces.push("(.+?)'s ");
        continue;
      }
      slotOrder.push(slot);
      score += SLOT_SCORE[slot.kind];
      if (slot.kind === 'enum') {
        const alternatives = enumAlternatives(slot).map(escapeRegExp);
        // A spoken rate may also be a percentage, but only with the word "percent": a bare "fifty" is a position.
        if (slot.name === 'rate') alternatives.push('.+? percent');
        pieces.push(`${optionalArticle}(${alternatives.join('|')}) `);
      } else {
        // Ordinals and spelled ids handle their own leading words ("the second one", "a b one"), and a phrase keeps
        // whatever was said.
        pieces.push('(.+?) ');
      }
      continue;
    }
    const word = normaliseText(token);
    if (word === '') continue;
    if (ARTICLES.has(word)) {
      pieces.push(`(?:${word} )?`);
    } else {
      pieces.push(`${optionalArticle}${escapeRegExp(word)} `);
      score += LITERAL_SCORE;
    }
  }
  return {intent, sample, strictSpelled, pattern: new RegExp(`^${pieces.join('')}$`, 'u'), slotOrder, score};
}

/**
 * A grammar-only slot on `openById`: the list position to open instead when the spelled id began with a filler word
 * and no such issue exists. Never produced for an id said with a carrier word ("open issue um two").
 */
export const FALLBACK_ORDINAL_SLOT = 'fallbackOrdinal';

/**
 * Phrasings the text grammar accepts that are deliberately not in the catalogue, so the Alexa model never sees them:
 * an id typed or said with no carrier word ("YA-13", "open ya13"). On Alexa they would collide with ordinals. They
 * parse ids strictly, and an ordinal reading of the same words always wins.
 */
export const TEXT_ONLY_SAMPLES: Readonly<Partial<Record<IntentName, readonly string[]>>> = {
  openById: ['{spelled}', 'open {spelled}', 'go to {spelled}'],
  // "AQI" typed as one word. Alexa hears it as the letters, which the catalogue writes "a. q. i.".
  airQuality: ['aqi', "what's the aqi"],
  airQualityPlace: ['aqi in {place}'],
};

/** Compiles a catalogue. Throws if a sample names a slot its intent does not declare. */
export function compileGrammar(catalogue: readonly IntentSpec[] = INTENT_CATALOGUE): Grammar {
  const samples: CompiledSample[] = [];
  for (const intent of catalogue) {
    for (const sample of intent.samples) samples.push(compileSample(intent, sample));
    for (const sample of TEXT_ONLY_SAMPLES[intent.name] ?? []) samples.push(compileSample(intent, sample, true));
  }
  return {samples};
}

/**
 * Parses one slot value to its canonical string, or null if it cannot be read without guessing. Used for both
 * grammar captures and slot values an adapter resolved itself.
 */
export function canonicalSlotValue(slot: SlotSpec, raw: string, strictSpelled = false): string | null {
  switch (slot.kind) {
    case 'ordinal': {
      const ordinal = parseOrdinal(raw);
      return ordinal === null ? null : String(ordinal);
    }
    case 'spelled':
      return parseSpelledId(raw, {strict: strictSpelled});
    case 'enum': {
      if (slot.name === 'rate') {
        const rate = parseRate(raw);
        return rate === null ? null : String(rate);
      }
      return resolveEnum(slot.name, slot.values ?? [], raw);
    }
    case 'phrase': {
      // Only normalised, not filler-stripped: the utterance was stripped already, and inside a phrase "well pump" and
      // "right sidebar" are the words that were meant.
      const words = normaliseText(raw);
      return words === '' ? null : words;
    }
    default:
      return null;
  }
}

/** A successful parse: the intent and its canonical slot values. */
export interface GrammarMatch {
  matched: true;
  intent: IntentName;
  slots: Partial<Record<string, string>>;
  sample: string;
  score: number;
}

/** No sample matched. `normalised` is what was compared, for debug logs only. */
export interface GrammarMiss {
  matched: false;
  normalised: string;
}

const DEFAULT_GRAMMAR = compileGrammar();

/**
 * Maps an utterance to an intent and slots, or reports a miss. Ties go to the earlier catalogue entry.
 *
 * One kind of near miss is kept: a sample with carrier words and a spelled-id slot that did not spell an id ("open
 * issue banana"). It matches with the slot absent, so the core can say how to spell an id, instead of "I didn't catch
 * that". Nothing is guessed: the id is still missing.
 */
function matchUtterance(text: string, grammar: Grammar): GrammarMatch | GrammarMiss {
  const normalised = normaliseUtterance(text);
  if (normalised === '') return {matched: false, normalised};
  const subject = `${normalised} `;
  const phraseSubject = `${normaliseUtterance(text, {forPhrase: true})} `;
  let best: GrammarMatch | null = null;
  let nearMiss: GrammarMatch | null = null;

  for (const compiled of grammar.samples) {
    const hasPhrase = compiled.slotOrder.some((slot) => slot.kind === 'phrase');
    const match = compiled.pattern.exec(hasPhrase ? phraseSubject : subject);
    if (!match) continue;
    const slots: Partial<Record<string, string>> = {};
    const invalid: SlotSpec[] = [];
    compiled.slotOrder.forEach((slot, index) => {
      const value = canonicalSlotValue(slot, match[index + 1].trim(), compiled.strictSpelled);
      if (value === null) {
        invalid.push(slot);
      } else {
        slots[slot.name] = value;
      }
    });
    // "open um two": with no carrier word, a hesitation before a number may be an id or a pause. The id is tried
    // first; the position after the filler is kept as the fallback if that id does not exist (see converse.ts).
    const spelledIndex = compiled.slotOrder.findIndex((slot) => slot.kind === 'spelled');
    if (compiled.strictSpelled && spelledIndex !== -1 && slots.spelled !== undefined) {
      const words = match[spelledIndex + 1].trim().split(' ');
      const fallback = FILLER_KEY_TOKENS.has(words[0]) ? parseOrdinal(words.slice(1).join(' ')) : null;
      if (fallback !== null) slots[FALLBACK_ORDINAL_SLOT] = String(fallback);
    }
    const candidate: GrammarMatch = {
      matched: true,
      intent: compiled.intent.name,
      slots,
      sample: compiled.sample,
      score: compiled.score,
    };
    if (invalid.length === 0) {
      if (best === null || candidate.score > best.score) best = candidate;
    } else if (
      !compiled.strictSpelled &&
      invalid.every((slot) => slot.kind === 'spelled') &&
      compiled.score >= LITERAL_SCORE &&
      (nearMiss === null || candidate.score > nearMiss.score)
    ) {
      nearMiss = candidate;
    }
  }
  return best ?? nearMiss ?? {matched: false, normalised};
}

function withoutPoliteness(text: string): string {
  const words = normaliseText(text).split(' ');
  for (const phrase of POLITENESS_ANYWHERE) {
    const parts = phrase.split(' ');
    for (let index = 0; index + parts.length <= words.length;) {
      if (words.slice(index, index + parts.length).join(' ') === phrase && words.length > parts.length) {
        words.splice(index, parts.length);
      } else {
        index++;
      }
    }
  }
  return words.join(' ');
}

/**
 * Maps an utterance to an intent and slots, or reports a miss. Ties go to the earlier catalogue entry. When the
 * utterance does not match as said, it is tried once more with politeness removed from the middle ("open can you
 * two"), so politeness never costs a request and never becomes part of an id.
 */
export function parseUtterance(text: string, grammar: Grammar = DEFAULT_GRAMMAR): GrammarMatch | GrammarMiss {
  const asSaid = matchUtterance(text, grammar);
  if (asSaid.matched) return asSaid;
  const polite = withoutPoliteness(text);
  if (polite === normaliseText(text)) return asSaid;
  const retried = matchUtterance(polite, grammar);
  return retried.matched ? retried : asSaid;
}
