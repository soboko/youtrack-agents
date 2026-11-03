/**
 * YA-36 on Alexa: the place slot, the Device Address call, the consent card, the generated model, and air quality
 * without a linked account while tracker intents keep the link prompt.
 */
import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {AlexaSkillConfig} from '../../../src/voice/alexa/config.ts';
import {COUNTRY_AND_POSTAL_CODE_SCOPE} from '../../../src/voice/alexa/config.ts';
import type {ResponseEnvelope} from '../../../src/voice/alexa/envelope.ts';
import {
  createHandler,
  NotLinkedError,
  parseCountryAndPostalCode,
  UNLINKED_KEY_SUFFIX,
  type FetchInit,
} from '../../../src/voice/alexa/handler.ts';
import {buildInteractionModel} from '../../../src/voice/alexa/model.ts';
import {mapRequest} from '../../../src/voice/alexa/request.ts';
import {INTENT_CATALOGUE} from '../../../src/voice/core/intents.ts';
import {parseUtterance} from '../../../src/voice/core/grammar.ts';
import type {AirQualityPort, ConversationDeps, VoiceRequest, VoiceResponse} from '../../../src/voice/core/types.ts';
import {
  ACCOUNT_TOKEN,
  API_ACCESS_TOKEN,
  captureLog,
  DEVICE_TIME_ZONE,
  FakeClock,
  FIXTURE_TIME,
  loadEnvelope,
  memoryStore,
  PERSON_TOKEN,
  testConfig,
  UNUSED_TRACKER,
} from './helpers.ts';

const BOUNDED = {timeout: 5000};
const ANSWER: VoiceResponse = {
  segments: [{text: 'Air quality near 5 9 8 0 2 is Moderate.'}],
  listen: true,
  reprompt: [{text: "Say 'air quality in' and a town, or 'stop'."}],
  ratePercent: 100,
};
const ADDRESS_URL =
  'https://api.eu.amazonalexa.com/v1/devices/amzn1.ask.device.KITCHENECHO/settings/address/countryAndPostalCode';

/** The unlinked envelope, turned into an intent with the given slots. */
function intentEnvelope(name: string, slots: Record<string, string> = {}, base = 'intent-no-token') {
  const event = loadEnvelope(base) as {request: {intent: {name: string; slots: Record<string, unknown>}}};
  event.request.intent = {
    name,
    slots: Object.fromEntries(
      Object.entries(slots).map(([slot, value]) => [slot, {name: slot, value, confirmationStatus: 'NONE'}]),
    ),
  } as {name: string; slots: Record<string, unknown>};
  return event;
}

type AddressAnswer = {status: number; body?: string} | 'hang';

function harness(t: TestContext, options: {config?: Partial<AlexaSkillConfig>; address?: AddressAnswer} = {}) {
  const clock = new FakeClock(FIXTURE_TIME);
  const logs = captureLog();
  const turns: Array<{request: VoiceRequest; deps: ConversationDeps}> = [];
  const tokens: string[] = [];
  const calls: Array<{url: string; init: FetchInit}> = [];
  const store = memoryStore();
  const airQuality: AirQualityPort = {
    lookupIndoor: async () => ({kind: 'unavailable'}),
    lookupHere: async () => ({used: 'home', result: {kind: 'noLocation'}}),
    lookupNamed: async () => ({matched: 'none', result: {kind: 'notFound'}}),
  };
  const handler = createHandler({
    config: testConfig(options.config),
    converse: async (request, deps) => {
      turns.push({request, deps});
      return ANSWER;
    },
    trackerFor: (token) => {
      tokens.push(token);
      return UNUSED_TRACKER;
    },
    store,
    log: logs.log,
    clock,
    airQuality,
    fetch: async (url, init) => {
      calls.push({url, init});
      if (url.endsWith('/countryAndPostalCode')) {
        const answer = options.address ?? {status: 200, body: '{"countryCode":"US","postalCode":"59802"}'};
        if (answer === 'hang') return new Promise(() => {});
        return {status: answer.status, text: async () => answer.body ?? ''};
      }
      if (init.method === 'GET') return {status: 200, text: async () => JSON.stringify(DEVICE_TIME_ZONE)};
      return {status: 204, text: async () => ''};
    },
  });
  t.after(() => {
    const written = JSON.stringify(logs.records);
    for (const secret of [PERSON_TOKEN, ACCOUNT_TOKEN, API_ACCESS_TOKEN]) {
      assert.equal(written.includes(secret), false, `log contains ${secret}`);
    }
    const info = JSON.stringify(logs.records.filter((record) => record.level !== 'debug'));
    assert.equal(info.includes('59802'), false, 'the postal code is logged at debug only');
  });
  return {handler, clock, logs, turns, tokens, calls, store, airQuality};
}

