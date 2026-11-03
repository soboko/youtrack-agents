/**
 * Unit tests for the conversation entry point: the things a transcript cannot see, such as what reaches the logs and
 * the store, and how the core behaves when its ports misbehave or its deadline passes.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {converse, DEFAULT_POLICY, UNGATED_INTENTS} from '../../../src/voice/core/converse.ts';
import {createFakeClock, FakeVoiceTracker, MemoryStateStore} from '../../../src/voice/core/fakes.ts';
import {INTENT_CATALOGUE} from '../../../src/voice/core/intents.ts';
import {whenWords} from '../../../src/voice/core/phrasing.ts';
import {parseState} from '../../../src/voice/core/state.ts';
import type {
  ConversationDeps,
  IntentName,
  LogLevel,
  SpeakerEvidence,
  VoiceInput,
  VoicePolicy,
  VoiceRequest,
  VoiceResponse,
  VoiceTracker,
} from '../../../src/voice/core/types.ts';
import {loadFixture, TRANSCRIPT_START} from './transcript-runner.ts';

const USER = 'test:person:sam';
const GATED_SENTENCE = "I can't read issues until I'm sure who's speaking.";

interface SayOptions {
  evidence?: SpeakerEvidence[];
  maxSpeechChars?: number;
  display?: boolean;
  timeZone?: string;
  signal?: AbortSignal;
}

interface Harness {
  deps: ConversationDeps;
  tracker: FakeVoiceTracker;
  store: MemoryStateStore;
  logs: Array<{level: LogLevel; event: string; fields: Record<string, unknown>}>;
  say(input: VoiceInput | string, options?: SayOptions): Promise<VoiceResponse>;
}

function harness(policy: VoicePolicy = DEFAULT_POLICY): Harness {
  const clock = createFakeClock(TRANSCRIPT_START);
  const tracker = new FakeVoiceTracker(loadFixture('team'), {clock});
  const store = new MemoryStateStore();
  const logs: Harness['logs'] = [];
  const deps: ConversationDeps = {
    tracker,
    store,
    policy,
    now: clock.now,
    log: (level, event, fields) => {
      logs.push({level, event, fields: {...fields}});
    },
  };
  let count = 0;
  return {
    deps,
    tracker,
    store,
    logs,
    say: (input, options = {}) => {
      count++;
      const request: VoiceRequest = {
        input: typeof input === 'string' ? {kind: 'utterance', text: input} : input,
        speaker: {userId: USER, evidence: options.evidence ?? ['person']},
        locale: 'en-GB',
        capabilities: {
          ssml: false,
          earcons: true,
          display: options.display ?? false,
          followUp: true,
          maxSpeechChars: options.maxSpeechChars ?? 1000,
        },
        requestId: `unit-${count}`,
      };
      if (options.timeZone !== undefined) request.timeZone = options.timeZone;
      return converse(request, options.signal === undefined ? deps : {...deps, signal: options.signal});
    },
  };
}

function spoken(response: VoiceResponse): string {
  return response.segments.map((segment) => segment.text).join(' ');
}

function drainMacrotask(): Promise<void> {
  // The fakes are all promise-based, so one macrotask turn lets every pending microtask of a turn run.
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test('content, ids, author names, slot values and speech are logged at debug only', async () => {
  const h = harness();
  await h.say('find the login redirect');
  await h.say('my issues');
  await h.say('open one');
  await h.say('description');
  await h.say('comments');
  await h.say('open issue yankee alpha two two');

  const aboveDebug = h.logs.filter((entry) => entry.level !== 'debug');
  const serialized = JSON.stringify(aboveDebug);
  for (const content of [
    'login redirect',
    'Fix the login',
    'Safari',
    'reproduce this',
    USER,
    'YA-21',
    'YA-22',
    'Ana',
    'Chris',
  ]) {
    assert.ok(!serialized.includes(content), `"${content}" logged above debug`);
  }
  const events = new Set(aboveDebug.map((entry) => entry.event));
  for (const event of [
    'voice.turn.received',
    'voice.intent',
    'voice.gate',
    'voice.tracker.call',
    'voice.page',
    'voice.state.loaded',
    'voice.state.saved',
    'voice.turn.completed',
  ]) {
    assert.ok(events.has(event), `no ${event} log`);
  }
  const completed = aboveDebug.filter((entry) => entry.event === 'voice.turn.completed');
  assert.ok(completed.every((entry) => typeof entry.fields.ms === 'number' && entry.fields.stateVersion === 2));
  assert.ok(h.logs.some((entry) => entry.level === 'debug' && entry.event === 'voice.speech'));
});

test('a tracker call timing comes from the injected clock', async () => {
  const h = harness();
  h.tracker.latencyMs = 2500;
  await h.say('my issues');
  assert.equal(h.logs.find((entry) => entry.event === 'voice.tracker.call')?.fields.ms, 2500);
});

test('a failed state load answers from fresh state and does not overwrite what is stored', async () => {
  const h = harness();
  await h.say('my issues');
  const stored = h.store.values.get(USER);
  h.store.failLoads = true;
  const response = await h.say('open two');
  assert.match(spoken(response), /There's no list yet/);
  assert.deepEqual(h.store.values.get(USER), stored);
  assert.ok(h.logs.some((entry) => entry.level === 'error' && entry.event === 'voice.state.loadFailed'));
});

test('a failed state save is logged and the reply still arrives', async () => {
  const h = harness();
  h.store.failSaves = true;
  const response = await h.say('my issues');
  assert.match(spoken(response), /^You have 8 issues\./);
  assert.ok(h.logs.some((entry) => entry.level === 'error' && entry.event === 'voice.state.saveFailed'));
});

test('a session end returns no speech, and a turn that changes nothing does not save', async () => {
  const h = harness();
  await h.say('my issues');
  const saves = h.store.saves;
  const response = await h.say({kind: 'sessionEnded', reason: 'silence'});
  assert.deepEqual(response.segments, []);
  assert.equal(response.listen, false);
  assert.equal(response.reprompt, undefined);
  await h.say('repeat');
  await h.say('my issues', {evidence: ['none']});
  assert.equal(h.store.saves, saves, 'a turn that changed nothing saved');
  assert.equal(h.logs.filter((entry) => entry.event === 'voice.state.notSaved').length, 3);
  await h.say('open one');
  assert.equal(h.store.saves, saves + 1, 'a turn that changed something did not save');
});

test('a no-op turn cannot overwrite a slow turn that changed something', async (t) => {
  const h = harness();
  await h.say('my issues');
  const release = h.tracker.hold();
  t.after(() => {
    release();
  });
  const slow = h.say('open two');
  await h.tracker.whenHeld();
  await h.say({kind: 'sessionEnded', reason: 'silence'});
  release();
  await slow;
  const stored = parseState(h.store.values.get(USER)?.serialized ?? null).state;
  assert.equal(stored.focus?.key, 'YA-22', "the session end's save beat the open");
  assert.equal(h.store.conflicts, 0);
});

test('the memory store accepts exactly one of two saves started together against the same version', async () => {
  const store = new MemoryStateStore();
  await store.save('u', 'first', null);
  const loaded = await store.load('u');
  assert.ok(loaded !== null);
  let gate: () => void = () => {};
  const bothWaiting = new Promise<void>((resolve) => {
    gate = resolve;
  });
  let waiting = 0;
  store.beforeSave = async () => {
    waiting++;
    if (waiting === 2) gate();
    await bothWaiting;
  };
  const results = await Promise.all([
    store.save('u', 'from A', loaded.version),
    store.save('u', 'from B', loaded.version),
  ]);
  assert.deepEqual([...results].sort(), [false, true]);
  assert.equal((await store.load('u'))?.serialized, results[0] ? 'from A' : 'from B');
});

test('the memory store refuses a save against a version it no longer holds', async () => {
  const store = new MemoryStateStore();
  assert.equal(await store.save('u', 'first', null), true);
  const a = await store.load('u');
  const b = await store.load('u');
  assert.ok(a !== null && b !== null);
  assert.equal(await store.save('u', 'from A', a.version), true);
  assert.equal(await store.save('u', 'from B', b.version), false);
  assert.equal((await store.load('u'))?.serialized, 'from A');
  assert.equal(await store.save('v', 'late', 'some-version'), false, 'nothing stored yet means only null matches');
});

test('when two turns overlap, the later save is refused and the earlier turn state stands', async (t) => {
  const h = harness();
  await h.say('my issues');
  const release = h.tracker.hold();
  t.after(() => {
    release();
  });
  // A: "open two" loads state, then waits on the tracker.
  const slow = h.say('open two');
  await h.tracker.whenHeld();
  // B: "faster" loads the same version and saves first.
  const fast = await h.say('faster');
  assert.equal(fast.ratePercent, 125);
  release();
  const late = await slow;
  assert.match(spoken(late), /^Number 2\./);

  const stored = parseState(h.store.values.get(USER)?.serialized ?? null).state;
  assert.equal(stored.ratePercent, 125, "B's change survives");
  assert.equal(stored.focus, null, "A's change is dropped, not merged");
  assert.ok(h.logs.some((entry) => entry.level === 'warn' && entry.event === 'voice.state.conflict'));
  assert.equal(h.store.conflicts, 1);
  const aboveDebug = JSON.stringify(h.logs.filter((entry) => entry.level !== 'debug'));
  assert.ok(!aboveDebug.includes(USER), 'the user id was logged with the conflict');
});

test('a slow tracker holds the turn until it answers, with no fixed waits', async (t) => {
  const h = harness();
  const release = h.tracker.hold();
  t.after(() => {
    release();
  });
  let settled = false;
  const pending = h.say('my issues').then((response) => {
    settled = true;
    return response;
  });
  await h.tracker.whenHeld();
  await drainMacrotask();
  assert.equal(settled, false, 'the turn finished while its tracker call was held');
  release();
  assert.match(spoken(await pending), /^You have 8 issues\./);
});

test('once the turn deadline fires, no further tracker call is made and nothing is saved', async () => {
  const h = harness();
  await h.say('my issues');
  await h.say('open one');
  const controller = new AbortController();
  const tracker: VoiceTracker = {
    listIssues: (query) => h.tracker.listIssues(query),
    getIssue: async (key) => {
      const issue = await h.tracker.getIssue(key);
      controller.abort();
      return issue;
    },
    listComments: (key, limit) => h.tracker.listComments(key, limit),
    listAssignees: (limit) => h.tracker.listAssignees(limit),
  };
  h.deps.tracker = tracker;
  const before = h.store.values.get(USER);
  const callsBefore = h.tracker.calls.length;
  const response = await h.say('comments', {signal: controller.signal});

  assert.deepEqual(
    h.tracker.calls.slice(callsBefore).map((call) => call.method),
    ['getIssue'],
    'listComments was called after the deadline',
  );
  assert.deepEqual(h.store.values.get(USER), before, 'state was saved after the deadline');
  assert.ok(h.logs.some((entry) => entry.event === 'voice.state.notSaved'));
  assert.equal(typeof spoken(response), 'string');

  const already = new AbortController();
  already.abort();
  const callsNow = h.tracker.calls.length;
  await h.say('my issues', {signal: already.signal});
  assert.equal(h.tracker.calls.length, callsNow, 'a turn whose deadline already passed called the tracker');
});

test('the filler fallback makes its second lookup only while the deadline has not passed', async () => {
  const h = harness();
  await h.say('my issues');
  const controller = new AbortController();
  const real = h.deps.tracker;
  h.deps.tracker = {
    listIssues: (query) => real.listIssues(query),
    getIssue: async (key) => {
      controller.abort();
      return real.getIssue(key);
    },
    listComments: (key, limit) => real.listComments(key, limit),
    listAssignees: (limit) => real.listAssignees(limit),
  };
  const before = h.tracker.calls.length;
  await h.say('open um two', {signal: controller.signal});
  assert.deepEqual(
    h.tracker.calls.slice(before).map((call) => call.args[0]),
    ['UM-2'],
    'the position lookup ran after the deadline',
  );
});

test('an exception inside a turn is answered, logged by name only, and leaves the stored state intact', async () => {
  const h = harness();
  await h.say('faster');
  await h.say('my issues');
  await h.say('open one');
  const stored = h.store.values.get(USER);
  const real = h.deps.tracker;
  // A binding returning a partial issue: no workflow, so reading it throws outside the tracker call.
  h.deps.tracker = {
    listIssues: (query) => real.listIssues(query),
    getIssue: async () => ({key: 'YA-21', summary: 'secret detail about YA-21 for sam'}) as never,
    listComments: (key, limit) => real.listComments(key, limit),
    listAssignees: (limit) => real.listAssignees(limit),
  };
  const response = await h.say('fields');
  assert.equal(response.earcon, 'failure');
  assert.equal(spoken(response), 'Something went wrong on my side. Try again in a moment.');
  assert.equal(response.ratePercent, 125, "the failed turn's answer lost the person's speech rate");
  const failed = h.logs.find((entry) => entry.level === 'error' && entry.event === 'voice.turn.failed');
  assert.equal(failed?.fields.error, 'TypeError');
  assert.ok(!JSON.stringify(h.logs.filter((entry) => entry.level !== 'debug')).includes('secret detail'));
  assert.deepEqual(h.store.values.get(USER), stored);

  // A binding error whose message carries content ("No issue YA-21 for sam") is logged by name only, too.
  h.deps.tracker = {
    listIssues: (query) => real.listIssues(query),
    getIssue: async () =>
      ({
        key: 'YA-21',
        summary: 'x',
        get workflow(): never {
          throw new Error('No issue YA-21 for sam');
        },
      }) as never,
    listComments: (key, limit) => real.listComments(key, limit),
    listAssignees: (limit) => real.listAssignees(limit),
  };
  await h.say('fields');
  const aboveDebug = JSON.stringify(h.logs.filter((entry) => entry.level !== 'debug'));
  assert.ok(!aboveDebug.includes('No issue YA-21') && !aboveDebug.includes('for sam'), 'an error message was logged');

  h.deps.tracker = real;
  assert.match(spoken(await h.say('description')), /^Description, 3 paragraphs\. Paragraph 1 of 3\./);
});

test('converse never rejects, even when the logger throws', async () => {
  const h = harness();
  h.deps.log = () => {
    throw new Error('logger down');
  };
  const response = await h.say('my issues');
  assert.match(spoken(response), /^You have 8 issues\./);
});

test('a summary longer than the whole speech limit is heard in pieces, and every item is reached', async () => {
  const h = harness();
  const long = `Very long summary ${'with many more words '.repeat(30)}end`;
  h.tracker.update('YA-21', {summary: long});
  const heard: string[] = [];
  let response = await h.say('my issues', {maxSpeechChars: 250});
  heard.push(spoken(response));
  for (let turn = 0; turn < 20 && !/\b(End of the list)\b/.test(spoken(response)); turn++) {
    response = await h.say('more', {maxSpeechChars: 250});
    heard.push(spoken(response));
  }
  const all = heard.join(' ');
  for (const label of ['One:', 'One, continued:', 'Two:', 'Five:', 'Eight:']) assert.ok(all.includes(label), label);
  assert.ok(all.includes('end.'), 'the end of the long summary was never heard');
  assert.ok(!h.logs.some((entry) => entry.event === 'voice.speech.overBudget'), 'paging relied on trimming');
  for (const text of heard) assert.ok(text.length <= 250, `${text.length} chars`);
});

test('at the smallest supported limit, a very long author name cannot crowd out the comment', async () => {
  const h = harness();
  await h.say('my issues');
  await h.say('open one');
  const real = h.deps.tracker;
  const body = 'Every word of this comment body must be heard in full.';
  h.deps.tracker = {
    listIssues: (query) => real.listIssues(query),
    getIssue: (key) => real.getIssue(key),
    listComments: async () => ({
      comments: [{authorName: `Signature ${'very '.repeat(60)}long`, created: TRANSCRIPT_START, text: body}],
      complete: true,
    }),
    listAssignees: (limit) => real.listAssignees(limit),
  };
  const heard = [spoken(await h.say('comments', {maxSpeechChars: 250}))];
  for (let turn = 0; turn < 5 && !heard.at(-1)?.includes('End of the comments'); turn++) {
    heard.push(spoken(await h.say('more', {maxSpeechChars: 250})));
  }
  const words = heard.join(' ');
  for (const word of body.replace('.', '').split(' ')) assert.ok(words.includes(word), `"${word}" never heard`);
  assert.ok(!h.logs.some((entry) => entry.event === 'voice.speech.overBudget'));
});

test('below the supported speech limit, a reply is cut to fit and the cut is logged', async () => {
  const h = harness();
  const response = await h.say('help', {maxSpeechChars: 120});
  const chars = response.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  assert.ok(chars <= 120 && chars > 0, `${chars} chars`);
  assert.ok(h.logs.some((entry) => entry.level === 'warn' && entry.event === 'voice.speech.overBudget'));
});

test('when a reply is trimmed, later segments are dropped whole: a hint is never cut mid-word', async () => {
  const h = harness();
  await h.say('my issues');
  const full = await h.say('open one');
  const trimmed = await h.say('open one', {maxSpeechChars: 60});
  const fullTexts = full.segments.map((segment) => segment.text);
  assert.ok(trimmed.segments.length < full.segments.length, 'nothing was trimmed');
  for (const segment of trimmed.segments) assert.ok(fullTexts.includes(segment.text), `cut segment "${segment.text}"`);
});

test('adapters with a display get a card holding the same words as the speech', async () => {
  const h = harness();
  const response = await h.say('my issues', {display: true});
  assert.equal(response.card?.title, 'Your issues');
  assert.equal(response.card?.text, response.segments.map((segment) => segment.text).join('\n'));
  assert.equal((await h.say('my issues')).card, undefined);
});

test('adapter intents with unparseable slot values drop the value and say so in logs', async () => {
  const h = harness();
  await h.say('my issues');
  const response = await h.say({kind: 'intent', intent: 'open', slots: {ordinal: 'banana'}});
  assert.match(spoken(response), /^Which one\?/);
  assert.deepEqual(h.logs.filter((entry) => entry.event === 'voice.intent').at(-1)?.fields.dropped, ['ordinal']);
});

test('inputs as the Alexa adapter sends them: an empty fallback utterance, compact ids, digit ordinals', async () => {
  const h = harness();
  const fallback = await h.say({kind: 'utterance', text: '', confidence: 0});
  assert.equal(spoken(fallback), "I didn't catch that. You can say 'my issues', or 'help'.");
  assert.equal(fallback.listen, true);
  assert.equal(spoken(await h.say({kind: 'utterance', text: '   '})), spoken(fallback));
  assert.match(
    spoken(await h.say({kind: 'intent', intent: 'openById', slots: {spelled: 'YA22'}})),
    /^Issue Y A 22\. Add dark mode to settings\./,
  );
  await h.say({kind: 'intent', intent: 'list', slots: {}});
  assert.match(
    spoken(await h.say({kind: 'intent', intent: 'open', slots: {ordinal: '2'}})),
    /^Number 2\. Add dark mode to settings\./,
  );
});

test('every listening response carries a reprompt, and the rate preference', async () => {
  const h = harness();
  for (const text of ['help', 'my issues', 'open one', 'faster', 'blah', 'comment', 'where am i', 'yes']) {
    const response = await h.say(text);
    assert.equal(response.listen, true, text);
    assert.ok((response.reprompt?.length ?? 0) > 0, text);
  }
  assert.equal((await h.say('help')).ratePercent, 125);
});

/** A plausible slot for each stage 1 intent, so a gated turn would otherwise have done its full work. */
const GATE_PROBE_SLOTS: Partial<Record<IntentName, Record<string, string>>> = {
  list: {scope: 'mine'},
  find: {words: 'login'},
  open: {ordinal: '1'},
  openById: {spelled: 'YA-21'},
  read: {part: 'comments'},
};

