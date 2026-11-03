import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {AlexaSkillConfig} from '../../../src/voice/alexa/config.ts';
import type {ResponseEnvelope} from '../../../src/voice/alexa/envelope.ts';
import {
  allowedEndpoint,
  ApplicationMismatchError,
  budgetBase,
  classifyFailure,
  createHandler,
  LateTurnError,
  parseTimeZone,
  redactCredentials,
  type FetchLike,
} from '../../../src/voice/alexa/handler.ts';
import {createJsonLogger} from '../../../src/voice/alexa/log.ts';
import {trackerIdentity} from '../../../src/voice/alexa/request.ts';
import {MESSAGES} from '../../../src/voice/alexa/messages.ts';
import type {ConversationDeps, VoiceRequest, VoiceResponse, VoiceTracker} from '../../../src/voice/core/types.ts';
import {
  ACCOUNT_TOKEN,
  API_ACCESS_TOKEN,
  captureLog,
  deferred,
  DEVICE_TIME_ZONE,
  ENROLLED_PERSON_ID,
  FakeClock,
  FIXTURE_TIME,
  loadEnvelope,
  memoryStore,
  PERSON_TOKEN,
  recordingFetch,
  testConfig,
  UNUSED_TRACKER,
} from './helpers.ts';

/** Every wait here is on an event; if the event never comes, the test fails at this bound instead of hanging. */
const BOUNDED = {timeout: 5000};

/** OD1 option B, the deliberate deploy parameters: account reads with the account-token fallback. */
const OPTION_B: Partial<AlexaSkillConfig> = {
  accountTokenFallback: true,
  policy: {...testConfig().policy, readAccepts: ['person', 'account']},
};

const ANSWER: VoiceResponse = {
  segments: [{text: 'You have 2 issues.', pauseAfter: 'short'}, {text: 'One: Login page times out.'}],
  listen: true,
  reprompt: [{text: 'Say a number to open one.'}],
  ratePercent: 100,
};

type Harness = ReturnType<typeof harness>;

interface HarnessOptions {
  converse?: (request: VoiceRequest, deps: ConversationDeps) => Promise<VoiceResponse>;
  config?: Partial<AlexaSkillConfig>;
  fetch?: FetchLike;
  trackerFor?: (token: string) => VoiceTracker;
  classifyFailure?: (error: unknown) => 'unknown';
}

function harness(t: TestContext, options: HarnessOptions = {}) {
  const clock = new FakeClock(FIXTURE_TIME);
  const logs = captureLog();
  const turns: Array<{request: VoiceRequest; deps: ConversationDeps}> = [];
  const tokens: string[] = [];
  const fetch = recordingFetch();
  const store = memoryStore();
  let storeCalls = 0;
  const handler = createHandler({
    config: testConfig(options.config),
    converse: async (request, deps) => {
      turns.push({request, deps});
      return options.converse ? options.converse(request, deps) : ANSWER;
    },
    trackerFor: (token) => {
      tokens.push(token);
      return options.trackerFor ? options.trackerFor(token) : UNUSED_TRACKER;
    },
    store: {
      load: (userId) => {
        storeCalls += 1;
        return store.load(userId);
      },
      save: (userId, serialized, version) => {
        storeCalls += 1;
        return store.save(userId, serialized, version);
      },
    },
    log: logs.log,
    clock,
    fetch: options.fetch ?? fetch.fetch,
    ...(options.classifyFailure ? {classifyFailure: options.classifyFailure} : {}),
  });
  t.after(() => {
    // Whatever a test left pending, nothing may ever write a credential to the log.
    const written = JSON.stringify(logs.records);
    for (const secret of [PERSON_TOKEN, ACCOUNT_TOKEN, API_ACCESS_TOKEN, 'SECRET']) {
      assert.equal(written.includes(secret), false, `log contains ${secret}`);
    }
  });
  return {handler, clock, logs, turns, tokens, fetch, store, storeCalls: () => storeCalls};
}

function speech(response: ResponseEnvelope): string {
  return response.response.outputSpeech?.ssml ?? '';
}

function infoText(h: Harness): string {
  return JSON.stringify(h.logs.records.filter((record) => record.level !== 'debug'));
}

test('the effective configuration is logged once at cold start, without ids', BOUNDED, (t) => {
  const h = harness(t);
  const config = h.logs.records.filter((record) => record.event === 'alexa.config');
  assert.equal(config.length, 1);
  assert.equal(config[0]?.level, 'info');
  assert.deepEqual(config[0]?.fields.readAccepts, ['person']);
  assert.equal(config[0]?.fields.accountLinkFallback, false);
  assert.equal(config[0]?.fields.enrolledPersonConfigured, true);
  assert.equal(infoText(h).includes(ENROLLED_PERSON_ID), false);
});

