/**
 * The voice client's intent catalogue (YA-13). Plain data: the text grammar (`grammar.ts`) and the Alexa interaction
 * model (YA-14) are both generated from this file, so they cannot drift apart.
 *
 * Rules for editing it:
 * - Samples are lower case, with no digits and no punctuation except an apostrophe, because Alexa refuses both. An
 *   acronym is written as its letters, each followed by a period ("a. q. i."), which is how Amazon asks for one.
 * - A sample with a `phrase` slot holds carrier words and that one slot only (AMAZON.SearchQuery's rule). Only a
 *   phrase slot may be possessive (`{person}'s`); the text grammar then requires the "'s", and the Alexa model drops it.
 * - The same sample never appears under two intents, and never twice under one (a test checks both).
 * - Enum slots list canonical values in `values`; the words people actually say for each value live in
 *   `SLOT_SYNONYMS`, which an interaction model uses as slot-value synonyms. The text grammar accepts exactly the
 *   synonyms, so a canonical value that should be spoken is listed there too. The rate's `normal` is deliberately
 *   not: said alone, "normal" means normal answers, and the speed is "normal speed".
 */
import type {IntentSpec} from './types.ts';
import {airQualitySamples, type AirLocale} from './air-phrases.ts';

const LIST_SCOPES = ['mine', 'in-progress', 'open', 'recent'] as const;
const PARTS = ['summary', 'description', 'comments', 'fields'] as const;
const LEVELS = ['brief', 'normal', 'full'] as const;
const RATES = ['slower', 'faster', 'normal'] as const;