function speech(response: ResponseEnvelope): string {
  return response.response.outputSpeech?.ssml ?? '';
}

test('the split model maps a place slot and a slot-less here request separately', () => {
  const heard = parseUtterance('what the air quality is in salt lake');
  assert.equal(heard.matched, true);
  if (heard.matched) {
    assert.equal(heard.intent, 'airQualityPlace');
    assert.deepEqual(heard.slots, {place: 'salt lake'});
  }
  const mapped = mapRequest(
    intentEnvelope('AirQualityPlaceIntent', {place: 'rattlesnake creek'}) as never,
    testConfig(),
  );
  assert.deepEqual(mapped.voice.input, {
    kind: 'intent',
    intent: 'airQualityPlace',
    slots: {place: 'rattlesnake creek'},
  });
  const bare = mapRequest(intentEnvelope('AirQualityHereIntent') as never, testConfig());
  assert.deepEqual(bare.voice.input, {kind: 'intent', intent: 'airQuality', slots: {}});
  const inside = mapRequest(intentEnvelope('AirQualityIndoorIntent') as never, testConfig());
  assert.deepEqual(inside.voice.input, {kind: 'intent', intent: 'airQualityIndoor', slots: {}});
  assert.equal(bare.voice.deviceLocation, undefined, 'the mapper makes no network call; the handler adds it');
});

test('the model splits slot-less here from SearchQuery place requests', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, {invocationName: 'issue desk'});
  const intent = model.interactionModel.languageModel.intents.find(
    (candidate) => candidate.name === 'AirQualityPlaceIntent',
  );
  assert.ok(intent !== undefined);
  assert.deepEqual(intent.slots, [{name: 'place', type: 'AMAZON.SearchQuery'}]);
  assert.ok(intent.samples.includes("what's the air quality in {place}"));
  assert.ok(intent.samples.includes('what the air quality is in {place}'));
  assert.ok(intent.samples.includes('air quality is {place}'));
  for (const sample of intent.samples.filter((candidate) => candidate.includes('{place}'))) {
    assert.notEqual(sample.replace('{place}', '').trim(), '', `"${sample}" needs carrier words`);
    assert.equal((sample.match(/\{/g) ?? []).length, 1, `"${sample}" holds one slot only`);
  }
  const here = model.interactionModel.languageModel.intents.find(
    (candidate) => candidate.name === 'AirQualityHereIntent',
  );
  assert.ok(here !== undefined);
  assert.equal(here.slots, undefined);
  assert.ok(here.samples.includes('a. q. i. here'));
  assert.equal(here.samples.includes('air quality'), false, 'a bare prefix steals place requests from SearchQuery');
  const indoor = model.interactionModel.languageModel.intents.find(
    (candidate) => candidate.name === 'AirQualityIndoorIntent',
  );
  assert.ok(indoor !== undefined);
  assert.equal(indoor.slots, undefined);
  assert.ok(indoor.samples.includes("what's the air quality inside"));
});

test(
  'unlinked: air quality reaches the core, with no tracker, its own state record and the device postal code',
  BOUNDED,
  async (t) => {
    const h = harness(t);
    const response = await h.handler(intentEnvelope('AirQualityIntent'));

    assert.equal(h.turns.length, 1);
    assert.deepEqual(h.tokens, [], 'no tracker is made');
    const request = h.turns[0].request;
    assert.equal(request.speaker.userId, `alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT${UNLINKED_KEY_SUFFIX}`);
    assert.deepEqual(request.deviceLocation, {countryCode: 'US', postalCode: '59802'});
    assert.equal(h.turns[0].deps.airQuality, h.airQuality);
    await assert.rejects(h.turns[0].deps.tracker.listIssues({limit: 1}), NotLinkedError);
    assert.match(speech(response), /Air quality near/);
    assert.equal(response.response.card, undefined);
    assert.deepEqual(
      response.sessionAttributes,
      {airFollowUp: true},
      'an unlinked turn pins nothing, and marks the follow-up',
    );

    const address = h.calls.filter((call) => call.url.endsWith('/countryAndPostalCode'));
    assert.equal(address.length, 1);
    assert.equal(address[0].url, ADDRESS_URL);
    assert.equal(address[0].init.headers.Authorization, `Bearer ${API_ACCESS_TOKEN}`);
    assert.equal(address[0].init.redirect, 'error');
    assert.equal(
      h.calls.some((call) => call.url.includes('/settings/address/') && !call.url.endsWith('countryAndPostalCode')),
      false,
      'never the full address',
    );
    assert.equal((await h.logs.waitFor('alexa.address')).fields.outcome, 'located');
  },
);