test(
  'default: an unrecognised voice with an account link is refused, with no card, core, tracker or store',
  BOUNDED,
  async (t) => {
    const h = harness(t);
    const response = await h.handler(loadEnvelope('intent-no-person'));

    assert.equal(h.turns.length, 0);
    assert.deepEqual(h.tokens, []);
    assert.equal(h.storeCalls(), 0);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(response.response.card, undefined);
    assert.equal(response.response.shouldEndSession, true);
    assert.match(speech(response), /I do not recognise your voice/);
    const refused = await h.logs.waitFor('alexa.speaker.refused');
    assert.deepEqual(refused.fields, {
      requestId: 'amzn1.echo-api.request.OPEN1',
      personPresent: false,
      personMatched: false,
      accountLinkPresent: true,
    });
  },
);

test(
  'default: the enrolled voice without its own link is asked to link, and no tracker is made',
  BOUNDED,
  async (t) => {
    const h = harness(t);
    const envelope = loadEnvelope('intent-person-match') as {context: {System: {person: {accessToken?: string}}}};
    delete envelope.context.System.person.accessToken;
    const response = await h.handler(envelope);

    assert.deepEqual(h.tokens, []);
    assert.equal(h.turns.length, 0);
    assert.deepEqual(response.response.card, {type: 'LinkAccount'});
    assert.match(speech(response), /not linked yet/);
  },
);

test(
  'default: the enrolled person with their own link reads, with person evidence and the person token',
  BOUNDED,
  async (t) => {
    const h = harness(t, {converse: async () => ({...ANSWER, card: {title: 'Issues', text: 'You have 2 issues.'}})});
    const response = await h.handler(loadEnvelope('intent-person-match'));

    assert.deepEqual(h.tokens, [PERSON_TOKEN]);
    assert.deepEqual(h.turns[0]?.request.speaker, {userId: `alexa:person:${ENROLLED_PERSON_ID}`, evidence: ['person']});
    assert.deepEqual(h.turns[0]?.request.input, {kind: 'intent', intent: 'list', slots: {scope: 'in-progress'}});
    assert.equal(h.turns[0]?.request.timeZone, DEVICE_TIME_ZONE);
    assert.ok(h.turns[0]?.deps.signal instanceof AbortSignal);
    assert.equal(h.turns[0]?.deps.signal?.aborted, false);
    // An Echo Show, but cards are off by default (OD2).
    assert.equal(response.response.card, undefined);
    assert.deepEqual(response.sessionAttributes, {
      speaker: {key: `alexa:person:${ENROLLED_PERSON_ID}`, identity: trackerIdentity('person', ENROLLED_PERSON_ID)},
      timeZone: DEVICE_TIME_ZONE,
    });

    const request = h.logs.records.find((record) => record.event === 'alexa.request');
    assert.equal(request?.level, 'info');
    assert.deepEqual(request?.fields.evidence, ['person']);
    assert.equal(request?.fields.personMatched, true);
    assert.equal(request?.fields.linkedVia, 'person');
    assert.deepEqual(request?.fields.slotNames, ['scope']);
    const info = infoText(h);
    assert.equal(info.includes(ENROLLED_PERSON_ID), false);
    assert.equal(info.includes('in-progress'), false);
    assert.equal(info.includes('Login page'), false);
    assert.equal(info.includes(DEVICE_TIME_ZONE), false);
  },
);

test('cards on: the Simple card reaches a screen device', BOUNDED, async (t) => {
  const h = harness(t, {
    config: {cards: true},
    converse: async () => ({...ANSWER, card: {title: 'Issues', text: 'You have 2 issues.'}}),
  });
  const response = await h.handler(loadEnvelope('intent-person-match'));
  assert.deepEqual(response.response.card, {type: 'Simple', title: 'Issues', content: 'You have 2 issues.'});
});

test('a recognised person who is not enrolled and has no link of their own is asked to link', BOUNDED, async (t) => {
  const h = harness(t);
  const response = await h.handler(loadEnvelope('intent-person-other'));
  assert.equal(h.turns.length, 0);
  assert.deepEqual(response.response.card, {type: 'LinkAccount'});
});

test('no link anywhere: refused by default; with the fallback on, asked to link', BOUNDED, async (t) => {
  const safe = harness(t);
  assert.match(speech(await safe.handler(loadEnvelope('intent-no-token'))), /I do not recognise your voice/);

  const fallback = harness(t, {config: OPTION_B});
  const response = await fallback.handler(loadEnvelope('intent-no-token'));
  assert.equal(fallback.turns.length, 0);
  assert.deepEqual(response.response.card, {type: 'LinkAccount'});
});

