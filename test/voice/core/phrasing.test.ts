/**
 * Every phrase the core tells a person to say must work, and do what the sentence promises (design rule 4). The test
 * renders every reply the phrasing module can build, extracts each quoted phrase, and parses it with the grammar.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseUtterance} from '../../../src/voice/core/grammar.ts';
import * as phrasing from '../../../src/voice/core/phrasing.ts';
import type {Reply} from '../../../src/voice/core/phrasing.ts';
import type {ListSource, Part} from '../../../src/voice/core/state.ts';
import type {IntentName} from '../../../src/voice/core/types.ts';

/**
 * What each quoted phrase must do. `say` completes a phrase that is only half of what is said ("'open' and a number").
 */
const PROMISES: Readonly<Record<string, {intent: IntentName; say?: string}>> = {
  'my issues': {intent: 'list'},
  'in progress issues': {intent: 'list'},
  'open issues': {intent: 'list'},
  'recent issues': {intent: 'list'},
  'find login': {intent: 'find'},
  find: {intent: 'find', say: 'find boiler'},
  open: {intent: 'open', say: 'open two'},
  'open one': {intent: 'open'},
  'yankee alpha one three': {intent: 'openById', say: 'open issue yankee alpha one three'},
  description: {intent: 'read'},
  comments: {intent: 'read'},
  fields: {intent: 'read'},
  summary: {intent: 'read'},
  more: {intent: 'more'},
  previous: {intent: 'previous'},
  repeat: {intent: 'repeat'},
  'where am I': {intent: 'where'},
  help: {intent: 'help'},
  brief: {intent: 'setVerbosity'},
  normal: {intent: 'setVerbosity'},
  full: {intent: 'setVerbosity'},
  faster: {intent: 'setRate'},
  slower: {intent: 'setRate'},
  'normal speed': {intent: 'setRate'},
  stop: {intent: 'stop'},
  'issues for': {intent: 'list', say: 'issues for Sam'},
  'issues for Sam': {intent: 'list'},
  'issues for Chris Coulter': {intent: 'list'},
  'issues for Chris': {intent: 'list'},
  'issues for Zoey': {intent: 'list'},
  one: {intent: 'open'},
  'air quality here': {intent: 'airQuality'},
  'air quality in': {intent: 'airQualityPlace', say: 'air quality in Missoula'},
  two: {intent: 'open'},
  three: {intent: 'open'},
};

const SOURCES: readonly ListSource[] = [
  {kind: 'scope', scope: 'mine'},
  {kind: 'scope', scope: 'in-progress'},
  {kind: 'scope', scope: 'open'},
  {kind: 'scope', scope: 'recent'},
  {kind: 'find', words: 'login'},
  {kind: 'assignee', login: 'ccoulter', name: 'Chris Coulter'},
  {kind: 'people', said: 'chris'},
  {kind: 'people', said: ''},
  {kind: 'people', said: 'zoey', confirming: true},
];
const mine: ListSource = {kind: 'scope', scope: 'mine'};
const people: ListSource = {kind: 'people', said: 'chris'};
const PARTS: readonly Part[] = ['summary', 'description', 'comments', 'fields'];