test(
  'unlinked: "my issues" and help still get the link prompt (fallback on) or the refusal (fallback off)',
  BOUNDED,
  async (t) => {
    const on = harness(t, {
      config: {accountTokenFallback: true, policy: {...testConfig().policy, readAccepts: ['person', 'account']}},
    });
    for (const name of ['ListIntent', 'AMAZON.HelpIntent']) {
      const response = await on.handler(intentEnvelope(name, name === 'ListIntent' ? {scope: 'mine'} : {}));
      assert.deepEqual(response.response.card, {type: 'LinkAccount'}, name);
    }
    assert.equal(on.turns.length, 0);
    assert.equal(on.calls.length, 0, 'no address call for a tracker intent');

    const off = harness(t);
    assert.match(
      speech(await off.handler(intentEnvelope('ListIntent', {scope: 'mine'}))),
      /I do not recognise your voice/,
    );
    assert.match(speech(await off.handler(intentEnvelope('AirQualityIntent', {place: 'missoula'}))), /Air quality/);
    assert.equal(off.turns.length, 1);
  },
);

test(
  'unlinked: repeat, stop and cancel run without a link; a number only right after an unlinked air answer',
  BOUNDED,
  async (t) => {
    const h = harness(t);
    for (const name of ['AMAZON.RepeatIntent', 'AMAZON.StopIntent', 'AMAZON.CancelIntent']) {
      await h.handler(intentEnvelope(name));
    }
    assert.equal(h.turns.length, 3);
    assert.ok(h.turns.every((turn) => turn.request.speaker.userId.endsWith(UNLINKED_KEY_SUFFIX)));
    assert.equal(h.calls.length, 0, 'the address is only asked for on an air-quality turn');

    // An unlinked "open two" out of the blue is refused, as before YA-36.
    const cold = await h.handler(intentEnvelope('OpenIntent', {ordinal: '2'}));
    assert.match(speech(cold), /I do not recognise your voice/);
    assert.equal(h.turns.length, 3);

    // After an unlinked air-quality answer, the session carries the follow-up mark, and "two" reaches the core.
    const air = await h.handler(intentEnvelope('AirQualityIntent', {place: 'springfield'}));
    assert.equal(air.sessionAttributes?.airFollowUp, true);
    const next = intentEnvelope('OpenIntent', {ordinal: '2'}) as unknown as {
      session: {new: boolean; attributes: Record<string, unknown>};
    };
    next.session.new = false;
    next.session.attributes = air.sessionAttributes ?? {};
    const answered = await h.handler(next);
    assert.equal(h.turns.length, 5);
    assert.equal(answered.sessionAttributes?.airFollowUp, undefined, 'the choice is answered; the mark is gone');
    assert.ok(h.turns[4].request.speaker.userId.endsWith(UNLINKED_KEY_SUFFIX));
  },
);

test(
  'linked: air quality runs the normal turn, with the tracker, the time zone and the device postal code',
  BOUNDED,
  async (t) => {
    const h = harness(t);
    await h.handler(intentEnvelope('AirQualityIntent', {}, 'intent-person-match'));
    assert.deepEqual(h.tokens, [PERSON_TOKEN]);
    assert.equal(h.turns[0].request.timeZone, DEVICE_TIME_ZONE);
    assert.deepEqual(h.turns[0].request.deviceLocation, {countryCode: 'US', postalCode: '59802'});
    assert.equal(h.turns[0].request.speaker.userId.endsWith(UNLINKED_KEY_SUFFIX), false);
  },
);

test(
  'permission not granted (403): no location, home is used, and the consent card only once the owner turns it on',
  BOUNDED,
  async (t) => {
    const off = harness(t, {address: {status: 403}});
    const plain = await off.handler(intentEnvelope('AirQualityIntent'));
    assert.equal(off.turns[0].request.deviceLocation, undefined);
    assert.equal(plain.response.card, undefined, 'no card for a permission the console may not declare yet (P2-11)');

    const h = harness(t, {address: {status: 403}, config: {addressConsentCard: true}});
    const response = await h.handler(intentEnvelope('AirQualityIntent'));
    assert.equal(h.turns[0].request.deviceLocation, undefined);
    assert.deepEqual(response.response.card, {
      type: 'AskForPermissionsConsent',
      permissions: [COUNTRY_AND_POSTAL_CODE_SCOPE],
    });
    assert.equal(COUNTRY_AND_POSTAL_CODE_SCOPE, 'read::alexa:device:all:address:country_and_postal_code');
  },
);