test('with stored state, every gated intent and launch refuse a weaker speaker and reveal nothing', async () => {
  const h = harness({...DEFAULT_POLICY, readAccepts: ['person']});
  for (const text of ['my issues', 'open one', 'description', 'comments']) await h.say(text);
  const storedBefore = h.store.values.get(USER)?.serialized;

  const gatedIntents = INTENT_CATALOGUE.filter((spec) => spec.stage === 1 && !UNGATED_INTENTS.has(spec.name));
  assert.ok(gatedIntents.length >= 9, 'the gated set shrank');
  const fixture = loadFixture('team');
  const secrets = [
    ...fixture.issues.map((issue) => issue.summary),
    'Description',
    'Comment',
    'paragraph',
    'Welcome back',
  ];
  const callsBefore = h.tracker.calls.length;

  for (const spec of gatedIntents) {
    for (const evidence of [['account'], ['none'], ['caller-id']] as SpeakerEvidence[][]) {
      const response = await h.say(
        {kind: 'intent', intent: spec.name, slots: GATE_PROBE_SLOTS[spec.name] ?? {}},
        {evidence},
      );
      assert.equal(spoken(response), GATED_SENTENCE, `${spec.name} with ${evidence.join(',')}`);
      assert.equal(response.earcon, 'failure');
    }
  }
  for (const text of ['resume', 'more', 'previous', 'read it', 'comments', 'fields', 'repeat', 'where am i']) {
    const response = await h.say(text, {evidence: ['account']});
    assert.equal(spoken(response), GATED_SENTENCE, text);
  }
  await h.say({kind: 'sessionEnded', reason: 'silence'}, {evidence: ['account']});
  const launch = await h.say({kind: 'launch'}, {evidence: ['account']});
  assert.equal(spoken(launch), `Tracker ready. ${GATED_SENTENCE}`);

  assert.equal(h.tracker.calls.length, callsBefore, 'a refused turn called the tracker');
  const afterRefusals = parseState(h.store.values.get(USER)?.serialized ?? null).state;
  const before = parseState(storedBefore ?? null).state;
  assert.deepEqual(afterRefusals.lastReply, before.lastReply, 'a refusal replaced what "repeat" replays');
  assert.deepEqual(afterRefusals.focus, before.focus);
  const refusedSpeech = `${spoken(launch)} ${GATED_SENTENCE}`;
  for (const secret of secrets) assert.ok(!refusedSpeech.includes(secret), secret);

  // The same person, recognised again, carries on where they were.
  assert.match(spoken(await h.say('more', {evidence: ['person']})), /^End of the comments\.|^Comment 2 of 2/);
});

