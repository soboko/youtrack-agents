/**
 * Every spoken string in the voice core (design rule 4). Nothing outside this module says anything to the user.
 *
 * The shapes are rigid on purpose, so they can be learned and then half-listened to:
 * - a count comes before a list, and a number comes before a summary;
 * - the same kind of answer always has the same sentence shape;
 * - ids and URLs are never read, unless the person asked for an issue by its id;
 * - there is always a way forward, and it is never "check the app".
 *
 * Wording is expected to change after the household trial. Change it here, then update the transcripts.
 */
import type {ListSource, Part, Progress, Verbosity, WorkingSetItem} from './state.ts';
import type {AqiCategory, Earcon, SpeechSegment} from './types.ts';

/** A reply before the core attaches the rate and the adapter-facing shape. */
export interface Reply {
  segments: SpeechSegment[];
  earcon?: Earcon;
  listen: boolean;
  reprompt?: SpeechSegment[];
  cardTitle?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown placeholders, used by speakable.ts.

export const CODE_BLOCK_WORDS = 'A code block.';
export const LINK_WORDS = 'a link';
export const IMAGE_WORDS = 'an image';
export const ISSUE_REFERENCE_WORDS = 'an issue';
export const SECRET_WORDS = 'a long code';

export function tableWords(rows: number): string {
  return rows === 1 ? 'A table of 1 row.' : `A table of ${rows} rows.`;
}

export function listWords(items: number): string {
  return items === 1 ? 'A list of 1 item.' : `A list of ${items} items.`;
}

export const CARD_TITLE = 'Tracker';

// ---------------------------------------------------------------------------------------------------------------
// Small pieces.

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY_MS = 24 * 60 * 60 * 1000;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A list label: "One", "Twenty-one"; digits from 100. */
export function numberLabel(n: number): string {
  if (n < 20) return capitalise(NUMBER_WORDS[n]);
  if (n < 100) {
    const tens = TENS_WORDS[Math.floor(n / 10)];
    const unit = n % 10;
    return capitalise(unit === 0 ? tens : `${tens}-${NUMBER_WORDS[unit]}`);
  }
  return String(n);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed.replace(/[,;:]+$/, '')}.`;
}

function bare(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
}

function say(text: string, pauseAfter?: SpeechSegment['pauseAfter']): SpeechSegment {
  return pauseAfter === undefined ? {text} : {text, pauseAfter};
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function atLeast(n: number, complete: boolean, one: string, many: string): string {
  return complete ? plural(n, one, many) : `at least ${n} ${n === 1 ? one : many}`;
}

/** Day number and calendar parts of an instant in a time zone. Throws a RangeError for an unknown zone. */
function localDay(timestamp: number, timeZone: string): {day: number; year: number; month: number; date: number} {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone, year: 'numeric', month: 'numeric', day: 'numeric'})
    .formatToParts(new Date(timestamp))
    .reduce<Record<string, number>>((found, part) => {
      if (part.type !== 'literal') found[part.type] = Number(part.value);
      return found;
    }, {});
  return {
    day: Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS),
    year: parts.year,
    month: parts.month,
    date: parts.day,
  };
}

/**
 * When something happened. With the listener's time zone: "today", "yesterday", "3 days ago", then "on 4 August".
 * Without one, only the absolute date ("on 4 August", in UTC), because a relative day computed in the wrong zone is
 * wrong for hours every day. The year is added when it is not the current one.
 */
export function whenWords(timestamp: number, now: number, timeZone?: string): string {
  const zone = timeZone ?? 'UTC';
  const then = localDay(timestamp, zone);
  const today = localDay(now, zone);
  if (timeZone !== undefined) {
    const days = today.day - then.day;
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days > 1 && days < 7) return `${days} days ago`;
  }
  const year = then.year === today.year ? '' : ` ${then.year}`;
  return `on ${then.date} ${MONTHS[then.month - 1]}${year}`;
}

function partName(part: Part): string {
  return part;
}

// ---------------------------------------------------------------------------------------------------------------
// Reprompts.

export const REPROMPT_DEFAULT: SpeechSegment[] = [say("Say 'help' to hear what you can say.")];
const REPROMPT_LIST_MORE: SpeechSegment[] = [say("Say 'open' and a number, or 'more'.")];
const REPROMPT_LIST: SpeechSegment[] = [say("Say 'open' and a number.")];
const REPROMPT_ISSUE: SpeechSegment[] = [say("Say 'description', 'comments', or 'fields'.")];
const REPROMPT_MORE: SpeechSegment[] = [say("Say 'more' to go on.")];
const REPROMPT_PERSON: SpeechSegment[] = [say("Say the number of the one you mean, like 'one'.")];
const REPROMPT_YES_NO: SpeechSegment[] = [say('Say yes or no.')];

// ---------------------------------------------------------------------------------------------------------------
// Session.

export function launchFresh(): Reply {
  return {segments: [say("Tracker ready. Say 'my issues', or 'help'.")], listen: true, reprompt: REPROMPT_DEFAULT};
}

export function launchResumeIssue(summary: string, part: Part | null): Reply {
  const where =
    part === null ? `You had ${bare(summary)} open.` : `You were reading the ${partName(part)} of ${bare(summary)}.`;
  return {
    segments: [say('Welcome back.', 'short'), say(where, 'short'), say("Say 'more' to go on, or 'my issues'.")],
    listen: true,
    reprompt: REPROMPT_MORE,
  };
}

export function launchResumeList(): Reply {
  return {
    segments: [
      say('Welcome back.', 'short'),
      say("Say 'more' to go on with your list, or 'my issues' to start again."),
    ],
    listen: true,
    reprompt: REPROMPT_LIST_MORE,
  };
}

export function launchGated(): Reply {
  return {segments: [say('Tracker ready.', 'short'), ...gated().segments], earcon: 'failure', listen: false};
}

export function goodbye(): Reply {
  return {segments: [say('Goodbye.')], listen: false};
}

export function cancelled(): Reply {
  return {segments: [say('OK.')], listen: false};
}

export function silent(): Reply {
  return {segments: [], listen: false};
}

export function help(): Reply {
  return {
    segments: [
      say(
        "You can say: 'my issues', 'issues for' and a name, 'air quality here', 'open' and a number, 'description', 'comments', 'more', 'previous', 'repeat', and 'where am I'.",
        'long',
      ),
      say(
        "To change how I talk, say 'brief', 'normal' or 'full', or 'faster', 'slower' or 'normal speed'. Say 'stop' to finish.",
      ),
    ],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function didNotCatch(): Reply {
  return {
    segments: [say("I didn't catch that. You can say 'my issues', or 'help'.")],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** "Yes", "no" or "done" with nothing waiting for an answer. */
export function nothingToConfirm(): Reply {
  return {segments: [say("There's nothing to confirm.")], listen: true, reprompt: REPROMPT_DEFAULT};
}

/** "Done" or "finished" with no dictation going on. */
export function nothingToFinish(): Reply {
  return {segments: [say("There's nothing to finish.")], listen: true, reprompt: REPROMPT_DEFAULT};
}

export function notYet(): Reply {
  return {
    segments: [say("I can't do that yet. For now I can only read issues.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** Design rule 8: says why, not what exists, and offers no other place to look. */
export function gated(): Reply {
  return {segments: [say("I can't read issues until I'm sure who's speaking.")], earcon: 'failure', listen: false};
}

export function somethingWentWrong(): Reply {
  return {
    segments: [say('Something went wrong on my side. Try again in a moment.')],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function trackerUnavailable(): Reply {
  return {
    segments: [say("I couldn't reach the tracker. Try again in a moment.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function trackerRefused(): Reply {
  return {
    segments: [say("The tracker wouldn't let me read that.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lists.

/** Words not capitalised in a name echoed back from what was said, unless they come first. */
const LOWER_IN_NAMES = new Set(['the', 'a', 'an', 'of', 'and']);

/** A name as the person said it, capitalised for a card or a transcript: "chris" is "Chris". */
export function saidName(said: string): string {
  return said
    .split(' ')
    .map((word, index) => (index > 0 && LOWER_IN_NAMES.has(word) ? word : capitalise(word)))
    .join(' ');
}

/** A spoken possessive: "Chris Coulter's". */
function possessive(name: string): string {
  return `${bare(name)}'s`;
}