test('option B: an unrecognised voice reads with the account token and account evidence', BOUNDED, async (t) => {
  const h = harness(t, {config: OPTION_B});
  const response = await h.handler(loadEnvelope('launch'), {awsRequestId: 'c0ffee00-1111-2222-3333-444455556666'});

  assert.equal(h.turns.length, 1);
  assert.deepEqual(h.turns[0]?.request.input, {kind: 'launch'});
  assert.deepEqual(h.turns[0]?.request.speaker, {
    userId: 'alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT',
    evidence: ['account'],
  });
  assert.deepEqual(h.tokens, [ACCOUNT_TOKEN]);
  assert.deepEqual(response.response, {
    outputSpeech: {
      type: 'SSML',
      ssml: '<speak>You have 2 issues.<break time="350ms"/>One: Login page times out.</speak>',
    },
    shouldEndSession: false,
    reprompt: {outputSpeech: {type: 'SSML', ssml: '<speak>Say a number to open one.</speak>'}},
  });
  assert.equal(h.fetch.posts.length, 0, 'a fast answer sends no progressive response');
  for (const record of h.logs.records.filter((r) => r.level === 'info' && r.event !== 'alexa.config')) {
    assert.equal(record.fields.awsRequestId, 'c0ffee00-1111-2222-3333-444455556666', record.event);
  }
});

test('the time zone is fetched once per session with the api token, no redirects and a signal', BOUNDED, async (t) => {
  const h = harness(t);
  await h.handler(loadEnvelope('intent-person-match'));
  assert.equal(h.fetch.gets.length, 1);
  const get = h.fetch.gets[0];
  assert.equal(
    get?.url,
    'https://api.eu.amazonalexa.com/v2/devices/amzn1.ask.device.KITCHENECHO/settings/System.timeZone',
  );
  assert.equal(get?.init.headers.Authorization, `Bearer ${API_ACCESS_TOKEN}`);
  assert.equal(get?.init.redirect, 'error');
  assert.ok(get?.init.signal instanceof AbortSignal);
  await h.logs.waitFor('alexa.timeZone.resolved');

  // The next turn of the session carries the zone back, so no second lookup.
  const next = loadEnvelope('intent-person-match') as {session: {new: boolean; attributes: object}};
  next.session.new = false;
  next.session.attributes = {timeZone: 'America/New_York'};
  await h.handler(next);
  assert.equal(h.fetch.gets.length, 1);
  assert.equal(h.turns[1]?.request.timeZone, 'America/New_York');

  // A lookup that failed this session is not retried.
  next.session.attributes = {timeZone: null};
  await h.handler(next);
  assert.equal(h.fetch.gets.length, 1);
  assert.equal(h.turns[2]?.request.timeZone, undefined);
});

test('a failing or slow time-zone lookup is left out, logged at info, and the turn goes ahead', BOUNDED, async (t) => {
  const forbidden = harness(t, {
    fetch: async (_url, init) => ({status: init.method === 'GET' ? 403 : 204, text: async () => ''}),
  });
  const response = await forbidden.handler(loadEnvelope('intent-person-match'));
  assert.equal(forbidden.turns[0]?.request.timeZone, undefined);
  assert.equal('timeZone' in (forbidden.turns[0]?.request ?? {}), false);
  assert.deepEqual(response.sessionAttributes?.timeZone, null);
  const unavailable = await forbidden.logs.waitFor('alexa.timeZone.unavailable');
  assert.equal(unavailable.level, 'info');
  assert.equal(unavailable.fields.reason, 'status 403');

  const hanging = deferred<{status: number; text(): Promise<string>}>();
  const slow = harness(t, {fetch: () => hanging.promise});
  const pending = slow.handler(loadEnvelope('intent-person-match'));
  await slow.clock.timerDue(FIXTURE_TIME + 300);
  slow.clock.advanceTo(FIXTURE_TIME + 300);
  await pending;
  assert.equal(slow.turns[0]?.request.timeZone, undefined);
  assert.equal((await slow.logs.waitFor('alexa.timeZone.unavailable')).fields.reason, 'timeout');

  assert.equal(parseTimeZone('"Europe/London"'), 'Europe/London');
  assert.equal(parseTimeZone('Europe/London'), 'Europe/London');
  assert.equal(parseTimeZone('"Mars/Olympus_Mons"'), undefined);
  assert.equal(parseTimeZone('{"zone":"Europe/London"}'), undefined);
});

