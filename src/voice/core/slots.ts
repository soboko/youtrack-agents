/**
 * Slot-value parsers shared by the text grammar and by adapters that resolve intents themselves. Every parser takes
 * a raw spoken or typed value and returns a canonical value, or null when the value cannot be read without guessing.
 * They are idempotent: a canonical value parses to itself, so an adapter may send either.
 */
import {SLOT_SYNONYMS} from './intents.ts';

const UNIT_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  nought: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const ORDINAL_UNIT_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
};

const ORDINAL_TENS_WORDS: Readonly<Record<string, number>> = {
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
};

/** The NATO phonetic alphabet, with the spellings recognisers commonly return. */
const PHONETIC_WORDS: Readonly<Record<string, string>> = {
  alpha: 'A',
  alfa: 'A',
  bravo: 'B',
  charlie: 'C',
  delta: 'D',
  echo: 'E',
  foxtrot: 'F',
  golf: 'G',
  hotel: 'H',
  india: 'I',
  juliet: 'J',
  juliett: 'J',
  kilo: 'K',
  lima: 'L',
  mike: 'M',
  november: 'N',
  oscar: 'O',
  papa: 'P',
  quebec: 'Q',
  romeo: 'R',
  sierra: 'S',
  tango: 'T',
  uniform: 'U',
  victor: 'V',
  whiskey: 'W',
  whisky: 'W',
  xray: 'X',
  yankee: 'Y',
  zulu: 'Z',
};

/** Letter names as a recogniser may transcribe them when someone spells without the phonetic alphabet. */
const LETTER_NAME_WORDS: Readonly<Record<string, string>> = {
  ay: 'A',
  bee: 'B',
  cee: 'C',
  see: 'C',
  sea: 'C',
  dee: 'D',
  ee: 'E',
  eff: 'F',
  gee: 'G',
  aitch: 'H',
  eye: 'I',
  jay: 'J',
  kay: 'K',
  el: 'L',
  ell: 'L',
  em: 'M',
  en: 'N',
  pee: 'P',
  pea: 'P',
  cue: 'Q',
  queue: 'Q',
  are: 'R',
  ess: 'S',
  tee: 'T',
  tea: 'T',
  you: 'U',
  vee: 'V',
  ex: 'X',
  why: 'Y',
  zed: 'Z',
  zee: 'Z',
};

const SPELLING_NOISE = new Set(['dash', 'hyphen', 'minus', 'space', 'then', 'and']);

const MAX_ORDINAL = 999;
const MAX_ID_LETTERS = 10;

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter((token) => token !== '');
}

/**
 * Reads a whole-number phrase: digits ("21"), words ("twenty one", "one hundred and five"). Returns null when any
 * token is not part of a number.
 */
export function parseCardinal(value: string | readonly string[]): number | null {
  const words = typeof value === 'string' ? tokens(value) : [...value];
  if (words.length === 0) return null;
  if (words.length === 1 && /^\d+$/.test(words[0])) return Number(words[0]);
  if (words.length === 1 && (words[0] === 'zero' || words[0] === 'nought')) return 0;

  // Each word must be able to follow the one before: "twenty one" and "one hundred and five" are numbers, "one two"
  // is two numbers, and is refused rather than added up.
  type Kind = 'start' | 'unit' | 'teen' | 'tens' | 'hundred' | 'thousand' | 'and';
  let total = 0;
  let current = 0;
  let last: Kind = 'start';
  for (const word of words) {
    const unit = Object.hasOwn(UNIT_WORDS, word) ? UNIT_WORDS[word] : null;
    if (word === 'and' && (last === 'hundred' || last === 'thousand')) {
      last = 'and';
    } else if (word === 'a' && last === 'start' && words.length > 1) {
      current = 1;
      last = 'unit';
    } else if (
      unit !== null &&
      unit >= 1 &&
      unit <= 9 &&
      ['start', 'tens', 'hundred', 'thousand', 'and'].includes(last)
    ) {
      current += unit;
      last = 'unit';
    } else if (unit !== null && unit >= 10 && ['start', 'hundred', 'thousand', 'and'].includes(last)) {
      current += unit;
      last = 'teen';
    } else if (Object.hasOwn(TENS_WORDS, word) && ['start', 'hundred', 'thousand', 'and'].includes(last)) {
      current += TENS_WORDS[word];
      last = 'tens';
    } else if (word === 'hundred' && (last === 'unit' || last === 'start') && current < 10) {
      current = (current === 0 ? 1 : current) * 100;
      last = 'hundred';
    } else if (word === 'thousand' && last !== 'start' && last !== 'and' && last !== 'thousand' && total === 0) {
      total = current * 1000;
      current = 0;
      last = 'thousand';
    } else {
      return null;
    }
  }
  return last === 'and' ? null : total + current;
}

