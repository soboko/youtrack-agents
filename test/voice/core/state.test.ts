import assert from 'node:assert/strict';
import {test} from 'node:test';
import {initialState, parseState, serialiseState, STATE_VERSION} from '../../../src/voice/core/state.ts';
import type {ConversationState} from '../../../src/voice/core/state.ts';

function sampleState(): ConversationState {
  return {
    ...initialState(),
    verbosity: 'full',
    ratePercent: 150,
    workingSet: {
      source: {kind: 'find', words: 'login'},
      items: [{key: 'YA-21', summary: 'Fix the login redirect loop', state: null}],
      complete: false,
      capturedAt: 1000,
      pageStart: {unit: 0, piece: 0},
      pageEnd: {unit: 1, piece: 0},
    },
    focus: {
      key: 'YA-21',
      summary: 'Fix the login redirect loop',
      ordinal: 1,
      part: 'comments',
      pageStart: {unit: 1, piece: 0},
      pageEnd: {unit: 1, piece: 2},
      progress: {current: 2, total: 50, complete: false},
    },
    active: 'issue',
    lastReply: {segments: [{text: 'Hello.', pauseAfter: 'short'}], earcon: 'success', reprompt: [{text: 'Hi.'}]},
    updatedAt: 2000,
  };
}

test('state round-trips through its serialised form', () => {
  const state = sampleState();
  const parsed = parseState(serialiseState(state));
  assert.equal(parsed.outcome, 'loaded');
  assert.deepEqual(parsed.state, state);
});

test('absent state is fresh, with brief answers at the normal rate', () => {
  const parsed = parseState(null);
  assert.equal(parsed.outcome, 'fresh');
  assert.equal(parsed.state.version, STATE_VERSION);
  assert.equal(parsed.state.verbosity, 'brief');
  assert.equal(parsed.state.ratePercent, 100);
});

test('a version 1 state migrates its page offsets to cursors', () => {
  const v1 = {
    version: 1,
    verbosity: 'brief',
    ratePercent: 125,
    workingSet: {
      source: {kind: 'scope', scope: 'mine'},
      items: [{key: 'YA-1', summary: 'One', state: 'Open'}],
      complete: true,
      capturedAt: 5,
      pageStart: 0,
      pageEnd: 1,
    },
    focus: {
      key: 'YA-1',
      summary: 'One',
      ordinal: 1,
      part: 'description',
      pageStart: 2,
      pageEnd: 3,
      unitCount: 4,
      progress: {current: 3, total: 4, complete: true},
    },
    active: 'issue',
    lastReply: null,
    updatedAt: 9,
  };
  const parsed = parseState(JSON.stringify(v1));
  assert.equal(parsed.outcome, 'migrated');
  assert.equal(parsed.state.version, 2);
  // List offsets counted items, so they become item cursors.
  assert.deepEqual(parsed.state.workingSet?.pageEnd, {unit: 1, piece: 0});
  // Focus offsets counted pieces of the part, so they are kept as piece indexes for the next read to resolve.
  assert.deepEqual(parsed.state.focus?.v1Offsets, {pageStart: 2, pageEnd: 3});
  assert.deepEqual(parsed.state.focus?.pageStart, {unit: 0, piece: 0});
  assert.equal('unitCount' in (parsed.state.focus ?? {}), false);
  // They survive a save and load as version 2 until that read.
  assert.deepEqual(parseState(serialiseState(parsed.state)).state.focus?.v1Offsets, {pageStart: 2, pageEnd: 3});
});

test('a version 1 focus kept from a replaced list is dropped', () => {
  const v1 = {
    version: 1,
    verbosity: 'brief',
    ratePercent: 100,
    workingSet: null,
    focus: {
      key: 'YA-1',
      summary: 'One',
      ordinal: 2,
      part: null,
      pageStart: 0,
      pageEnd: 0,
      unitCount: 0,
      progress: null,
    },
    active: 'list',
    lastReply: null,
    updatedAt: 1,
  };
  assert.equal(parseState(JSON.stringify(v1)).state.focus, null);
});

test('plausible-looking but out-of-range numbers are pulled into range', () => {
  const state = sampleState();
  const raw = JSON.parse(serialiseState(state)) as Record<string, unknown>;
  raw.ratePercent = -5000;
  raw.workingSet = {...state.workingSet, pageStart: {unit: -5, piece: -1}, pageEnd: {unit: 2.7, piece: 0}};
  raw.focus = {...state.focus, ordinal: -3, progress: {current: 7, total: 3, complete: true}};
  const parsed = parseState(JSON.stringify(raw));
  assert.equal(parsed.outcome, 'loaded');
  assert.equal(parsed.state.ratePercent, 50);
  assert.deepEqual(parsed.state.workingSet?.pageStart, {unit: 0, piece: 0});
  assert.deepEqual(parsed.state.workingSet?.pageEnd, {unit: 2, piece: 0});
  assert.equal(parsed.state.focus?.ordinal, null);
  assert.deepEqual(parsed.state.focus?.progress, {current: 3, total: 3, complete: true});
  assert.equal(parseState(JSON.stringify({...raw, ratePercent: 9999})).state.ratePercent, 250);
});

test('malformed and newer state is discarded with a reason that holds no content', () => {
  const cases: Array<[string, string]> = [
    ['not json', 'not-json'],
    ['[1, 2]', 'not-an-object'],
    ['{}', 'no-version'],
    ['{"version": 3}', 'newer-version-3'],
    ['{"version": 0}', 'unknown-version-0'],
    [JSON.stringify({...sampleState(), verbosity: 'chatty'}), 'malformed-v2'],
    [JSON.stringify({...sampleState(), focus: {key: 'YA-1'}}), 'malformed-v2'],
    [JSON.stringify({...sampleState(), lastReply: {segments: [{text: 'x'}], earcon: 'trumpet'}}), 'malformed-v2'],
  ];
  for (const [serialized, reason] of cases) {
    const parsed = parseState(serialized);
    assert.equal(parsed.outcome, 'discarded', serialized);
    assert.equal(parsed.reason, reason, serialized);
    assert.deepEqual(parsed.state, initialState());
  }
});