test('session pinning: an unrecognised follow-up reads the list read through the same link', BOUNDED, async (t) => {
  const h = harness(t, {config: OPTION_B});
  const first = await h.handler(loadEnvelope('intent-list-recognised'));
  const pinned = `alexa:person:${ENROLLED_PERSON_ID}:account`;
  const accountIdentity = trackerIdentity('account', 'amzn1.ask.account.HOUSEHOLDACCOUNT');
  assert.deepEqual(first.sessionAttributes?.speaker, {key: pinned, identity: accountIdentity});

  const second = loadEnvelope('intent-open-unrecognised') as {session: {attributes: object}};
  second.session.attributes = first.sessionAttributes ?? {};
  await h.handler(second);

  assert.equal(h.turns[0]?.request.speaker.userId, pinned);
  assert.equal(h.turns[1]?.request.speaker.userId, pinned);
  assert.deepEqual(h.turns[1]?.request.speaker.evidence, ['account']);
  assert.equal(h.fetch.gets.length, 1, 'the time zone came back in the attributes');

  // A pin read under another tracker identity is never reused, and the turn starts fresh for this session.
  const crossed = loadEnvelope('intent-open-unrecognised') as {session: {attributes: object}};
  crossed.session.attributes = {
    speaker: {key: `alexa:person:${ENROLLED_PERSON_ID}`, identity: trackerIdentity('person', ENROLLED_PERSON_ID)},
  };
  await h.handler(crossed);
  assert.match(
    h.turns[2]?.request.speaker.userId ?? '',
    /^alexa:user:amzn1\.ask\.account\.HOUSEHOLDACCOUNT:session:[0-9a-f]{12}$/,
  );
  const request = h.logs.records.filter((record) => record.event === 'alexa.request').at(-1);
  assert.equal(request?.fields.speakerKey, 'fresh');
});

test('wrong applicationId is rejected before anything else happens, whatever the request type', BOUNDED, async (t) => {
  const h = harness(t);
  await assert.rejects(h.handler(loadEnvelope('wrong-application')), ApplicationMismatchError);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.tokens, []);
  assert.equal(h.logs.records.at(-1)?.event, 'alexa.application.rejected');

  const mixed = loadEnvelope('launch') as {session: {application: {applicationId: string}}};
  mixed.session.application.applicationId = 'amzn1.ask.skill.OTHER';
  await assert.rejects(h.handler(mixed), ApplicationMismatchError);

  const foreignUnsupported = loadEnvelope('wrong-application') as {request: {type: string}};
  foreignUnsupported.request.type = 'System.ExceptionEncountered';
  await assert.rejects(h.handler(foreignUnsupported), ApplicationMismatchError);

  const ownUnsupported = loadEnvelope('launch') as {request: {type: string}};
  ownUnsupported.request.type = 'System.ExceptionEncountered';
  assert.deepEqual(await h.handler(ownUnsupported), {version: '1.0', response: {}});
  await assert.rejects(h.handler({hello: 'world'}), /invalid Alexa request envelope/);
});

test('SearchQuery and entity resolution reach the core as mapped', BOUNDED, async (t) => {
  const h = harness(t);
  await h.handler(loadEnvelope('search-query'));
  await h.handler(loadEnvelope('entity-resolution'));
  await h.handler(loadEnvelope('entity-resolution-no-match'));
  assert.deepEqual(
    h.turns.map((turn) => turn.request.input),
    [
      {kind: 'intent', intent: 'find', slots: {words: 'login page times out'}},
      {kind: 'intent', intent: 'read', slots: {part: 'comments'}},
      {kind: 'intent', intent: 'read', slots: {part: 'comment'}},
    ],
  );
});

test('session ended: the core is called, and Alexa gets an empty response', BOUNDED, async (t) => {
  const h = harness(t);
  const response = await h.handler(loadEnvelope('session-ended'));
  assert.deepEqual(response, {version: '1.0', response: {}});
  assert.deepEqual(h.turns[0]?.request.input, {kind: 'sessionEnded', reason: 'silence'});
  assert.equal(h.fetch.calls.length, 0, 'no time-zone lookup or progressive response for a closed session');

  const unlinked = loadEnvelope('session-ended') as {context: {System: {person?: unknown}}};
  delete unlinked.context.System.person;
  assert.deepEqual(await h.handler(unlinked), {version: '1.0', response: {}});
  assert.equal(h.turns.length, 1, 'no core turn without a usable credential');
});

test("session ended with Amazon's error: type and reason at info, message only at debug", BOUNDED, async (t) => {
  const h = harness(t);
  await h.handler(loadEnvelope('session-ended-error'));
  const request = await h.logs.waitFor('alexa.request');
  assert.equal(request.fields.sessionEndReason, 'ERROR');
  assert.equal(request.fields.sessionEndErrorType, 'INVALID_RESPONSE');
  assert.equal(infoText(h).includes('secret summary'), false);
  const detail = await h.logs.waitFor('alexa.request.detail');
  assert.equal(detail.level, 'debug');
  assert.match(String(detail.fields.sessionEndErrorMessage), /secret summary/);
});