test('evidence is accepted only when one kind is listed in readAccepts: weak kinds never add up', async () => {
  const kinds: SpeakerEvidence[] = ['person', 'account', 'caller-id', 'keypad-pin', 'none'];
  const subsets: SpeakerEvidence[][] = [];
  for (let mask = 1; mask < 1 << kinds.length; mask++)
    subsets.push(kinds.filter((_kind, index) => mask & (1 << index)));
  for (const readAccepts of [['person'], ['person', 'keypad-pin'], ['account']] as SpeakerEvidence[][]) {
    const h = harness({...DEFAULT_POLICY, readAccepts});
    for (const text of ['my issues', 'open one', 'description']) await h.say(text, {evidence: [readAccepts[0]]});
    for (const evidence of subsets) {
      const allowed = evidence.some((kind) => readAccepts.includes(kind));
      const calls = h.tracker.calls.length;
      const response = await h.say('comments', {evidence});
      const label = `[${evidence.join(', ')}] under [${readAccepts.join(', ')}]`;
      if (allowed) {
        assert.match(spoken(response), /^2 comments\./, label);
      } else {
        assert.equal(spoken(response), GATED_SENTENCE, label);
        assert.equal(h.tracker.calls.length, calls, `${label} called the tracker`);
      }
    }
  }
});

