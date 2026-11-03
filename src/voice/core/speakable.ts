/**
 * Markdown to speech (design rule 6). Tracker text arrives as markdown written for eyes; this turns it into plain
 * sentences a speech engine can read without spelling out syntax.
 *
 * - Links become their text, bare URLs become "a link", images become "an image" (with their alt text).
 * - Code spans lose their backticks; fenced code blocks become "a code block".
 * - Tables become "a table of N rows"; lists become "a list of N items" followed by the items.
 * - Headings become sentences and lead into the paragraph after them.
 * - Issue ids become "an issue", and anything that looks like a secret (a token, a long random string) becomes
 *   "a long code" (design rule 10: no secret is ever spoken).
 *
 * The output is paragraph-sized blocks, so a long description is read one paragraph at a time.
 */
import {
  CODE_BLOCK_WORDS,
  IMAGE_WORDS,
  ISSUE_REFERENCE_WORDS,
  LINK_WORDS,
  SECRET_WORDS,
  listWords,
  tableWords,
} from './phrasing.ts';
import type {SpeechSegment} from './types.ts';

const ISSUE_ID = /\b([A-Z][A-Z0-9]{0,9})-\d+\b(?![-\w])/g;
/** Prefixes of hyphenated names that are not issue ids: UTF-8, ISO-8601, SHA-256, CVE-2024-1234. */
const NOT_ISSUE_PREFIXES = new Set([
  'UTF',
  'ISO',
  'ES',
  'ECMA',
  'SHA',
  'MD',
  'COVID',
  'CVE',
  'RFC',
  'TLS',
  'SSL',
  'HTTP',
  'IPV',
  'MP',
]);
const URL = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi;
/**
 * Tokens with a known shape: GitHub, GitLab, Slack, OpenAI and Stripe keys, AWS access key ids, Google API keys,
 * YouTrack permanent tokens and JWTs. Each needs its full shape, so "ASIA-Pacific" or "sk-learn" are left alone.
 */
const PREFIXED_SECRET = new RegExp(
  [
    String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
    String.raw`\bxox[abpr]-[A-Za-z0-9-]{10,}`,
    String.raw`\bsk-[A-Za-z0-9]{20,}(?![\w-])`,
    String.raw`\b(?:sk|pk|rk)_live_[A-Za-z0-9]{16,}`,
    String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\bperm:[A-Za-z0-9+/=._-]{8,}[A-Za-z0-9=]`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+`,
  ].join('|'),
  'g',
);

/** A UUID, which is how many services shape API keys and webhook secrets. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * The value of a credential written as a pair: `key=`, `token=`, `secret=`, `password=`, `api_key=` (and the same
 * with a colon, or a prefix such as `access_token`), and an `Authorization: Bearer` header. The value goes whatever
 * its shape: "password=Summer2026!" is as secret as a random string.
 */
const CREDENTIAL_PAIR =
  /\b((?:[a-z]+[_-])?(?:api[_-]?key|key|token|secret|password|passwd|pwd))\s*[:=]\s*["']?[^\s"'`,;]{3,}["']?/gi;
const BEARER = /\b(authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** How many times a run switches between letters and digits: "abcd1234efgh5678" switches 3 times. */
function letterDigitSwitches(piece: string): number {
  let switches = 0;
  for (let index = 1; index < piece.length; index++) {
    if (/\d/.test(piece[index]) !== /\d/.test(piece[index - 1])) switches++;
  }
  return switches;
}

/**
 * A piece that looks random: long hex with letters and digits, a long mix of upper case, lower case and digits, or a
 * long run of letters and digits that keeps switching between the two (a lower-case API key).
 */
function randomLooking(piece: string): boolean {
  if (piece.length >= 20 && /^[A-Fa-f0-9]+$/.test(piece) && /\d/.test(piece) && /[a-f]/i.test(piece)) return true;
  const mixed = /[a-z]/.test(piece) && /[A-Z]/.test(piece) && /\d/.test(piece);
  if (piece.length >= 16 && mixed) return true;
  if (piece.length >= 20 && /^[A-Za-z0-9]+$/.test(piece) && letterDigitSwitches(piece) >= 3) return true;
  return piece.length >= 32 && /^[A-Za-z0-9]+$/.test(piece) && /\d/.test(piece) && /[a-z]/i.test(piece);
}

/**
 * Whether a word (no spaces) looks like a secret: a long base64 run, or a piece between separators that looks
 * random. Hyphenated and underscored words, dates and times, file paths, versions and e-mail addresses are split at
 * their separators first, so their ordinary pieces keep them readable.
 */
function looksLikeSecret(bare: string): boolean {
  if (bare.length < 16) return false;
  if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(bare) && /[a-z]/.test(bare) && /[A-Z]/.test(bare) && /\d/.test(bare)) {
    return true;
  }
  return bare.split(/[-_/.:@+=]+/).some(randomLooking);
}