test('slow core: a progressive response at 5 s, then the core answer if it arrives in time', BOUNDED, async (t) => {
  const slow = deferred<VoiceResponse>();
  const h = harness(t, {converse: () => slow.promise});
  const pending = h.handler(loadEnvelope('intent-person-match'));

  await h.clock.timerDue(FIXTURE_TIME + 7000);
  h.clock.advanceTo(FIXTURE_TIME + 5000);

  const call = await h.fetch.called;
  assert.equal(call.url, 'https://api.eu.amazonalexa.com/v1/directives');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(call.init.headers, {
    Authorization: `Bearer ${API_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(call.init.body ?? '{}'), {
    header: {requestId: 'amzn1.echo-api.request.LIST1'},
    directive: {type: 'VoicePlayer.Speak', speech: '<speak>One moment.</speak>'},
  });
  await h.logs.waitFor('alexa.progressive.sent');

  h.clock.advanceTo(FIXTURE_TIME + 6000);
  slow.resolve(ANSWER);
  const response = await pending;
  assert.match(speech(response), /You have 2 issues/);
  assert.equal(h.fetch.posts.length, 1);
});

test('an in-flight progressive response is awaited for at most 300 ms, never past the deadline', BOUNDED, async (t) => {
  const slow = deferred<VoiceResponse>();
  const post = deferred<{status: number; text(): Promise<string>}>();
  const gets = recordingFetch();
  const h = harness(t, {
    converse: () => slow.promise,
    fetch: (url, init) => (init.method === 'POST' ? post.promise : gets.fetch(url, init)),
  });
  let answered = false;
  const pending = h.handler(loadEnvelope('intent-person-match')).then((response) => {
    answered = true;
    return response;
  });

  await h.clock.timerDue(FIXTURE_TIME + 7000);
  h.clock.advanceTo(FIXTURE_TIME + 5500);
  slow.resolve(ANSWER);
  await h.clock.timerDue(FIXTURE_TIME + 5800);
  assert.equal(answered, false, 'still waiting for the progressive POST');
  h.clock.advanceTo(FIXTURE_TIME + 5800);
  assert.match(speech(await pending), /You have 2 issues/);

  // Near the deadline, the wait shrinks to what is left: here the POST starts at 6.5 s and the core answers at 6.9 s.
  const late = deferred<VoiceResponse>();
  const post2 = deferred<{status: number; text(): Promise<string>}>();
  const h2 = harness(t, {
    config: {progressiveAfterMs: 6500},
    converse: () => late.promise,
    fetch: (url, init) => (init.method === 'POST' ? post2.promise : gets.fetch(url, init)),
  });
  let answered2 = false;
  const pending2 = h2.handler(loadEnvelope('intent-person-match')).then((response) => {
    answered2 = true;
    return response;
  });
  await h2.clock.timerDue(FIXTURE_TIME + 7000);
  h2.clock.advanceTo(FIXTURE_TIME + 6900);
  late.resolve(ANSWER);
  // Timers so far: time zone, progressive, deadline, POST timeout; the fifth is the settle wait.
  await h2.clock.timerArmed(5);
  assert.equal(h2.clock.dueTimes.at(-1), FIXTURE_TIME + 7000);
  assert.equal(answered2, false);
  h2.clock.advanceTo(FIXTURE_TIME + 7000);
  assert.match(speech(await pending2), /You have 2 issues/);
  post.resolve({status: 204, text: async () => ''});
  post2.resolve({status: 204, text: async () => ''});
});

test(
  'slow core: an honest answer before Amazon gives up, the turn is aborted, and the late answer logged',
  BOUNDED,
  async (t) => {
    const slow = deferred<VoiceResponse>();
    let signal: AbortSignal | undefined;
    const h = harness(t, {
      converse: (_request, deps) => {
        signal = deps.signal;
        return slow.promise;
      },
    });
    const pending = h.handler(loadEnvelope('intent-person-match'));

    await h.clock.timerDue(FIXTURE_TIME + 7000);
    h.clock.advanceTo(FIXTURE_TIME + 7000);
    const response = await pending;

    assert.equal(signal?.aborted, true);
    assert.equal(h.fetch.posts.length, 1);
    assert.match(speech(response), /taking too long/);
    assert.equal(response.response.shouldEndSession, false);
    assert.match(response.response.reprompt?.outputSpeech.ssml ?? '', /Ask again/);
    assert.deepEqual(response.sessionAttributes?.speaker, {
      key: `alexa:person:${ENROLLED_PERSON_ID}`,
      identity: trackerIdentity('person', ENROLLED_PERSON_ID),
    });
    const timeout = h.logs.records.find((record) => record.event === 'alexa.turn.timeout');
    assert.equal(timeout?.level, 'error');
    assert.equal(timeout?.fields.elapsedMs, 7000);

    slow.resolve(ANSWER);
    await h.logs.waitFor('alexa.turn.lateAnswer');
  },
);

test('a timed-out turn can no longer call the tracker or save, and a newer save stands', BOUNDED, async (t) => {
  const gate = deferred<void>();
  const trackerCalls: string[] = [];
  const outcomes: string[] = [];
  let turn = 0;
  const h = harness(t, {
    trackerFor: () => ({
      ...UNUSED_TRACKER,
      listIssues: async () => {
        trackerCalls.push('listIssues');
        return {issues: [], complete: true};
      },
    }),
    converse: async (request, deps) => {
      turn += 1;
      const loaded = await deps.store.load(request.speaker.userId);
      if (turn === 1) {
        await gate.promise;
        await deps.tracker.listIssues({limit: 5}).then(
          () => outcomes.push('tracker ran'),
          (error: unknown) => outcomes.push(error instanceof LateTurnError ? 'tracker refused' : 'tracker failed'),
        );
        await deps.store.save(request.speaker.userId, 'state-from-turn-1', loaded?.version ?? null).then(
          (saved) => outcomes.push(saved ? 'save ran' : 'save conflicted'),
          (error: unknown) => outcomes.push(error instanceof LateTurnError ? 'save refused' : 'save failed'),
        );
      } else {
        await deps.store.save(request.speaker.userId, 'state-from-turn-2', loaded?.version ?? null);
      }
      return {segments: [{text: 'ok'}], listen: false, ratePercent: 100};
    },
  });

  const first = h.handler(loadEnvelope('intent-person-match'));
  await h.clock.timerDue(FIXTURE_TIME + 7000);
  h.clock.advanceTo(FIXTURE_TIME + 7000);
  assert.match(speech(await first), /taking too long/);

  const again = loadEnvelope('intent-person-match') as {request: {timestamp: string}};
  again.request.timestamp = new Date(FIXTURE_TIME + 7000).toISOString();
  await h.handler(again);

  gate.resolve();
  const refused = await h.logs.waitForCount('alexa.turn.lateEffectRefused', 2);
  assert.deepEqual(
    refused.map((record) => record.fields.effect),
    ['listIssues', 'save'],
  );
  await h.logs.waitFor('alexa.turn.lateAnswer');
  assert.deepEqual(outcomes, ['tracker refused', 'save refused']);
  assert.deepEqual(trackerCalls, []);
  assert.equal(h.store.data.get(`alexa:person:${ENROLLED_PERSON_ID}`)?.serialized, 'state-from-turn-2');
});

test('the budget counts from the request timestamp, up to a minute old', BOUNDED, async (t) => {
  assert.equal(budgetBase(FIXTURE_TIME, new Date(FIXTURE_TIME - 5000).toISOString()), FIXTURE_TIME - 5000);
  assert.equal(budgetBase(FIXTURE_TIME, new Date(FIXTURE_TIME - 120_000).toISOString()), FIXTURE_TIME);
  assert.equal(budgetBase(FIXTURE_TIME, new Date(FIXTURE_TIME + 2000).toISOString()), FIXTURE_TIME);
  assert.equal(budgetBase(FIXTURE_TIME, 'not a time'), FIXTURE_TIME);

  const cases: Array<[number, number]> = [
    [-5000, FIXTURE_TIME + 2000],
    [-120_000, FIXTURE_TIME + 7000],
  ];
  for (const [offset, deadline] of cases) {
    const h = harness(t);
    const envelope = loadEnvelope('intent-person-match') as {request: {timestamp: string}};
    envelope.request.timestamp = new Date(FIXTURE_TIME + offset).toISOString();
    await h.handler(envelope);
    assert.ok(h.clock.dueTimes.includes(deadline), `stamped ${offset}: ${h.clock.dueTimes.join(', ')}`);
  }
});

test('a request already past the answer deadline gets the honest answer at once', BOUNDED, async (t) => {
  const h = harness(t);
  const envelope = loadEnvelope('intent-person-match') as {request: {timestamp: string}};
  envelope.request.timestamp = new Date(FIXTURE_TIME - 7500).toISOString();
  const response = await h.handler(envelope);
  assert.match(speech(response), /taking too long/);
  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.tokens, []);
});

test('a progressive response is never sent to an endpoint off the allowlist', BOUNDED, async (t) => {
  const slow = deferred<VoiceResponse>();
  const h = harness(t, {converse: () => slow.promise});
  const envelope = loadEnvelope('intent-person-match') as {context: {System: {apiEndpoint: string}}};
  envelope.context.System.apiEndpoint = 'https://attacker.example';
  const pending = h.handler(envelope);

  await h.clock.timerDue(FIXTURE_TIME + 7000);
  h.clock.advanceTo(FIXTURE_TIME + 5000);
  const skipped = await h.logs.waitFor('alexa.progressive.skipped');
  assert.equal(skipped.fields.reason, 'api endpoint not allowed');
  slow.resolve(ANSWER);
  await pending;
  assert.equal(h.fetch.calls.length, 0);
});

test('a failing or hanging progressive response is logged and does not affect the answer', BOUNDED, async (t) => {
  const slow = deferred<VoiceResponse>();
  const gets = recordingFetch();
  const h = harness(t, {
    converse: () => slow.promise,
    fetch: async (url, init) => {
      if (init.method === 'GET') return gets.fetch(url, init);
      throw new TypeError('fetch failed');
    },
  });
  const pending = h.handler(loadEnvelope('intent-person-match'));
  await h.clock.timerDue(FIXTURE_TIME + 7000);
  h.clock.advanceTo(FIXTURE_TIME + 5000);
  const failed = await h.logs.waitFor('alexa.progressive.failed');
  assert.equal(failed.fields.errorName, 'TypeError');
  slow.resolve(ANSWER);
  assert.match(speech(await pending), /You have 2 issues/);

  const never = deferred<VoiceResponse>();
  const hang = harness(t, {
    converse: () => never.promise,
    fetch: (url, init) => (init.method === 'GET' ? gets.fetch(url, init) : new Promise(() => {})),
  });
  const pending2 = hang.handler(loadEnvelope('intent-person-match'));
  await hang.clock.timerDue(FIXTURE_TIME + 7000);
  hang.clock.advanceTo(FIXTURE_TIME + 5000);
  await hang.clock.timerDue(FIXTURE_TIME + 6000);
  hang.clock.advanceTo(FIXTURE_TIME + 6000);
  const timedOut = await hang.logs.waitFor('alexa.progressive.failed');
  assert.equal(timedOut.fields.errorName, 'TimeoutError');
  never.resolve(ANSWER);
  await pending2;
});

test(
  'core throws: a spoken, non-leaking message, with status and code at info and credentials redacted at debug',
  BOUNDED,
  async (t) => {
    const h = harness(t, {
      converse: async () => {
        throw Object.assign(
          new Error(
            `GET https://tracker.example/api/issues?query=Salary%20review failed with Authorization: Bearer ${PERSON_TOKEN} and ${API_ACCESS_TOKEN}`,
          ),
          {status: 403, code: 'Forbidden'},
        );
      },
    });
    const response = await h.handler(loadEnvelope('intent-person-match'));

    const ssml = speech(response);
    assert.match(ssml, /Something went wrong on my side/);
    assert.equal(ssml.includes('Salary'), false);
    assert.equal(response.response.shouldEndSession, false);

    const failed = h.logs.records.find((record) => record.event === 'alexa.turn.failed');
    assert.equal(failed?.level, 'error');
    assert.equal(failed?.fields.failure, 'unknown');
    assert.equal(failed?.fields.status, 403);
    assert.equal(failed?.fields.errorCode, 'Forbidden');
    assert.equal(infoText(h).includes('Salary'), false);
    const detail = await h.logs.waitFor('alexa.turn.failed.detail');
    assert.equal(detail.level, 'debug');
    assert.match(String(detail.fields.message), /\[redacted\]/);
  },
);