const BASE_CATALOGUE: readonly IntentSpec[] = [
  // Stage 1: reading.
  {
    name: 'list',
    stage: 1,
    slots: [
      {name: 'scope', kind: 'enum', values: LIST_SCOPES},
      // Someone's name as spoken (YA-35). A phrase (AMAZON.SearchQuery), so "the household" and full names are heard
      // whole. The Alexa model writes a possessive "{person}'s issues" as "{person} issues", as Amazon asks.
      {name: 'person', kind: 'phrase'},
    ],
    samples: [
      'my issues',
      'list my issues',
      'read my issues',
      'what are my issues',
      'what issues do i have',
      "what's on my list",
      "what's assigned to me",
      'what am i working on',
      'list issues',
      'issues',
      '{scope} issues',
      'list {scope} issues',
      'read {scope} issues',
      'read me {scope} issues',
      'what are {scope} issues',
      "what's {scope}",
      'show {scope} issues',
      'list the {scope} ones',
      "what's assigned to {person}",
      "{person}'s issues",
      "show me {person}'s issues",
      'issues for {person}',
      'issues assigned to {person}',
      'what does {person} have',
      "what's {person} working on",
    ],
  },
  {
    name: 'find',
    stage: 1,
    slots: [{name: 'words', kind: 'phrase'}],
    samples: [
      'find',
      'search',
      'find {words}',
      'search for {words}',
      'search {words}',
      'look for {words}',
      'find issues about {words}',
      'find the one about {words}',
      'open the one about {words}',
      'the one about {words}',
      'which issue is about {words}',
      'is there an issue about {words}',
    ],
  },
  {
    name: 'open',
    stage: 1,
    slots: [{name: 'ordinal', kind: 'ordinal'}],
    samples: [
      'open {ordinal}',
      'open number {ordinal}',
      'number {ordinal}',
      '{ordinal}',
      'go to {ordinal}',
      'go to number {ordinal}',
      'tell me about {ordinal}',
      'tell me about number {ordinal}',
      'read {ordinal}',
      'read number {ordinal}',
      'pick {ordinal}',
      'choose {ordinal}',
      'select {ordinal}',
      "what's number {ordinal}",
    ],
  },
  {
    name: 'openById',
    stage: 1,
    slots: [{name: 'spelled', kind: 'spelled'}],
    samples: [
      'open issue {spelled}',
      'issue {spelled}',
      'open id {spelled}',
      'go to issue {spelled}',
      'find issue {spelled}',
      'spell {spelled}',
      'the id is {spelled}',
      'open the issue spelled {spelled}',
    ],
  },
  {
    name: 'read',
    stage: 1,
    slots: [{name: 'part', kind: 'enum', values: PARTS}],
    samples: [
      '{part}',
      'read the {part}',
      'read {part}',
      'read me the {part}',
      "what's the {part}",
      'what are the {part}',
      'tell me the {part}',
      'go to the {part}',
      'any {part}',
      'read it',
      'read this one',
      "what's it about",
    ],
  },
  {
    name: 'more',
    stage: 1,
    slots: [],
    samples: [
      'more',
      'tell me more',
      'next',
      'next page',
      'next one',
      'continue',
      'go on',
      'carry on',
      'keep going',
      'keep reading',
      'resume',
      "what's next",
    ],
  },
  {
    name: 'previous',
    stage: 1,
    slots: [],
    samples: ['previous', 'previous page', 'go back', 'back', 'back up', 'before that', 'what came before'],
  },
  {
    name: 'repeat',
    stage: 1,
    slots: [],
    samples: [
      'repeat',
      'repeat that',
      'say that again',
      'say it again',
      'again',
      'what did you say',
      'come again',
      'pardon',
      'sorry',
      'what',
    ],
  },
  {
    name: 'where',
    stage: 1,
    slots: [],
    samples: [
      'where am i',
      'where was i',
      'where are we',
      'what am i reading',
      'what issue is this',
      'which issue is this',
      'what list is this',
    ],
  },
  {
    name: 'help',
    stage: 1,
    slots: [],
    samples: [
      'help',
      'help me',
      'i need help',
      'what can i say',
      'what can i do',
      'what can you do',
      'options',
      'commands',
      'how does this work',
    ],
  },
  {
    name: 'setVerbosity',
    stage: 1,
    slots: [{name: 'level', kind: 'enum', values: LEVELS}],
    samples: [
      '{level}',
      'be {level}',
      '{level} mode',
      'switch to {level} mode',
      'use {level} mode',
      'set verbosity to {level}',
      'verbosity {level}',
      '{level} answers',
      'give me {level} answers',
      'make answers {level}',
    ],
  },
  {
    name: 'setRate',
    stage: 1,
    slots: [{name: 'rate', kind: 'enum', values: RATES}],
    samples: [
      '{rate}',
      'talk {rate}',
      'speak {rate}',
      'go {rate}',
      'set speed to {rate}',
      'set the rate to {rate}',
      'speech rate {rate}',
      'speaking speed {rate}',
    ],
  },
  {
    name: 'cancel',
    stage: 1,
    slots: [],
    samples: ['cancel', 'never mind', 'forget it', 'forget that'],
  },
  {
    name: 'stop',
    stage: 1,
    slots: [],
    samples: ['stop', 'exit', 'quit', 'goodbye', 'bye', "that's all", "i'm done", 'enough', 'shut up'],
  },

  // Air quality (YA-37): explicit home/indoor qualifiers reduce ambiguity with named-place requests.
  // These compatibility samples are supplemented by shared sentence families below.
  {
    name: 'airQuality',
    stage: 1,
    slots: [],
    samples: [
      'air quality here',
      'air quality at home',
      'air quality outside',
      'air quality around here',
      "what's the air quality here",
      "what's the air quality at home",
      "what's the air quality outside",
      "what's the air quality around here",
      "what's the air like here",
      "what's the air like at home",
      "how's the air here",
      "how's the air at home",
      "how's the air outside",
      "how's the air quality here",
      'is the air okay here',
      'is the air good here',
      'is the air okay outside',
      'how is the air here',
      'check the air quality here',
      'tell me the air quality here',
      'a. q. i. here',
      "what's the a. q. i. here",
    ],
  },
  {
    name: 'airQualityPlace',
    stage: 1,
    // SearchQuery preserves postal codes and sensor names; every sample has its carrier phrase and the one slot.
    slots: [{name: 'place', kind: 'phrase'}],
    samples: [
      'air quality in {place}',
      'air quality near {place}',
      'air quality at {place}',
      'air quality for {place}',
      "what's the air quality in {place}",
      'what the air quality is in {place}',
      'what the air quality is like in {place}',
      'what air quality is in {place}',
      "what's the air quality near {place}",
      "what's the air quality at {place}",
      "what's the air like in {place}",
      "how's the air in {place}",
      "how's the air quality in {place}",
      'is the air okay in {place}',
      "what's the a. q. i. in {place}",
      'air quality is {place}',
      'air quality {place}',
    ],
  },
  {
    name: 'airQualityIndoor',
    stage: 1,
    slots: [],
    samples: [
      'air quality inside',
      "what's the air quality inside",
      'inside air quality',
      "how's the air inside",
      'indoor air quality',
      "what's the air like indoors",
    ],
  },

  // Stage 3: writes. Declared so adapters can reserve them; the core answers "not yet" until stage 3 lands.
  {
    name: 'comment',
    stage: 3,
    slots: [{name: 'text', kind: 'phrase'}],
    samples: [
      'comment',
      'add a comment',
      'leave a comment',
      'comment {text}',
      'add a comment saying {text}',
      'reply {text}',
    ],
  },
  {
    name: 'setState',
    stage: 3,
    slots: [{name: 'state', kind: 'phrase'}],
    samples: [
      'change the state',
      'set state to {state}',
      'set status to {state}',
      'move it to {state}',
      'mark it as {state}',
      'change the state to {state}',
    ],
  },
  {
    name: 'confirm',
    stage: 3,
    slots: [],
    samples: ['yes', 'yeah', 'yep', 'correct', "that's right", 'confirm', 'do it'],
  },
  {
    name: 'deny',
    stage: 3,
    slots: [],
    samples: ['no', 'nope', "that's wrong", "don't", 'wrong'],
  },

  // Stage 4: creation and dictation.
  {
    name: 'create',
    stage: 4,
    slots: [{name: 'summary', kind: 'phrase'}],
    samples: [
      'create an issue',
      'new issue',
      'file an issue',
      'report a bug',
      'create an issue called {summary}',
      'new issue called {summary}',
      'file an issue called {summary}',
    ],
  },
  {
    name: 'dictate',
    stage: 4,
    slots: [{name: 'text', kind: 'phrase'}],
    samples: ['dictate {text}', 'write {text}', 'type {text}', 'start dictation'],
  },
  {
    name: 'finishDictation',
    stage: 4,
    slots: [],
    samples: ['finish', 'finished', 'done', "that's it", 'end dictation', 'stop dictating'],
  },
];