/** Ensures a sentence ends in terminal punctuation. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed.replace(/[,;:]+$/, '')}.`;
}

/** Makes one line of inline markdown speakable: links, code spans, emphasis, URLs, ids, secrets. */
export function speakableInline(markdown: string): string {
  let text = markdown;

  // Autolinks first, so the tag stripping below does not take them: <https://...>.
  text = text.replace(/<((?:https?|ftp):\/\/[^>]+)>/gi, LINK_WORDS);
  // HTML: line breaks become spaces, other tags go.
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, '');
  // Images before links: ![alt](url).
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) =>
    alt.trim() === '' ? IMAGE_WORDS : `${IMAGE_WORDS}: ${alt.trim()}`,
  );
  // Links: [text](url) and [text][ref] become their text; [url](url) becomes "a link".
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  // Bare URLs (including any a link label was made of), whole, so a token in a query string goes with them.
  text = text.replace(URL, LINK_WORDS);
  // Secrets with a known prefix, before code spans, so a token inside backticks is still caught.
  text = text.replace(PREFIXED_SECRET, SECRET_WORDS);
  text = text.replace(
    BEARER,
    (_match, header: string | undefined) => `${header === undefined ? '' : 'Authorization: '}bearer ${SECRET_WORDS}`,
  );
  text = text.replace(CREDENTIAL_PAIR, (_match, name: string) => `${name.replace(/[_-]+/g, ' ')}: ${SECRET_WORDS}`);
  text = text.replace(UUID, SECRET_WORDS);
  // Code spans lose their backticks.
  text = text.replace(/`+([^`]*)`+/g, '$1');
  // Emphasis and strikethrough.
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = text.replace(/~{2,}/g, ' ');
  // Issue ids and secrets.
  text = text.replace(ISSUE_ID, (id: string, prefix: string) =>
    NOT_ISSUE_PREFIXES.has(prefix) ? id : ISSUE_REFERENCE_WORDS,
  );
  text = text
    .split(/(\s+)/)
    .map((word) => {
      // Punctuation around the word stays: "token abc...123," keeps its comma.
      const match = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9=]*)$/.exec(word);
      if (match === null || !looksLikeSecret(match[2])) return word;
      return `${match[1]}${SECRET_WORDS}${match[3]}`;
    })
    .join('');
  // Mentions: @sam is read as sam.
  text = text.replace(/(^|\s)@([A-Za-z0-9._-]+)/g, '$1$2');
  // Escapes, then any markdown punctuation left over.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
  text = text.replace(/[`|]/g, ' ').replace(/(^|\s)[#>]+(?=\s|$)/g, ' ');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  return text.replace(/\s+/g, ' ').trim();
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+/;

/**
 * Splits markdown into speakable blocks, one per paragraph (a heading joins the paragraph after it). Empty input
 * gives no blocks.
 */
export function speakableBlocks(markdown: string | null): string[] {
  if (markdown === null) return [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let pendingHeading: string | null = null;

  const emit = (text: string): void => {
    const spoken = text.trim();
    if (spoken === '') return;
    if (pendingHeading !== null) {
      blocks.push(`${pendingHeading} ${spoken}`);
      pendingHeading = null;
    } else {
      blocks.push(spoken);
    }
  };
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    emit(asSentence(speakableInline(paragraph.join(' '))));
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    // A fence opens a code block only if it has a closing fence and, for backticks, no backtick after the opening
    // run (CommonMark). Otherwise the line is ordinary text, so a stray fence never swallows the rest.
    if (fence !== null && !(fence[1].startsWith('`') && fence[2].includes('`'))) {
      const closing = new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const end = lines.findIndex((candidate, index) => index > i && closing.test(candidate));
      if (end !== -1) {
        flushParagraph();
        i = end;
        emit(CODE_BLOCK_WORDS);
        continue;
      }
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    if (RULE.test(line) || REFERENCE_DEFINITION.test(line)) {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const spokenHeading = asSentence(speakableInline(heading[1]));
      if (pendingHeading !== null) blocks.push(pendingHeading);
      pendingHeading = spokenHeading === '' ? null : spokenHeading;
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flushParagraph();
      let rows = 0;
      let sawSeparator = false;
      while (i < lines.length && (TABLE_ROW.test(lines[i]) || TABLE_SEPARATOR.test(lines[i]))) {
        if (TABLE_SEPARATOR.test(lines[i])) {
          sawSeparator = true;
        } else {
          rows++;
        }
        i++;
      }
      i--;
      // The row above the separator is the header, not a row of data.
      emit(tableWords(sawSeparator ? Math.max(rows - 1, 0) : rows));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const item = LIST_ITEM.exec(lines[i]);
        if (item) {
          items.push(item[1]);
        } else if (items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
        }
        i++;
      }
      i--;
      const spokenItems = items.map((item) => asSentence(speakableInline(item))).filter((item) => item !== '');
      emit([listWords(spokenItems.length), ...spokenItems].join(' '));
      continue;
    }
    paragraph.push(line.replace(/^\s{0,3}>\s?/, ''));
  }
  flushParagraph();
  if (pendingHeading !== null) blocks.push(pendingHeading);
  return blocks;
}

/** Markdown as speech segments, one per paragraph, with a long pause between paragraphs. */
export function speakableSegments(markdown: string | null): SpeechSegment[] {
  return speakableBlocks(markdown).map((text) => ({text, pauseAfter: 'long'}));
}

/**
 * Splits text into pieces no longer than `maxChars`, at sentence ends where possible, then at word boundaries. A
 * single word longer than the limit is cut, which only happens for text that was not speakable anyway.
 */
export function splitForSpeech(text: string, maxChars: number): string[] {
  const limit = Math.max(maxChars, 20);
  if (text.length <= limit) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = '';
  const push = (piece: string): void => {
    if (piece !== '') pieces.push(piece);
  };

  for (const sentence of sentences) {
    const candidate = current === '' ? sentence : `${current} ${sentence}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    push(current);
    current = '';
    if (sentence.length <= limit) {
      current = sentence;
      continue;
    }
    for (const word of sentence.split(' ')) {
      const withWord = current === '' ? word : `${current} ${word}`;
      if (withWord.length <= limit) {
        current = withWord;
      } else {
        push(current);
        let rest = word;
        while (rest.length > limit) {
          pieces.push(rest.slice(0, limit));
          rest = rest.slice(limit);
        }
        current = rest;
      }
    }
  }
  push(current);
  return pieces;
}

/** The longest person's name spoken or echoed (YA-35): a pasted signature or a runaway recogniser is cut to this. */
export const MAX_NAME_CHARS = 60;

/** A name cut to `MAX_NAME_CHARS` at a word boundary. */
export function nameForSpeech(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return trimmed.length <= MAX_NAME_CHARS ? trimmed : splitForSpeech(trimmed, MAX_NAME_CHARS)[0].trim();
}

/** A word ending in a period after letters only is an initial or a title ("J.", "Dr."), not a login's dot. */
const INITIAL_OR_TITLE = /^\p{L}+\.$/u;

/** Whether one word of a name is shaped like a login or an email: `@`, an inner `.`, `_`, or a digit. */
function loginShapedWord(word: string): boolean {
  if (/[@_\d]/u.test(word)) return true;
  return word.includes('.') && !INITIAL_OR_TITLE.test(word);
}

/**
 * The name a person may be called aloud, or null when they have none (YA-35 review F1, recheck R1). A login or an email
 * is never spoken, so a full name is no name when it is empty; when any word of it is login- or email-shaped
 * ("jo.bloggs", "j_smith", "chris2", "jo@example.com"); when it is the login, in any case ("ccoulter", "CCoulter"), as
 * YouTrack fills in for a user who never set one; or when a word of it is the login exactly as written ("pnair Priya").
 * A capitalised word that happens to spell the login is a name ("Robin Hale" for login `robin`). Ordinary names,
 * hyphens, apostrophes and initials included ("Anne-Marie O'Neil", "Mary J. Jones"), are kept. The one place the core
 * and the binding decide this.
 */
export function speakablePersonName(login: string | null, fullName: string | null | undefined): string | null {
  const trimmed = (fullName ?? '').replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  const nameWords = trimmed.split(' ');
  if (nameWords.some(loginShapedWord)) return null;
  const ownLogin = (login ?? '').trim();
  if (ownLogin !== '') {
    if (trimmed.toLowerCase() === ownLogin.toLowerCase()) return null;
    if (nameWords.some((word) => word === ownLogin)) return null;
  }
  const spoken = nameForSpeech(speakableInline(trimmed));
  return spoken === '' ? null : spoken;
}