test('an expired or revoked link (401) asks to relink with a LinkAccount card', BOUNDED, async (t) => {
  const h = harness(t, {
    converse: async () => {
      throw Object.assign(new Error('Unauthorized'), {status: 401});
    },
  });
  const response = await h.handler(loadEnvelope('intent-person-match'));
  assert.deepEqual(response.response.card, {type: 'LinkAccount'});
  assert.match(speech(response), /expired or was removed/);
  assert.equal(response.response.shouldEndSession, true);
});

test('an unreachable or throttled tracker, or a throwing trackerFor, is spoken about plainly', BOUNDED, async (t) => {
  for (const error of [Object.assign(new Error('down'), {status: 503}), {name: 'ThrottlingException'}]) {
    const down = harness(t, {
      converse: async () => {
        throw error;
      },
    });
    assert.match(speech(await down.handler(loadEnvelope('intent-person-match'))), /not answering/);
  }

  const broken = harness(t, {
    trackerFor: () => {
      throw new Error('malformed token');
    },
  });
  const response = await broken.handler(loadEnvelope('intent-person-match'));
  assert.equal(broken.turns.length, 0);
  assert.equal(speech(response).includes(MESSAGES.somethingWentWrong[0].text), true);
});

test('a throwing classifier in the late path is contained and logged as unknown', BOUNDED, async (t) => {
  const slow = deferred<VoiceResponse>();
  const h = harness(t, {
    converse: () => slow.promise,
    classifyFailure: () => {
      throw new Error('classifier bug');
    },
  });
  const pending = h.handler(loadEnvelope('intent-person-match'));
  await h.clock.timerDue(FIXTURE_TIME + 7000);
  h.clock.advanceTo(FIXTURE_TIME + 7000);
  await pending;
  slow.reject(new Error('late'));
  const late = await h.logs.waitFor('alexa.turn.lateFailure');
  assert.equal(late.fields.failure, 'unknown');
});