test('assignee names, user ids and utterances set aside for low confidence stay out of logs above debug', async () => {
  const h = harness();
  await h.say({kind: 'utterance', text: 'open the boiler invoice', confidence: 0.1});
  await h.say('my issues');
  await h.say('open one');
  await h.say('fields');
  const aboveDebug = JSON.stringify(h.logs.filter((entry) => entry.level !== 'debug'));
  assert.ok(!aboveDebug.includes('boiler'), 'a low-confidence utterance was logged above debug');
  assert.ok(!/\bsam\b/.test(aboveDebug), 'an assignee was logged above debug');
  assert.ok(!aboveDebug.includes(USER), 'the user id was logged above debug');
  const received = h.logs.filter((entry) => entry.event === 'voice.turn.received');
  assert.ok(
    received.every((entry) => typeof entry.fields.timeZone === 'boolean'),
    'the zone name was logged',
  );
});

test("dates: relative only in the listener's own zone, absolute without one", () => {
  const now = Date.parse('2026-09-12T02:00:00Z'); // Saturday in UTC; still Friday evening in Los Angeles.
  const fridayEveningLa = Date.parse('2026-09-12T01:00:00Z');
  const thursdayLa = Date.parse('2026-09-11T01:00:00Z');
  assert.equal(whenWords(fridayEveningLa, now), 'on 12 September');
  assert.equal(whenWords(fridayEveningLa, now, 'America/Los_Angeles'), 'today');
  assert.equal(whenWords(thursdayLa, now, 'America/Los_Angeles'), 'yesterday');
  assert.equal(whenWords(thursdayLa, now, 'UTC'), 'yesterday');
  assert.equal(whenWords(Date.parse('2026-09-11T23:30:00Z'), now, 'Pacific/Kiritimati'), 'today');
  assert.equal(whenWords(Date.parse('2026-09-06T12:00:00Z'), now, 'Europe/London'), '6 days ago');
  assert.equal(whenWords(Date.parse('2026-09-05T12:00:00Z'), now, 'Europe/London'), 'on 5 September');
  assert.equal(whenWords(Date.parse('2025-12-31T12:00:00Z'), now), 'on 31 December 2025');
});

test('an unknown time zone is logged and treated as no zone', async () => {
  const h = harness();
  await h.say('my issues');
  await h.say('open one');
  const response = await h.say('comments', {timeZone: 'Mars/Olympus_Mons'});
  assert.match(spoken(response), /from Ana, on 11 September\./);
  assert.ok(h.logs.some((entry) => entry.level === 'warn' && entry.event === 'voice.timeZone.invalid'));
});