/** What a list holds, for counts outside its lead: people when choosing a person, otherwise issues. */
function listNoun(source: ListSource, count: number): string {
  if (source.kind === 'people') return count === 1 ? 'person' : 'people';
  if (source.kind === 'places') return count === 1 ? 'place' : 'places';
  return count === 1 ? 'issue' : 'issues';
}

/**
 * How to hear a list again, as the end of a sentence: "Say 'my issues' to hear it again." A list of people whose name
 * was not echoed (it was login-shaped, review F1) asks for the name again instead of repeating it.
 */
function hearAgain(source: ListSource, what: string): string {
  if (source.kind === 'people' && source.said === '') return `Say 'issues for' and the name to hear ${what} again.`;
  return `Say '${listCommand(source)}' to hear ${what} again.`;
}

/** What to say to hear a list again. Matches a catalogue phrasing, so saying it works. */
export function listCommand(source: ListSource): string {
  if (source.kind === 'find') return `find ${source.words}`;
  if (source.kind === 'places') return `air quality in ${saidName(source.said)}`;
  if (source.kind === 'assignee') return `issues for ${bare(source.name)}`;
  if (source.kind === 'people') return `issues for ${saidName(source.said)}`;
  switch (source.scope) {
    case 'mine':
      return 'my issues';
    case 'in-progress':
      return 'in progress issues';
    case 'open':
      return 'open issues';
    case 'recent':
      return 'recent issues';
    default:
      return 'my issues';
  }
}

function listLabel(source: ListSource): string {
  if (source.kind === 'find') return `the matches for ${source.words}`;
  if (source.kind === 'places') return `the places called ${saidName(source.said)}`;
  if (source.kind === 'assignee') return `${possessive(source.name)} issues`;
  if (source.kind === 'people')
    return source.said === '' ? 'the people who match that name' : `the people who match ${saidName(source.said)}`;
  switch (source.scope) {
    case 'mine':
      return 'your issues';
    case 'in-progress':
      return 'your issues in progress';
    case 'open':
      return 'the open issues';
    case 'recent':
      return 'the recent issues';
    default:
      return 'your issues';
  }
}

function listCardTitle(source: ListSource): string {
  if (source.kind === 'find') return 'Matches';
  if (source.kind === 'assignee') return `${possessive(source.name)} issues`;
  if (source.kind === 'people') return 'Which person?';
  if (source.kind === 'places') return 'Which place?';
  switch (source.scope) {
    case 'mine':
      return 'Your issues';
    case 'in-progress':
      return 'In progress';
    case 'open':
      return 'Open issues';
    case 'recent':
      return 'Recent issues';
    default:
      return CARD_TITLE;
  }
}