test('address errors, empties and timeouts leave the location out, with no card', BOUNDED, async (t) => {
  for (const address of [
    {status: 204},
    {status: 429},
    {status: 500},
    {status: 200, body: '{"countryCode":"US"}'},
  ] as const) {
    const h = harness(t, {address});
    const response = await h.handler(intentEnvelope('AirQualityIntent'));
    assert.equal(h.turns[0].request.deviceLocation, undefined, `status ${address.status}`);
    assert.equal(response.response.card, undefined);
  }
  const slow = harness(t, {address: 'hang'});
  const pending = slow.handler(intentEnvelope('AirQualityIntent'));
  await slow.clock.timerDue(FIXTURE_TIME + 500);
  slow.clock.advanceTo(FIXTURE_TIME + 500);
  await pending;
  assert.equal(slow.turns[0].request.deviceLocation, undefined);
  assert.equal((await slow.logs.waitFor('alexa.address')).fields.reason, 'timeout');
});

test('an api endpoint off the allowlist gets no address call and no token', BOUNDED, async (t) => {
  const h = harness(t);
  const event = intentEnvelope('AirQualityIntent') as unknown as {context: {System: {apiEndpoint: string}}};
  event.context.System.apiEndpoint = 'https://attacker.example.com';
  await h.handler(event);
  assert.equal(h.calls.length, 0);
  assert.equal(h.turns[0].request.deviceLocation, undefined);
});

test('the country-and-postal-code body is checked before it is used', () => {
  assert.deepEqual(parseCountryAndPostalCode('{"countryCode":"us","postalCode":" 59802 "}'), {
    countryCode: 'US',
    postalCode: '59802',
  });
  assert.deepEqual(parseCountryAndPostalCode('{"countryCode":"GB","postalCode":"SW1A 1AA"}'), {
    countryCode: 'GB',
    postalCode: 'SW1A 1AA',
  });
  for (const body of [
    '',
    'null',
    '{"countryCode":"USA","postalCode":"59802"}',
    '{"countryCode":"US","postalCode":"<b>"}',
    '{"countryCode":"US","postalCode":"123 Main Street, Apt 4"}',
  ]) {
    assert.equal(parseCountryAndPostalCode(body), undefined, body);
  }
});

test(
  'an air-quality turn hands the core its deadline, and sends its progressive response at 2.5 s',
  BOUNDED,
  async (t) => {
    const clock = new FakeClock(FIXTURE_TIME);
    const logs = captureLog();
    const posts: string[] = [];
    let release: (response: VoiceResponse) => void = () => {};
    const deadlines: Array<number | undefined> = [];
    const handler = createHandler({
      config: testConfig(),
      converse: (_request, deps) => {
        deadlines.push(deps.deadline);
        return new Promise<VoiceResponse>((resolve) => {
          release = resolve;
        });
      },
      trackerFor: () => UNUSED_TRACKER,
      store: memoryStore(),
      log: logs.log,
      clock,
      fetch: async (url, init) => {
        if (init.method === 'POST') posts.push(url);
        return {status: url.endsWith('/countryAndPostalCode') ? 403 : 204, text: async () => ''};
      },
    });
    t.after(() => {
      assert.equal(JSON.stringify(logs.records).includes(API_ACCESS_TOKEN), false);
    });
    const pending = handler(intentEnvelope('AirQualityIntent'));
    await clock.timerDue(FIXTURE_TIME + 2500);
    clock.advanceTo(FIXTURE_TIME + 2500);
    await logs.waitFor('alexa.progressive.sent');
    assert.equal(posts.length, 1);
    assert.deepEqual(deadlines, [FIXTURE_TIME + 7000]);
    release(ANSWER);
    await pending;
  },
);

test('an unlinked turn carries the session pin and time zone through unchanged', BOUNDED, async (t) => {
  const h = harness(t);
  const event = intentEnvelope('AMAZON.RepeatIntent') as unknown as {
    session: {new: boolean; attributes: Record<string, unknown>};
  };
  const pin = {key: 'alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT', identity: 'account:0123456789ab'};
  event.session.new = false;
  event.session.attributes = {speaker: pin, timeZone: 'Europe/London', other: 'dropped'};
  const response = await h.handler(event);
  assert.deepEqual(
    response.sessionAttributes,
    {speaker: pin, timeZone: 'Europe/London'},
    'no follow-up mark on repeat',
  );
});

test(
  'linked: the time zone and the device address are asked for together, not one after the other',
  BOUNDED,
  async () => {
    const clock = new FakeClock(FIXTURE_TIME);
    const started: string[] = [];
    const handler = createHandler({
      config: testConfig(),
      converse: async () => ANSWER,
      trackerFor: () => UNUSED_TRACKER,
      store: memoryStore(),
      log: () => {},
      clock,
      fetch: (url) => {
        started.push(url.endsWith('/countryAndPostalCode') ? 'address' : 'timeZone');
        return new Promise(() => {});
      },
    });
    const pending = handler(intentEnvelope('AirQualityIntent', {}, 'intent-person-match'));
    await clock.timerArmed(2);
    assert.deepEqual([...started].sort(), ['address', 'timeZone'], 'both started before either answered');
    clock.advanceTo(FIXTURE_TIME + 500);
    await pending;
  },
);