function ordinalWordValue(word: string): number | null {
  if (Object.hasOwn(ORDINAL_UNIT_WORDS, word)) return ORDINAL_UNIT_WORDS[word];
  if (Object.hasOwn(ORDINAL_TENS_WORDS, word)) return ORDINAL_TENS_WORDS[word];
  const suffixed = /^(\d+)(st|nd|rd|th)$/.exec(word);
  return suffixed ? Number(suffixed[1]) : null;
}

/** A position in the working set: a 1-based number, or `last`. */
export type OrdinalValue = number | 'last';

/**
 * Reads a position: "two", "2", "second", "2nd", "number 2", "the 2nd one", "twenty first", "the last one".
 * Returns null for anything else, including zero and numbers above 999.
 */
export function parseOrdinal(value: string): OrdinalValue | null {
  let words = tokens(value);
  // A leading minus is not a position. A leading "issue" is not either: "issue 12" is an id with its letters
  // missing, and reading it as number 12 would open the wrong issue.
  if (/^\s*-/.test(value)) return null;
  while (words.length > 0 && ['the', 'number', 'no', 'item', 'position'].includes(words[0])) {
    words = words.slice(1);
  }
  if (words.length > 1 && ['one', 'item', 'issue'].includes(words[words.length - 1])) {
    const before = words[words.length - 2];
    if (before === 'last' || ordinalWordValue(before) !== null) words = words.slice(0, -1);
  }
  if (words.length === 0) return null;
  if (words.length === 1 && words[0] === 'last') return 'last';

  const lastWord = words[words.length - 1];
  const ordinalTail = ordinalWordValue(lastWord);
  let result: number | null;
  if (ordinalTail !== null) {
    if (words.length === 1) {
      result = ordinalTail;
    } else {
      const head = parseCardinal(words.slice(0, -1));
      result = head === null || head % 10 !== 0 || ordinalTail >= 10 ? null : head + ordinalTail;
    }
  } else {
    result = parseCardinal(words);
  }
  if (result === null || !Number.isInteger(result) || result < 1 || result > MAX_ORDINAL) return null;
  return result;
}

function digitRun(words: readonly string[]): string | null {
  // "one three" is 13 and "one thirteen" is 113, the way people read ids aloud; "one hundred and two" is 102.
  if (words.includes('hundred') || words.includes('thousand')) {
    const value = parseCardinal(words);
    return value === null ? null : String(value);
  }
  let digits = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    if (
      Object.hasOwn(TENS_WORDS, word) &&
      next !== undefined &&
      Object.hasOwn(UNIT_WORDS, next) &&
      UNIT_WORDS[next] < 10
    ) {
      digits += String(TENS_WORDS[word] + UNIT_WORDS[next]);
      i++;
    } else if (Object.hasOwn(UNIT_WORDS, word)) {
      digits += String(UNIT_WORDS[word]);
    } else if (Object.hasOwn(TENS_WORDS, word)) {
      digits += String(TENS_WORDS[word]);
    } else if (/^\d+$/.test(word)) {
      digits += word;
    } else {
      return null;
    }
  }
  return digits;
}

function isNumberWord(word: string): boolean {
  return (
    Object.hasOwn(UNIT_WORDS, word) ||
    Object.hasOwn(TENS_WORDS, word) ||
    word === 'hundred' ||
    word === 'thousand' ||
    /^\d+$/.test(word)
  );
}