export function listCount(source: ListSource, count: number, complete: boolean): string {
  if (source.kind === 'find') {
    if (count === 0) return 'No issues match.';
    const matches = count === 1 ? 'issue matches' : 'issues match';
    return complete ? `${count} ${matches}.` : `At least ${count} ${matches}.`;
  }
  if (source.kind === 'assignee') {
    const name = bare(source.name);
    return count === 0 ? `${name} has no issues.` : `${name} has ${atLeast(count, complete, 'issue', 'issues')}.`;
  }
  if (source.kind === 'places') return `${plural(count, 'place is', 'places are')} called ${saidName(source.said)}.`;
  if (source.kind === 'people') {
    const matches = count === 1 ? 'person matches' : 'people match';
    const who = source.said === '' ? 'that name' : saidName(source.said);
    return complete ? `${count} ${matches} ${who}.` : `At least ${count} ${matches} ${who}.`;
  }
  switch (source.scope) {
    case 'mine':
      return count === 0 ? 'You have no issues.' : `You have ${atLeast(count, complete, 'issue', 'issues')}.`;
    case 'in-progress':
      return count === 0
        ? 'You have no issues in progress.'
        : `You have ${atLeast(count, complete, 'issue', 'issues')} in progress.`;
    case 'open':
      if (count === 0) return 'There are no open issues.';
      return `There ${count === 1 ? 'is' : 'are'} ${atLeast(count, complete, 'open issue', 'open issues')}.`;
    case 'recent':
      if (count === 0) return 'There are no issues.';
      return count === 1
        ? 'Here is the most recently updated issue.'
        : `Here are the ${count} most recently updated issues.`;
    default:
      return `${plural(count, 'issue', 'issues')}.`;
  }
}

export function listItemBody(item: WorkingSetItem, verbosity: Verbosity): string {
  const state = verbosity !== 'brief' && item.state !== null ? ` ${sentence(item.state)}` : '';
  return `${sentence(item.summary)}${state}`;
}

/** The label before a list item's text: "One: ", or "One, continued: " for the rest of a long one. */
export function listItemLabel(position: number, continued: boolean): string {
  return continued ? `${numberLabel(position)}, continued: ` : `${numberLabel(position)}: `;
}

export interface ListPageInput {
  source: ListSource;
  /** Items in the working set. */
  total: number;
  complete: boolean;
  /** The pieces on this page, already labelled. */
  segments: readonly SpeechSegment[];
  /** Whether this page starts at the top of the list. */
  first: boolean;
  /** First and last item numbers on the page. */
  from: number;
  to: number;
  /** Items after this page, not counting one the page stopped part-way through. */
  remaining: number;
  /** The page stops part-way through item `to`. */
  midItem: boolean;
}

/** The sentence that ends a capped list: never "End of the list", because there are more the tracker didn't give. */
function firstOnly(total: number): string {
  return `That's the first ${total === 1 ? 'one' : total}. Say 'find' and some words to narrow it down.`;
}

/** The sentence that ends a list of people to choose from: which to say next, and whether there may be others. */
function choosePerson(complete: boolean): string {
  const pick = 'Say the number of the one you mean.';
  return complete ? pick : `There may be others with that name. ${pick}`;
}

export function listPage(input: ListPageInput): Reply {
  const {source, total, complete, first, from, to, remaining, midItem} = input;
  const segments: SpeechSegment[] = [];
  if (first) {
    segments.push(say(listCount(source, total, complete), 'short'));
  } else {
    const of = complete ? `${total}` : `at least ${total}`;
    segments.push(say(from === to ? `Issue ${from} of ${of}.` : `Issues ${from} to ${to} of ${of}.`, 'short'));
  }
  segments.push(...input.segments);

  let earcon: Earcon | undefined;
  const choosing = source.kind === 'people' || source.kind === 'places';
  if (midItem) {
    segments.push(say(`Number ${to} goes on. Say 'more' to hear the rest.`));
  } else if (remaining > 0) {
    segments.push(say(`${complete ? remaining : `At least ${remaining}`} more. Say 'more' to hear them.`));
  } else if (choosing && total > 0) {
    segments.push(say(choosePerson(complete)));
    if (!first) earcon = 'endOfList';
  } else if (total > 0 && !complete) {
    segments.push(say(firstOnly(total)));
  } else if (total > 0 && !first) {
    segments.push(say('End of the list.'));
    earcon = 'endOfList';
  }
  return {
    segments,
    earcon,
    listen: true,
    reprompt:
      total === 0
        ? REPROMPT_DEFAULT
        : remaining > 0 || midItem
          ? REPROMPT_LIST_MORE
          : choosing
            ? REPROMPT_PERSON
            : REPROMPT_LIST,
    cardTitle: listCardTitle(source),
  };
}

export function endOfList(source: ListSource, complete: boolean, total: number): Reply {
  if (source.kind === 'people' || source.kind === 'places') {
    return {segments: [say(choosePerson(complete))], listen: true, reprompt: REPROMPT_PERSON};
  }
  if (!complete) return {segments: [say(firstOnly(total))], listen: true, reprompt: REPROMPT_LIST};
  return {segments: [say('End of the list.')], earcon: 'endOfList', listen: true, reprompt: REPROMPT_LIST};
}