/** The Alexa generator selects a locale; the text grammar accepts their combined vocabulary. */
export function catalogueForLocale(locale?: AirLocale): readonly IntentSpec[] {
  return BASE_CATALOGUE.map((spec) => {
    if (spec.name !== 'airQuality' && spec.name !== 'airQualityPlace' && spec.name !== 'airQualityIndoor') return spec;
    return {...spec, samples: [...new Set([...spec.samples, ...airQualitySamples(spec.name, locale)])]};
  });
}

export const INTENT_CATALOGUE = catalogueForLocale();

/**
 * The words people say for each canonical enum value, by slot name. Adapters may also send the canonical value itself
 * too (with a hyphen read as a space). An Alexa interaction model uses these as slot-value synonyms.
 */
export const SLOT_SYNONYMS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  scope: {
    mine: ['my', 'mine', 'my open', 'assigned to me'],
    'in-progress': ['in progress', 'active', 'started', 'my active'],
    open: ['open', 'unresolved', 'all open'],
    recent: ['recent', 'recently updated', 'latest'],
  },
  part: {
    summary: ['summary', 'title', 'headline'],
    description: ['description', 'details', 'body'],
    comments: ['comments', 'discussion', 'replies'],
    fields: ['fields', 'status', 'state', 'info', 'information', 'properties'],
  },
  level: {
    brief: ['brief', 'short', 'shorter', 'terse'],
    normal: ['normal', 'medium', 'standard', 'default'],
    full: ['full', 'long', 'longer', 'detailed', 'verbose'],
  },
  rate: {
    slower: ['slower', 'slow down', 'more slowly'],
    faster: ['faster', 'speed up', 'quicker', 'more quickly'],
    normal: ['normal speed', 'default speed', 'regular speed', 'normal rate'],
  },
};