/**
 * Reads an issue id spelled out: letters (single letters, letter names or the phonetic alphabet), then a number
 * (digits, digit words or a spoken number). "yankee alpha one three", "Y A 13", "ya-13" and "YA-13" all give
 * `YA-13`. Returns null unless there is at least one letter followed by at least one digit.
 */
/**
 * Hesitation sounds that are also plausible project keys: a recogniser writes "M M twelve" as "mm twelve", and a
 * typed "ER-5" is "er 5" once normalised. The grammar keeps them when they lead into a number (see grammar.ts).
 */
export const FILLER_KEY_TOKENS: ReadonlySet<string> = new Set([
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
]);

/** Short everyday words that come before a number in speech and are never read as a project key. */
const NOT_A_KEY = new Set([
  'a',
  'an',
  'the',
  'to',
  'too',
  'for',
  'of',
  'in',
  'on',
  'at',
  'by',
  'is',
  'it',
  'its',
  'my',
  'me',
  'no',
  'not',
  'and',
  'or',
  'so',
  'go',
  'do',
  'up',
  'us',
  'we',
  'he',
  'she',
  'be',
  'see',
  'all',
  'any',
  'page',
  'item',
  'list',
  'top',
  'last',
  'next',
  'just',
  'now',
  'then',
  'than',
  'from',
  'with',
  'into',
  'like',
  'over',
  'part',
  'step',
  'take',
  'give',
  'open',
  'read',
  'find',
  'show',
  'tell',
  'id',
  'yes',
  'okay',
  'ok',
  'hey',
  'more',
  'back',
  'pick',
  'this',
  'that',
  'what',
  'which',
  'only',
  'about',
  'get',
  'set',
  'say',
  'call',
  'try',
  'was',
  'are',
  'has',
  'had',
  'issue',
  'number',
  'items',
]);

/** True for a digit run or a number word: what a project key can be followed by. */
export function isNumberToken(word: string): boolean {
  return /^\d+$/.test(word) || isNumberWord(word);
}

/** True for a spelled letter: a single letter, a letter's name, or a phonetic-alphabet word. */
export function isLetterToken(word: string): boolean {
  return /^[a-z]$/.test(word) || Object.hasOwn(PHONETIC_WORDS, word) || Object.hasOwn(LETTER_NAME_WORDS, word);
}

/** True for a word that can be part of a spelled id: a digit run, a number word, a letter, or a letter's name. */
export function isSpellingToken(word: string): boolean {
  return (
    /^\d+$/.test(word) ||
    /^[a-z]$/.test(word) ||
    isNumberWord(word) ||
    Object.hasOwn(PHONETIC_WORDS, word) ||
    Object.hasOwn(LETTER_NAME_WORDS, word)
  );
}

export interface SpelledIdOptions {
  /**
   * For utterances with no carrier word ("YA-13", "open ya13"). A multi-letter word then counts as a project key
   * only with typed digits after it, or when it is a hesitation-shaped key such as "mm"; "try two" is not an id.
   */
  strict?: boolean;
}