function everyReply(): Reply[] {
  const replies: Reply[] = [];
  // Every reply that takes no arguments, found by reflection, so a new one is checked without editing this test.
  for (const [name, value] of Object.entries(phrasing)) {
    if (typeof value === 'function' && value.length === 0) {
      const result: unknown = (value as () => unknown)();
      if (typeof result === 'object' && result !== null && 'segments' in result) replies.push(result as Reply);
      else assert.fail(`${name} takes no arguments but is not a reply`);
    }
  }
  for (const source of SOURCES) {
    replies.push(phrasing.listExpired(source), phrasing.issueGone(3, source), phrasing.noMatches(source));
    for (const [remaining, midItem, complete, first] of [
      [3, false, true, true],
      [3, false, false, false],
      [0, true, true, false],
      [0, false, false, false],
      [0, false, true, false],
    ] as const) {
      replies.push(
        phrasing.listPage({
          source,
          total: 8,
          complete,
          segments: [{text: 'One: something.'}],
          first,
          from: 1,
          to: 5,
          remaining,
          midItem,
        }),
      );
    }
  }
  for (const part of PARTS) {
    replies.push(
      phrasing.launchResumeIssue('Something', part),
      phrasing.emptyPart(part),
      phrasing.startOfPart(part),
      phrasing.endOfPart(part, true, 3),
      phrasing.partPage({part, units: [[{text: 'Body.'}]], first: true, last: false, total: 3, complete: true}),
      phrasing.partPage({part, units: [[{text: 'Body.'}]], first: false, last: true, total: 3, complete: false}),
    );
  }
  replies.push(
    phrasing.launchResumeIssue('Something', null),
    phrasing.startOfPart(null),
    phrasing.endOfList(mine, true, 8),
    phrasing.endOfList(mine, false, 50),
    phrasing.endOfList(people, true, 2),
    phrasing.endOfList(people, false, 2),
    phrasing.noSuchNumber(9, 8, true, mine),
    phrasing.noSuchNumber(51, 50, false, mine),
    phrasing.noSuchNumber(3, 2, false, people),
    phrasing.noMatches(null),
    phrasing.nobodyCalled('sam', true, null),
    phrasing.nobodyCalled('sam', false, people),
    phrasing.whoseIssues(),
    phrasing.didYouMean('Mary Jones'),
    phrasing.notThatPerson(),
    phrasing.onlyOpenIssues(),
    phrasing.opened({ordinal: 2, spokenId: null, summary: 'Something', state: 'Open', summaryContinues: true}),
    phrasing.idNotFound('Y A 99'),
    phrasing.idNotFoundNoList('U M 2'),
    phrasing.verbositySet('brief'),
    phrasing.rateSet(125),
    phrasing.rateLimit(250, true),
    phrasing.where({list: {source: SOURCES[0], total: 8, complete: true, expired: true, heard: null}, issue: null}),
    phrasing.where({list: null, issue: null}),
    phrasing.airStale({kind: 'place', said: 'missoula'}, 45),
    phrasing.airNoSensors({kind: 'home'}, 15),
    phrasing.airNotFound('blorp'),
    phrasing.airSensorNoReading('rattlesnake creek'),
    phrasing.airWhichPlace(['Springfield, Illinois', 'Springfield, Missouri']),
    phrasing.airWhichPlace(['Springfield, Illinois', 'Springfield, Missouri', 'Springfield, Oregon']),
  );
  for (const category of [
    'good',
    'moderate',
    'unhealthyForSensitiveGroups',
    'unhealthy',
    'veryUnhealthy',
    'hazardous',
  ] as const) {
    replies.push(
      phrasing.airReading({
        where: {kind: 'device'},
        aqi: 62,
        category,
        sensors: 1,
        fewSensors: true,
        radiusKm: 15,
        ageMinutes: 1,
      }),
    );
  }
  return replies;
}