test(
  'enrolment log: the personId at info only while ENROLMENT_LOG is on, and nothing else extra',
  BOUNDED,
  async (t) => {
    const on = harness(t, {config: {enrolmentLog: true}});
    await on.handler(loadEnvelope('intent-person-match'));
    const carrying = on.logs.records.filter(
      (record) => record.level !== 'debug' && JSON.stringify(record).includes(ENROLLED_PERSON_ID),
    );
    assert.deepEqual(
      carrying.map((record) => record.event),
      ['alexa.enrolment.person'],
    );
    const info = infoText(on);
    assert.equal(info.includes('<speak>'), false);
    assert.equal(info.includes('in-progress'), false);

    const off = harness(t);
    await off.handler(loadEnvelope('intent-person-match'));
    assert.equal(infoText(off).includes(ENROLLED_PERSON_ID), false);
  },
);

test('classifyFailure reads common error shapes', () => {
  assert.equal(classifyFailure(Object.assign(new Error('x'), {statusCode: 401})), 'unauthorized');
  assert.equal(classifyFailure({response: {status: 429}}), 'unavailable');
  assert.equal(classifyFailure(Object.assign(new Error('x'), {status: 403})), 'unknown');
  assert.equal(classifyFailure(new DOMException('aborted', 'AbortError')), 'unavailable');
  assert.equal(classifyFailure(new TypeError('fetch failed', {cause: {code: 'ECONNRESET'}})), 'unavailable');
  assert.equal(classifyFailure({name: 'ProvisionedThroughputExceededException'}), 'unavailable');
  assert.equal(classifyFailure('a string'), 'unknown');
});