export function parseSpelledId(value: string, options: SpelledIdOptions = {}): string | null {
  const words = tokens(value.replace(/-/g, ' '));
  let letters = '';
  let digits = '';
  let numberWords: string[] = [];

  const flushNumber = (): boolean => {
    if (numberWords.length === 0) return true;
    const run = digitRun(numberWords);
    numberWords = [];
    if (run === null) return false;
    digits += run;
    return true;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    const inDigits = digits !== '' || numberWords.length > 0;

    if (word === 'and' && numberWords.length > 0 && next !== undefined && isNumberWord(next)) {
      numberWords.push(word);
      continue;
    }
    if (SPELLING_NOISE.has(word)) continue;
    if (isNumberWord(word)) {
      numberWords.push(word);
      continue;
    }
    if (word === 'oh' && inDigits) {
      numberWords.push('zero');
      continue;
    }
    if (!flushNumber()) return null;

    let letter: string | null = null;
    if (word === 'x' && next === 'ray') {
      letter = 'X';
      i++;
    } else if (word === 'double' && (next === 'you' || next === 'u')) {
      letter = 'W';
      i++;
    } else if (Object.hasOwn(PHONETIC_WORDS, word)) {
      letter = PHONETIC_WORDS[word];
    } else if (Object.hasOwn(LETTER_NAME_WORDS, word)) {
      letter = LETTER_NAME_WORDS[word];
    } else if (word === 'oh') {
      letter = 'O';
    } else if (/^[a-z]$/.test(word)) {
      letter = word.toUpperCase();
    }

    if (letter !== null) {
      if (digits !== '') return null;
      letters += letter;
      continue;
    }

    // Typed ids: "ya13", or "ya" then typed digits. A key followed by a spoken number ("ya twelve", "mm twelve") is
    // accepted after a carrier word, but an everyday word ("for thirteen") never is: that would be a guess.
    const typed = /^([a-z]{1,10})(\d*)$/.exec(word);
    const typedDigitsNext = next !== undefined && /^\d+$/.test(next) && !NOT_A_KEY.has(word);
    const spokenNumberNext = next !== undefined && isNumberWord(next);
    const keyShaped = options.strict ? FILLER_KEY_TOKENS.has(word) : word.length <= 4 && !NOT_A_KEY.has(word);
    if (
      typed &&
      digits === '' &&
      letters === '' &&
      (typed[2] !== '' || typedDigitsNext || (spokenNumberNext && keyShaped))
    ) {
      letters += typed[1].toUpperCase();
      digits += typed[2];
      continue;
    }
    return null;
  }
  if (!flushNumber()) return null;
  if (letters === '' || digits === '' || letters.length > MAX_ID_LETTERS) return null;
  return `${letters}-${digits}`;
}

/** Speaks an id the user asked for, letter by letter, so it is not read as a word: `YA-13` becomes "Y A 13". */
export function spokenId(id: string): string {
  const match = /^([A-Z]+)-(\d+)$/.exec(id);
  if (!match) return id.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return `${match[1].split('').join(' ')} ${match[2]}`;
}

/**
 * Resolves an enum slot value to its canonical value: the canonical value itself (a hyphen may be a space) or one of
 * its synonyms in `SLOT_SYNONYMS`. Returns null for anything else.
 */
export function resolveEnum(slotName: string, values: readonly string[], raw: string): string | null {
  const said = tokens(raw.replace(/-/g, ' ')).join(' ');
  for (const value of values) {
    if (said === value.replace(/-/g, ' ')) return value;
  }
  const synonyms = SLOT_SYNONYMS[slotName] ?? {};
  for (const value of values) {
    for (const synonym of synonyms[value] ?? []) {
      if (said === tokens(synonym.replace(/-/g, ' ')).join(' ')) return value;
    }
  }
  return null;
}

/** Speech-rate request: a direction, a reset, or an explicit percentage of the platform default. */
export type RateValue = 'slower' | 'faster' | 'normal' | number;

const MIN_RATE_PERCENT = 20;
const MAX_RATE_PERCENT = 400;

/**
 * Reads a rate: "faster", "slow down", "normal speed", or a percentage ("150", "150 percent", "one hundred and fifty
 * percent"). Percentages outside 20 to 400 are refused rather than clamped, because they are probably misheard.
 */
export function parseRate(raw: string): RateValue | null {
  const direction = resolveEnum('rate', ['slower', 'faster', 'normal'], raw);
  if (direction === 'slower' || direction === 'faster' || direction === 'normal') return direction;
  let words = tokens(raw.replace(/%/g, ' percent'));
  if (words.length > 1 && words[words.length - 1] === 'percent') words = words.slice(0, -1);
  if (words.length > 2 && words[words.length - 2] === 'per' && words[words.length - 1] === 'cent') {
    words = words.slice(0, -2);
  }
  const value = parseCardinal(words);
  if (value === null || value < MIN_RATE_PERCENT || value > MAX_RATE_PERCENT) return null;
  return value;
}