export function startOfList(): Reply {
  return {segments: [say("That's the start of the list.")], listen: true, reprompt: REPROMPT_LIST_MORE};
}

export function noList(): Reply {
  return {
    segments: [say("There's no list yet. Say 'my issues' to hear one.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** Design rule 1: an expired list is refused with the way back, never guessed. */
export function listExpired(source: ListSource): Reply {
  return {
    segments: [say(`That list has expired. ${hearAgain(source, 'it')}`)],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function whichNumber(): Reply {
  return {
    segments: [say("Which one? Say 'open' and a number, like 'open one'.")],
    listen: true,
    reprompt: REPROMPT_LIST,
  };
}

export function noSuchNumber(position: number, total: number, complete: boolean, source: ListSource): Reply {
  let text: string;
  if (total === 0) {
    text = `There's no number ${position}. The list is empty.`;
  } else if (complete) {
    text = `There's no number ${position}. The list has ${total}.`;
  } else {
    text = `There's no number ${position}. I only have the first ${total} ${listNoun(source, total)}.`;
  }
  const reprompt = source.kind === 'people' || source.kind === 'places' ? REPROMPT_PERSON : REPROMPT_LIST;
  return {segments: [say(text)], earcon: 'failure', listen: true, reprompt};
}

/**
 * A name that matched nobody (YA-35) leaves the listener where they were, and says so. When the people were not all
 * there to match, because the tracker capped them or some have no name that can be said, "nobody" would not be true,
 * so one sentence says only what is known (review F3).
 */
export function nobodyCalled(said: string, complete: boolean, stillIn: ListSource | null): Reply {
  // An empty `said` was login-shaped, so it is not repeated back.
  const who = said === '' ? 'by that name' : `called ${saidName(said)}`;
  const text = complete
    ? `Nobody ${who} has open issues in this project.`
    : `I couldn't find anyone ${who}, but I can't name everyone in this project.`;
  const segments = [say(text, 'short')];
  if (stillIn !== null) segments.push(say(`You're still in ${listLabel(stillIn)}.`));
  return {segments, earcon: 'failure', listen: true, reprompt: REPROMPT_DEFAULT};
}

/** One close match, confirmed by name before anything is read (review F4). */
export function didYouMean(name: string): Reply {
  return {
    segments: [say(`Did you mean ${bare(name)}?`)],
    listen: true,
    reprompt: REPROMPT_YES_NO,
    cardTitle: 'Which person?',
  };
}

/** "No" to "Did you mean ...?". */
export function notThatPerson(): Reply {
  return {
    segments: [say("OK. Say 'issues for' and the name again.")],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** A closed or resolved list was asked for; the voice client reads open issues only. */
export function onlyOpenIssues(): Reply {
  return {
    segments: [say("I can only list open issues. Say 'open issues' to hear them.")],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** "Issues for" with no name heard. */
export function whoseIssues(): Reply {
  return {
    segments: [say("Whose issues? Say 'issues for' and a name, like 'issues for Sam'.")],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** A search with no matches leaves the person where they were, and says so. */
export function noMatches(stillIn: ListSource | null): Reply {
  const segments = [say('No issues match.', 'short')];
  if (stillIn !== null) segments.push(say(`You're still in ${listLabel(stillIn)}.`));
  return {segments, listen: true, reprompt: REPROMPT_DEFAULT};
}

// ---------------------------------------------------------------------------------------------------------------
// Opening an issue.

export interface OpenedInput {
  /** Position in the working set, or null when opened by id. */
  ordinal: number | null;
  /** The id as the person spelled it, spoken letter by letter; only when opened by id. */
  spokenId: string | null;
  summary: string;
  state: string | null;
  /** The summary was too long for one response, and `summary` is its first piece. */
  summaryContinues?: boolean;
}

/** Number (or the id the person asked for) first, then the summary, then the state. */
export function openedSegments(input: OpenedInput): SpeechSegment[] {
  const lead = input.ordinal !== null ? `Number ${input.ordinal}.` : `Issue ${input.spokenId ?? ''}.`;
  return [
    say(lead, 'short'),
    say(sentence(input.summary), 'short'),
    ...(input.summaryContinues ? [say("The title goes on. Say 'summary' to hear all of it.", 'short')] : []),
    say(input.state === null ? 'No state.' : sentence(input.state), 'short'),
    say("Say 'description', 'comments', or 'fields'."),
  ];
}

export function opened(input: OpenedInput): Reply {
  return {segments: openedSegments(input), earcon: 'success', listen: true, reprompt: REPROMPT_ISSUE};
}

/** A search with exactly one match opens it: the count, then the issue. */
export function foundOne(input: OpenedInput): Reply {
  return {
    segments: [say(listCount({kind: 'find', words: ''}, 1, true), 'short'), ...openedSegments(input)],
    earcon: 'success',
    listen: true,
    reprompt: REPROMPT_ISSUE,
  };
}

export function issueGone(position: number, source: ListSource): Reply {
  return {
    segments: [say(`Number ${position} isn't there any more. ${hearAgain(source, 'the list')}`)],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function openIssueGone(): Reply {
  return {
    segments: [say("That issue isn't there any more. Say 'my issues' to hear your list.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

/** An id that began with a filler, not found, with no list whose number it could have been. */
export function idNotFoundNoList(spokenId: string): Reply {
  return {
    segments: [say(`I heard ${spokenId}, but there's no issue with that id. Say 'my issues' to hear a list.`)],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function idNotFound(spokenId: string): Reply {
  return {
    segments: [say(`I heard ${spokenId}, but there's no issue with that id.`)],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function badId(): Reply {
  return {
    segments: [
      say("I couldn't make an id out of that. Spell the letters, then the number, like 'yankee alpha one three'."),
    ],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function findWhat(): Reply {
  return {
    segments: [say("What should I look for? Say 'find' and some words from the title.")],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function noIssueOpen(): Reply {
  return {
    segments: [say("No issue is open. Say 'open' and a number first.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_LIST,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading parts.

export function paragraphHeader(position: number, total: number, continued: boolean): string {
  return continued ? `Paragraph ${position} of ${total}, continued.` : `Paragraph ${position} of ${total}.`;
}

export function commentHeader(
  position: number,
  total: number,
  complete: boolean,
  author: string,
  created: number,
  now: number,
  continued: boolean,
  timeZone?: string,
): string {
  const of = complete ? `${total}` : `at least ${total}`;
  if (continued) return total === 1 && complete ? 'Comment, continued.' : `Comment ${position} of ${of}, continued.`;
  const from = `from ${bare(author)}, ${whenWords(created, now, timeZone)}`;
  return total === 1 && complete ? `${capitalise(from)}.` : `Comment ${position} of ${of}, ${from}.`;
}

export function summaryPiece(text: string, continued: boolean): SpeechSegment[] {
  return [say(continued ? `Summary, continued: ${text}` : `Summary: ${text}`)];
}

export interface FieldsInput {
  state: string | null;
  /** Whether the issue has an assignee at all. */
  assigned: boolean;
  /** The assignee's speakable name; null when assigned to someone with no name that can be said (review F1). */
  assignee: string | null;
  subsystem: string | null;
  updated: number;
  now: number;
  timeZone?: string;
}

export function fieldsUnit(input: FieldsInput): SpeechSegment[] {
  const segments = [
    say(input.state === null ? 'No state.' : `State: ${sentence(input.state)}`, 'short'),
    say(
      !input.assigned
        ? 'Unassigned.'
        : input.assignee === null
          ? `Assigned to ${NO_NAME_WORDS}.`
          : `Assigned to ${sentence(input.assignee)}`,
      'short',
    ),
  ];
  if (input.subsystem !== null) segments.push(say(`Subsystem: ${sentence(input.subsystem)}`, 'short'));
  segments.push(say(`Updated ${whenWords(input.updated, input.now, input.timeZone)}.`));
  return segments;
}

export interface PartPageInput {
  part: Part;
  /** Units on this page, each already carrying its own header. */
  units: readonly (readonly SpeechSegment[])[];
  first: boolean;
  last: boolean;
  /** Paragraphs or comments in the whole part. */
  total: number;
  complete: boolean;
}

export function partPage(input: PartPageInput): Reply {
  const segments: SpeechSegment[] = [];
  if (input.first && input.part === 'description') {
    segments.push(say(input.total === 1 ? 'Description.' : `Description, ${input.total} paragraphs.`, 'short'));
  }
  if (input.first && input.part === 'comments') {
    segments.push(say(`${capitalise(atLeast(input.total, input.complete, 'comment', 'comments'))}.`, 'short'));
  }
  for (const unit of input.units) segments.push(...unit);

  const paged = input.part === 'description' || input.part === 'comments';
  let earcon: Earcon | undefined;
  let reprompt = REPROMPT_ISSUE;
  if (paged && input.last) {
    const end = endOfPart(input.part, input.complete, input.total);
    segments.push(...end.segments);
    earcon = end.earcon;
  } else if (!input.last) {
    if (input.first) segments.push(say("Say 'more' to go on."));
    reprompt = REPROMPT_MORE;
  }
  return {segments, earcon, listen: true, reprompt};
}

export function emptyPart(part: Part): Reply {
  const text = part === 'comments' ? 'This issue has no comments.' : `This issue has no ${partName(part)}.`;
  return {segments: [say(text)], listen: true, reprompt: REPROMPT_ISSUE};
}

export function endOfPart(part: Part, complete: boolean, total: number): Reply {
  if (!complete) {
    // Only comments can be capped. A capped part is never "the end": there are more the tracker did not give.
    const text = total === 1 ? "That's the first comment." : `That's the first ${total} comments.`;
    return {segments: [say(text)], listen: true, reprompt: REPROMPT_ISSUE};
  }
  return {
    segments: [say(`End of the ${partName(part)}.`)],
    earcon: 'endOfList',
    listen: true,
    reprompt: REPROMPT_ISSUE,
  };
}

export function startOfPart(part: Part | null): Reply {
  const text = part === null ? "That's the start of this issue." : `That's the start of the ${partName(part)}.`;
  return {segments: [say(text)], listen: true, reprompt: part === null ? REPROMPT_ISSUE : REPROMPT_MORE};
}

export function nothingToContinue(): Reply {
  return {
    segments: [say("There's nothing to go on with. Say 'my issues' to start.")],
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function nothingToRepeat(): Reply {
  return {segments: [say("There's nothing to repeat yet.")], listen: true, reprompt: REPROMPT_DEFAULT};
}

// ---------------------------------------------------------------------------------------------------------------
// Orientation (design rule 5).

export interface WhereInput {
  list: {
    source: ListSource;
    total: number;
    complete: boolean;
    expired: boolean;
    heard: {from: number; to: number} | null;
  } | null;
  issue: {ordinal: number | null; summary: string; part: Part | null; progress: Progress | null} | null;
}

/** Said in place of a person who has no name that can be spoken (never their login or email). */
export const NO_NAME_WORDS = 'someone without a name in the tracker';

/** Appended to a summary cut short in a sentence that has to stay within one response. */
export const TITLE_CUT_WORDS = ', and so on';

export function where(input: WhereInput): Reply {
  const segments: SpeechSegment[] = [];
  if (input.list !== null) {
    const {source, total, complete, expired, heard} = input.list;
    if (expired) {
      segments.push(say(`Your last list has expired. ${hearAgain(source, 'it')}`, 'short'));
    } else {
      const noun = atLeast(total, complete, listNoun(source, 1), listNoun(source, 2));
      segments.push(say(`You're in ${listLabel(source)}, ${noun}.`, 'short'));
      if (heard !== null && total > 0) {
        segments.push(
          say(
            heard.from === heard.to
              ? `You last heard number ${heard.from}.`
              : `You last heard ${heard.from} to ${heard.to}.`,
            'short',
          ),
        );
      }
    }
  }
  if (input.issue !== null) {
    const {ordinal, summary, part, progress} = input.issue;
    segments.push(
      say(ordinal === null ? `Issue: ${sentence(summary)}` : `Issue number ${ordinal}: ${sentence(summary)}`, 'short'),
    );
    if (part === null) {
      segments.push(say('Nothing read from it yet.'));
    } else if (progress !== null && part === 'description') {
      segments.push(say(`Reading the description, paragraph ${progress.current} of ${progress.total}.`));
    } else if (progress !== null && part === 'comments') {
      const of = progress.complete ? `${progress.total}` : `at least ${progress.total}`;
      segments.push(say(`Reading the comments, comment ${progress.current} of ${of}.`));
    } else {
      segments.push(say(`Reading the ${partName(part)}.`));
    }
  }
  if (segments.length === 0) segments.push(say("You're at the start. Say 'my issues' to hear your list."));
  return {segments, listen: true, reprompt: REPROMPT_DEFAULT};
}

// ---------------------------------------------------------------------------------------------------------------
// Preferences.

export function verbositySet(level: Verbosity): Reply {
  return {
    segments: [say(`${capitalise(level)} answers.`)],
    earcon: 'success',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function whichVerbosity(): Reply {
  return {segments: [say("Say 'brief', 'normal', or 'full'.")], listen: true, reprompt: REPROMPT_DEFAULT};
}

export function rateSet(percent: number): Reply {
  return {segments: [say(`Speed ${percent} percent.`)], earcon: 'success', listen: true, reprompt: REPROMPT_DEFAULT};
}

export function rateLimit(percent: number, faster: boolean): Reply {
  return {
    segments: [say(`That's as ${faster ? 'fast' : 'slow'} as I go: ${percent} percent.`)],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}

export function whichRate(): Reply {
  return {segments: [say("Say 'faster', 'slower', or 'normal speed'.")], listen: true, reprompt: REPROMPT_DEFAULT};
}

// ---------------------------------------------------------------------------------------------------------------
// Air quality (YA-36). The same sentence shapes every time: where and the category first, then the number and how
// much it rests on, then at most one line of advice. Never coordinates, sensor ids, a sensor's own name or an address.

/** Where a figure is for, as the core knows it: the device's postal code, home, or what the person said. */
/**
 * Where a figure is for, as the core knows it: the device (said "near you", never its postal code, review P3), home,
 * a place (by the geocoder's place name when it gave one, otherwise as said), or a sensor as said.
 */
export type AirWhere =
  | {kind: 'home'}
  | {kind: 'indoor'}
  | {kind: 'device'}
  | {kind: 'place'; said: string; name?: string}
  | {kind: 'sensor'; said: string};

export interface AirReadingInput {
  lowConfidence?: boolean;
  where: AirWhere;
  aqi: number;
  category: AqiCategory;
  sensors: number;
  sources?: Readonly<Partial<Record<import('./types.ts').AirSensorSource, number>>>;
  averaging?: '10-minute average';
  fewSensors: boolean;
  radiusKm: number;
  distanceMetres?: number;
  ageMinutes: number;
  disagreement?: {highAqi: number; highSensors: number; lowAqi: number; lowSensors: number};
}

const REPROMPT_AIR: SpeechSegment[] = [say("Say 'air quality in' and a town, or 'stop'.")];

/** The EPA category names, as said. */
const AQI_CATEGORY_WORDS: Readonly<Record<AqiCategory, string>> = {
  good: 'Good',
  moderate: 'Moderate',
  unhealthyForSensitiveGroups: 'Unhealthy for sensitive groups',
  unhealthy: 'Unhealthy',
  veryUnhealthy: 'Very unhealthy',
  hazardous: 'Hazardous',
};

/**
 * One sentence of advice per category above Good, from the EPA's PM2.5 cautionary statements: Technical Assistance
 * Document for the Reporting of Daily Air Quality, EPA-403/B-26-003, May 2026, Table 5, PM2.5 column, with the
 * sensitive groups of Table 4 ("People with heart or lung disease; older adults; and children, including teenagers")
 * (https://document.airnow.gov/technical-assistance-document-for-the-reporting-of-daily-air-quailty.pdf, checked
 * 2026-09-14). Table 5 says:
 * - Moderate: "Unusually sensitive people: Consider making outdoor activities shorter and less intense. Go inside if
 *   you have symptoms such as coughing or shortness of breath."
 * - Unhealthy for Sensitive Groups: "Sensitive groups: Make outdoor activities shorter and less intense. It's OK to be
 *   active outdoors but take more breaks."
 * - Unhealthy: "Sensitive groups: Consider rescheduling or moving all activities inside. Go inside if you have
 *   symptoms. ... Everyone else: Keep outdoor activities shorter and less intense."
 * - Very Unhealthy: "Sensitive groups: Avoid all physical activity outdoors. ... Everyone else: Limit outdoor physical
 *   activity. Go indoors if you have symptoms."
 * - Hazardous: "Sensitive groups: Stay indoors and keep activity levels light. ... Everyone: Avoid all physical
 *   activity outdoors."
 * Each line below keeps the first instruction for each group, in one sentence.
 */
const AQI_ADVICE: Readonly<Record<AqiCategory, string | null>> = {
  good: null,
  moderate: 'Unusually sensitive people should consider making outdoor activities shorter and less intense.',
  unhealthyForSensitiveGroups:
    'People with heart or lung disease, older adults, children and teenagers should make outdoor activities shorter and less intense.',
  unhealthy:
    'Sensitive groups should consider moving all activities inside, and everyone else should keep outdoor activities shorter and less intense.',
  veryUnhealthy:
    'Sensitive groups should avoid all physical activity outdoors, and everyone else should limit outdoor physical activity.',
  hazardous:
    'Everyone should avoid all physical activity outdoors, and sensitive groups should stay indoors and keep activity light.',
};

/**
 * Words a recogniser uses to say a number ("forty six point eight seven minus one one three"). A place said mostly in
 * these is numbers, which could be coordinates, and is never echoed (review P3).
 */
const NUMBER_WORDS_IN_PLACES: ReadonlySet<string> = new Set([
  ...NUMBER_WORDS,
  ...TENS_WORDS.filter((word) => word !== ''),
  'oh',
  'hundred',
  'thousand',
  'minus',
  'negative',
  'point',
  'dot',
  'comma',
  'degrees',
  'degree',
  'north',
  'south',
  'east',
  'west',
  'by',
]);

/** The most words of a spoken place echoed back. */
const MAX_PLACE_WORDS = 6;

/** A postal code read a character at a time, groups apart: "59802" is "5 9 8 0 2", "sw1a 1aa" is "S W 1 A, 1 A A". */
export function spokenPostalCode(postalCode: string): string {
  return postalCode
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((group) => group !== '')
    .map((group) => group.split('').join(' '))
    .join(', ');
}

/**
 * A place as the person said it, safe to echo: a postal code (digits only, or digits in one short group) is read a
 * character at a time; words with a house number in them are never echoed ("that address"), and nor are bare numbers
 * that are not a postal code, which could be coordinates ("that place").
 */
export function spokenPlace(said: string): string {
  const words = said.split(' ').filter((word) => word !== '');
  const numberWords = words.filter((word) => NUMBER_WORDS_IN_PLACES.has(word.toLowerCase().replace(/[.,]+$/, '')));
  if (numberWords.length >= 2 && numberWords.length * 2 >= words.length) return 'that place';
  const digitWords = words.filter((word) => /\d/.test(word));
  const letterWords = words.filter(
    (word) => /\p{L}/u.test(word) && !/\d/.test(word) && !NUMBER_WORDS_IN_PLACES.has(word.toLowerCase()),
  );
  if (digitWords.length === 0 && letterWords.length > 0) return saidName(words.slice(0, MAX_PLACE_WORDS).join(' '));
  if (words.length === 1 && /^\d{5}$/.test(words[0])) return spokenPostalCode(words[0]);
  if (letterWords.length > 0 && digitWords.length > 0) return 'that address';
  return 'that place';
}

/**
 * A place name from the geocoder, as it may be spoken: letters, digits, spaces and ,.'- only, and a postal code at its
 * start read a character at a time ("59802, Montana" is "5 9 8 0 2, Montana").
 */
function placeName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} .,'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const [first, ...rest] = cleaned.split(',');
  if (!/^[\d\s-]+$/.test(first.trim())) return cleaned;
  return [spokenPostalCode(first), ...rest.map((part) => part.trim())].join(', ');
}

/** "at home", "near you", "near Missoula", "near Portland, Oregon", "at the sensor called Rattlesnake Creek". */
function airAt(where: AirWhere): string {
  switch (where.kind) {
    case 'home':
      return 'at home';
    case 'indoor':
      return 'inside';
    case 'device':
      return 'near you';
    case 'place':
      return `near ${where.name === undefined ? spokenPlace(where.said) : placeName(where.name)}`;
    case 'sensor':
      return `at the sensor called ${spokenPlace(where.said)}`;
    default:
      return 'there';
  }
}

/** The place itself, after "of": "home", "you", "Missoula". */
function airPlaceName(where: AirWhere): string {
  switch (where.kind) {
    case 'home':
      return 'home';
    case 'indoor':
      return 'inside';
    case 'device':
      return 'you';
    case 'place':
      return where.name === undefined ? spokenPlace(where.said) : placeName(where.name);
    default:
      return spokenPlace(where.said);
  }
}

function minutesAgo(minutes: number): string {
  if (minutes <= 0) return 'updated just now';
  return `updated ${plural(minutes, 'minute', 'minutes')} ago`;
}

export function airReading(input: AirReadingInput): Reply {
  const sourceParts = Object.entries(input.sources ?? {}).filter((entry): entry is [string, number] => entry[1] > 0);
  const sourceSummary =
    sourceParts.length === 0
      ? plural(input.sensors, 'sensor', 'sensors')
      : sourceParts.map(([source, count]) => plural(count, `${source} sensor`, `${source} sensors`)).join(' and ');
  const from =
    input.sensors === 1 && input.averaging !== undefined
      ? `from a ${input.averaging} from ${sourceSummary}${
          input.distanceMetres === undefined
            ? input.radiusKm > 0
              ? ` within ${plural(input.radiusKm, 'kilometre', 'kilometres')}`
              : ''
            : `, ${plural(input.distanceMetres, 'metre', 'metres')} away`
        }`
      : input.radiusKm > 0
        ? `from ${sourceSummary} within ${plural(input.radiusKm, 'kilometre', 'kilometres')}`
        : `from ${sourceSummary}`;
  const segments = [say(`Air quality ${airAt(input.where)} is ${AQI_CATEGORY_WORDS[input.category]}.`, 'short')];
  const split = input.disagreement;
  if (split !== undefined) {
    // Recheck N1: neither group is picked silently. The higher one leads, and both are said.
    const others = split.lowSensors === 1 ? '1 other' : `${split.lowSensors} others`;
    segments.push(
      say(
        `Readings nearby disagree: AQI ${split.highAqi} from ${plural(split.highSensors, 'sensor', 'sensors')}, and AQI ${split.lowAqi} from ${others}, ${minutesAgo(input.ageMinutes)}.`,
        'short',
      ),
      say('Take it as a rough guide.', 'short'),
    );
  } else {
    segments.push(say(`AQI ${input.aqi}, ${from}, ${minutesAgo(input.ageMinutes)}.`, 'short'));
    if (input.fewSensors) segments.push(say('With so few sensors, take it as a rough guide.', 'short'));
  }
  const advice = AQI_ADVICE[input.category];
  if (input.lowConfidence)
    segments.push(say('This sensor reports low confidence. Treat this reading as uncertain.', 'short'));
  if (advice !== null) segments.push(say(advice));
  return {segments, listen: true, reprompt: REPROMPT_AIR};
}

export function airStale(where: AirWhere, ageMinutes: number): Reply {
  return {
    segments: [
      say(`The newest reading ${airAt(where)} is ${plural(ageMinutes, 'minute', 'minutes')} old.`, 'short'),
      say("That's too old to give a current reading."),
    ],
    listen: true,
    reprompt: REPROMPT_AIR,
  };
}

export function airNoSensors(where: AirWhere, radiusKm: number): Reply {
  if (where.kind === 'indoor') {
    return {
      segments: [say('The indoor sensor has no current reading I can use.', 'short')],
      listen: true,
      reprompt: REPROMPT_AIR,
    };
  }
  return {
    segments: [
      say(
        `No outdoor sensors are reporting within ${plural(radiusKm, 'kilometre', 'kilometres')} of ${airPlaceName(where)}.`,
      ),
    ],
    listen: true,
    reprompt: REPROMPT_AIR,
  };
}

export function airSensorNoReading(said: string): Reply {
  return {
    segments: [say(`The sensor called ${spokenPlace(said)} has no reading I can use right now.`)],
    listen: true,
    reprompt: REPROMPT_AIR,
  };
}

export function airNotFound(said: string): Reply {
  return {
    segments: [
      say(`I couldn't find a place or a sensor called ${spokenPlace(said)}.`, 'short'),
      say('Try the nearest town, or a postal code.'),
    ],
    listen: true,
    reprompt: REPROMPT_AIR,
  };
}

export function airNoLocation(): Reply {
  return {
    segments: [
      say("I don't know where this device is.", 'short'),
      say("Say 'air quality in' and a town, or allow this skill to use the device's postal code."),
    ],
    listen: true,
    reprompt: REPROMPT_AIR,
  };
}

/** A choice between places of one name (review C3). The numbers follow the order the places are said in. */
export function airWhichPlace(names: readonly string[]): Reply {
  const spoken = names.map(placeName);
  const list =
    spoken.length === 2
      ? `${spoken[0]}, or ${spoken[1]}`
      : `${spoken.slice(0, -1).join(', ')}, or ${spoken[spoken.length - 1]}`;
  const numbers = spoken.length === 2 ? "'one' or 'two'" : "'one', 'two' or 'three'";
  return {
    segments: [say(`Did you mean ${list}?`, 'short'), say(`Say ${numbers}.`)],
    listen: true,
    reprompt: [say(`Say ${numbers}, or 'air quality in' and the place with its state.`)],
    cardTitle: 'Which place?',
  };
}

/** Too many lookups lately, from this speaker or in all, or a spending budget is used up (review S-P2). */
export function airBusy(): Reply {
  return {
    segments: [say("I've checked the air a lot just now. Try again in a few minutes.")],
    earcon: 'failure',
    listen: false,
  };
}

export function airUnavailable(): Reply {
  return {
    segments: [say("I couldn't reach the air sensors. Try again in a moment.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_AIR,
  };
}

export function airNotSetUp(): Reply {
  return {
    segments: [say("Air quality isn't set up for this skill.")],
    earcon: 'failure',
    listen: true,
    reprompt: REPROMPT_DEFAULT,
  };
}