test('redactCredentials removes known secrets and bearer tokens', () => {
  assert.equal(
    redactCredentials('token abc123 then Bearer xyz.789, done', ['abc123']),
    'token [redacted] then Bearer [redacted], done',
  );
});

test('allowedEndpoint accepts only HTTPS Alexa API hosts', () => {
  const hosts = testConfig().apiEndpointHosts;
  assert.equal(allowedEndpoint('https://api.amazonalexa.com', hosts), 'https://api.amazonalexa.com');
  assert.equal(allowedEndpoint('https://api.fe.amazonalexa.com/', hosts), 'https://api.fe.amazonalexa.com');
  assert.equal(allowedEndpoint('http://api.amazonalexa.com', hosts), undefined);
  assert.equal(allowedEndpoint('https://api.amazonalexa.com.attacker.example', hosts), undefined);
  assert.equal(allowedEndpoint('https://user:pw@api.amazonalexa.com', hosts), undefined);
  assert.equal(allowedEndpoint('https://api.amazonalexa.com:8443', hosts), undefined);
  assert.equal(allowedEndpoint('not a url', hosts), undefined);
});

test('the JSON logger drops levels below its threshold and redacts credential-named fields', () => {
  const lines: string[] = [];
  const log = createJsonLogger({level: 'info', write: (line) => lines.push(line), now: () => FIXTURE_TIME});
  log('debug', 'hidden', {speech: 'content'});
  log('info', 'shown', {count: 2, accessToken: PERSON_TOKEN, nested: {headers: {Authorization: 'Bearer x'}}});
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? '{}'), {
    time: '2026-09-12T10:00:00.000Z',
    level: 'info',
    event: 'shown',
    count: 2,
    accessToken: '[redacted]',
    nested: {headers: {Authorization: '[redacted]'}},
  });
});

test('full requests at debug level, in both modes, write no credential through the real logger', BOUNDED, async () => {
  for (const config of [testConfig(), testConfig(OPTION_B)]) {
    const lines: string[] = [];
    const handler = createHandler({
      config,
      converse: async () => ANSWER,
      trackerFor: () => UNUSED_TRACKER,
      store: memoryStore(),
      log: createJsonLogger({level: 'debug', write: (line) => lines.push(line)}),
      clock: new FakeClock(FIXTURE_TIME),
      fetch: recordingFetch().fetch,
    });
    const fixtures = ['launch', 'intent-person-match', 'search-query', 'session-ended', 'session-ended-error'];
    for (const fixture of [...fixtures, 'intent-no-token', 'intent-no-person']) {
      await handler(loadEnvelope(fixture));
    }
    const written = lines.join('\n');
    assert.ok(lines.length > 10);
    // Nothing the adapter logs on purpose is named like a credential, so the redaction guard never fires.
    assert.equal(written.includes('[redacted]'), false);
    assert.ok(written.includes(ENROLLED_PERSON_ID), 'debug carries the raw personId');
    for (const secret of [PERSON_TOKEN, ACCOUNT_TOKEN, API_ACCESS_TOKEN]) assert.equal(written.includes(secret), false);
  }
});
