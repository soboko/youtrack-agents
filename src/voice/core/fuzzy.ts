/**
 * Fuzzy summary matching (design rule 2): the second way to name an issue, after an ordinal and before a spelled id.
 * Recognisers split and mangle words ("log in" for "login", "colour" for "color"), so each spoken word is scored
 * against the summary's words by exact match, prefix, or a small edit distance. Accents are folded ("zoe" matches
 * "Zoë"), and letters of any script count as words.
 */

/**
 * Words that only carry the request, never its subject. Deliberately short: "well", "right", "now", "for" and "in"
 * can all be what an issue is about.
 */
const STOPWORDS = new Set(['a', 'an', 'the', 'about', 'issue', 'issues', 'one', 'ones', 'called', 'named', 'titled']);

/** A word this close to a summary word counts as found when deciding whether a single match can be opened. */
const FOUND_SCORE = 0.8;

function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '');
}

/** The meaningful words of a search phrase. */
export function searchWords(phrase: string): string[] {
  return words(phrase).filter((word) => !STOPWORDS.has(word));
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({length: b.length + 1}, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function wordScore(spoken: string, candidate: string): number {
  if (spoken === candidate) return 1;
  if (spoken.length >= 3 && candidate.startsWith(spoken)) return 0.8;
  if (candidate.length >= 3 && spoken.startsWith(candidate)) return 0.7;
  if (spoken.length >= 4 && editDistance(spoken, candidate, 1) <= 1) return 0.6;
  if (spoken.length >= 7 && editDistance(spoken, candidate, 2) <= 2) return 0.4;
  return 0;
}

/** The best score of each meaningful spoken word against a summary; a split word joins with the word after it. */
function wordScores(phrase: string, summary: string): number[] {
  return scoreWords(words(phrase), words(summary), STOPWORDS);
}

/** The best score of each spoken word not in `skip` against candidate words, joining split words on either side. */
function scoreWords(said: readonly string[], candidates: readonly string[], skip: ReadonlySet<string>): number[] {
  const joinedCandidates = candidates.flatMap((word, index) =>
    index + 1 < candidates.length ? [word, `${word}${candidates[index + 1]}`] : [word],
  );
  const best = (form: string): number =>
    joinedCandidates.reduce((top, candidate) => Math.max(top, wordScore(form, candidate)), 0);

  const scores: number[] = [];
  for (let index = 0; index < said.length; index++) {
    const word = said[index];
    if (skip.has(word)) continue;
    const alone = best(word);
    const next = said[index + 1];
    if (next !== undefined) {
      const joined = best(`${word}${next}`);
      // "log in" is "login": the joined form wins, and the second word is used up.
      if (joined > alone) {
        scores.push(joined);
        index++;
        continue;
      }
    }
    scores.push(alone);
  }
  return scores;
}

/**
 * Scores a summary against a search phrase, from 0 (nothing matches) to 1 (every meaningful word found exactly).
 * Joined words count too: "log in" matches "login".
 */
export function summaryScore(phrase: string, summary: string): number {
  const scores = wordScores(phrase, summary);
  if (scores.length === 0) return 0;
  return Math.min(scores.reduce((sum, score) => sum + score, 0) / scores.length, 1);
}

/**
 * Whether every meaningful word was found in the summary. A single search result is only opened straight away when
 * this holds; "dark matter" finding only "Add dark mode" is read as a list of one instead.
 */
export function matchesEveryWord(phrase: string, summary: string): boolean {
  const scores = wordScores(phrase, summary);
  return scores.length > 0 && scores.every((score) => score >= FOUND_SCORE);
}

/**
 * Orders items by score, best first, keeping the tracker's order among equals. Nothing is dropped: a tracker's own
 * search may have matched words outside the summary, and hiding those would be a guess too.
 */
export function rankBySummary<T>(phrase: string, items: readonly T[], summaryOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({item, index, score: summaryScore(phrase, summaryOf(item))}))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------------------------------------------
// People (YA-35): "what's assigned to Chris".

/** Someone who can be named: the login is for queries only, the name is what is spoken and matched. */
export interface NamedPerson {
  login: string;
  name: string;
}

/**
 * Words dropped from a spoken name and from the names it is matched against: articles ("the household"), titles, and
 * politeness a recogniser leaves at the end of a phrase ("issues for Chris now"). A possessive is dropped too.
 */
const NAME_FILLERS = new Set([
  'the',
  'a',
  'an',
  'mr',
  'mrs',
  'ms',
  'miss',
  'mister',
  'dr',
  'doctor',
  'please',
  'thanks',
  'now',
]);

/** The words of a spoken or written name: accents folded, possessives and fillers dropped. */
export function nameWords(text: string): string[] {
  return words(text.replace(/(\p{L})['\u2019]s(?=\s|$)/gu, '$1').replace(/(\p{L}s)['\u2019](?=\s|$)/gu, '$1')).filter(
    (word) => !NAME_FILLERS.has(word),
  );
}

/** How closely a name was matched: every word exactly, every word as the start of a word, or every word nearly. */
export type NameMatchTier = 'exact' | 'prefix' | 'near';

const TIER_RANK: Readonly<Record<NameMatchTier, number>> = {exact: 3, prefix: 2, near: 1};
/** The lowest `wordScore` a near match accepts for every spoken word: a misheard letter or two in a long word. */
const NEAR_SCORE = 0.4;

function tierOf(scores: readonly number[]): NameMatchTier | null {
  if (scores.length === 0) return null;
  if (scores.every((score) => score === 1)) return 'exact';
  if (scores.every((score) => score >= FOUND_SCORE)) return 'prefix';
  if (scores.every((score) => score >= NEAR_SCORE)) return 'near';
  return null;
}

export interface PeopleMatch<T extends NamedPerson> {
  /** Everyone matched at the best tier anyone reached, in name order; empty when nobody matched. */
  people: T[];
  tier: NameMatchTier | null;
}

/**
 * Matches a spoken name against people, by full name (so first name and surname alone too) and by login, ignoring
 * case, accents, possessives and fillers. Every spoken word must be found in one of those. Only the best tier anyone
 * reached counts: "Chris" said exactly is not also "Christine" by prefix. Several people at that tier is an ambiguity
 * for the caller to ask about, never to guess.
 */
export function matchPeople<T extends NamedPerson>(spoken: string, people: readonly T[]): PeopleMatch<T> {
  const said = nameWords(spoken);
  if (said.length === 0) return {people: [], tier: null};
  let best: NameMatchTier | null = null;
  let matched: T[] = [];
  for (const person of people) {
    const forms = [nameWords(person.name), words(person.login), [words(person.login).join('')]];
    let tier: NameMatchTier | null = null;
    for (const form of forms) {
      const found = tierOf(scoreWords(said, form, NAME_FILLERS));
      if (found !== null && (tier === null || TIER_RANK[found] > TIER_RANK[tier])) tier = found;
    }
    if (tier === null) continue;
    if (best === null || TIER_RANK[tier] > TIER_RANK[best]) {
      best = tier;
      matched = [person];
    } else if (tier === best) {
      matched.push(person);
    }
  }
  const byName = [...matched].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.login.localeCompare(b.login));
  return {people: byName, tier: best};
}

/**
 * Whether a spoken name is exactly one of the forms a person is known by (YA-35 review F4): their whole full name,
 * their first name, or their login. Only such a match, with one candidate, is taken without asking; a surname, a
 * prefix or a near miss is confirmed by name first.
 */
export function isExactName(spoken: string, person: NamedPerson): boolean {
  const said = nameWords(spoken);
  if (said.length === 0) return false;
  const name = nameWords(person.name);
  const login = words(person.login);
  const saidText = said.join(' ');
  return (
    saidText === name.join(' ') ||
    (said.length === 1 && said[0] === name[0]) ||
    saidText === login.join(' ') ||
    said.join('') === login.join('')
  );
}