function quotedPhrases(text: string): string[] {
  return [...text.matchAll(/(?<=^|[\s(:,])'([^']+?)'(?=[\s.,?!:;)]|$)/g)].map((match) => match[1]);
}

test('every quoted phrase in every reply and reprompt parses to the intent it promises', () => {
  const seen = new Set<string>();
  for (const reply of everyReply()) {
    for (const segment of [...reply.segments, ...(reply.reprompt ?? [])]) {
      for (const phrase of quotedPhrases(segment.text)) {
        seen.add(phrase);
        const promise = PROMISES[phrase];
        assert.ok(promise !== undefined, `"${phrase}" (in "${segment.text}") has no promised intent in this test`);
        const said = promise.say ?? phrase;
        const parsed = parseUtterance(said);
        assert.ok(parsed.matched, `"${said}" is offered in "${segment.text}" but is not understood`);
        assert.equal(parsed.intent, promise.intent, `"${said}" in "${segment.text}"`);
      }
    }
  }
  for (const phrase of ['brief', 'normal', 'full', 'normal speed', 'where am I']) assert.ok(seen.has(phrase), phrase);
});

test('the phrase extractor ignores apostrophes inside words', () => {
  assert.deepEqual(quotedPhrases("I didn't catch that. You can say 'my issues', or 'help'."), ['my issues', 'help']);
  assert.deepEqual(quotedPhrases("That's the start of the list."), []);
});

test('YA-36: air quality speaks where, the category, then the number, and advice only above Good', () => {
  const lines = (reply: Reply) => reply.segments.map((segment) => segment.text);
  assert.deepEqual(
    lines(
      phrasing.airReading({
        where: {kind: 'place', said: 'missoula'},
        aqi: 62,
        category: 'moderate',
        sensors: 7,
        sources: {PurpleAir: 7},
        fewSensors: false,
        radiusKm: 5,
        ageMinutes: 10,
      }),
    ),
    [
      'Air quality near Missoula is Moderate.',
      'AQI 62, from 7 PurpleAir sensors within 5 kilometres, updated 10 minutes ago.',
      'Unusually sensitive people should consider making outdoor activities shorter and less intense.',
    ],
  );
  assert.deepEqual(
    lines(
      phrasing.airReading({
        where: {kind: 'home'},
        aqi: 20,
        category: 'good',
        sensors: 1,
        fewSensors: false,
        radiusKm: 0,
        ageMinutes: 0,
      }),
    ),
    ['Air quality at home is Good.', 'AQI 20, from 1 sensor, updated just now.'],
  );
});

test('YA-36: a place is echoed only as words or a postal code, never as numbers that could be coordinates or an address', () => {
  assert.equal(phrasing.spokenPostalCode('59802'), '5 9 8 0 2');
  assert.equal(phrasing.spokenPostalCode('sw1a 1aa'), 'S W 1 A, 1 A A');
  assert.equal(phrasing.spokenPlace('missoula'), 'Missoula');
  assert.equal(phrasing.spokenPlace('the university of montana'), 'The University of Montana');
  assert.equal(phrasing.spokenPlace('59802'), '5 9 8 0 2');
  assert.equal(phrasing.spokenPlace('123 main street'), 'that address');
  assert.equal(phrasing.spokenPlace('46 87 113 99'), 'that place');
  assert.equal(phrasing.spokenPlace('46.87, -113.99'), 'that place');
  assert.equal(phrasing.spokenPlace('forty six point eight seven minus one one three'), 'that place');
  assert.equal(phrasing.spokenPlace('five nine eight oh two'), 'that place');
  assert.equal(phrasing.spokenPlace('seven oaks'), 'Seven Oaks');
  assert.equal(phrasing.spokenPlace('the big hill above the old town square'), 'The Big Hill Above the Old');
});

test('YA-36: the device is "near you", a far place is said by its own name, and a choice numbers its places', () => {
  const lines = (reply: Reply) => reply.segments.map((segment) => segment.text);
  const base = {aqi: 20, category: 'good', sensors: 3, fewSensors: false, radiusKm: 5, ageMinutes: 2} as const;
  assert.equal(lines(phrasing.airReading({...base, where: {kind: 'device'}}))[0], 'Air quality near you is Good.');
  assert.ok(
    lines(phrasing.airReading({...base, where: {kind: 'indoor'}, lowConfidence: true})).includes(
      'This sensor reports low confidence. Treat this reading as uncertain.',
    ),
  );
  assert.deepEqual(lines(phrasing.airNoSensors({kind: 'indoor'}, 0)), [
    'The indoor sensor has no current reading I can use.',
  ]);
  assert.equal(
    lines(phrasing.airReading({...base, where: {kind: 'place', said: 'portland', name: 'Portland, Oregon'}}))[0],
    'Air quality near Portland, Oregon is Good.',
  );
  assert.deepEqual(lines(phrasing.airWhichPlace(['Springfield, Missouri', 'Springfield, Illinois'])), [
    'Did you mean Springfield, Missouri, or Springfield, Illinois?',
    "Say 'one' or 'two'.",
  ]);
  assert.deepEqual(lines(phrasing.airBusy()), ["I've checked the air a lot just now. Try again in a few minutes."]);
});
