import assert from 'node:assert/strict';
import test from 'node:test';
import {configFromEnvironment, describeConfig} from '../../../src/voice/alexa/config.ts';
import {
  InvalidEnvelopeError,
  mapRequest,
  mapSlots,
  parseRequestEnvelope,
  trackerIdentity,
  UnsupportedRequestError,
} from '../../../src/voice/alexa/request.ts';
import {ACCOUNT_TOKEN, ENROLLED_PERSON_ID, loadEnvelope, PERSON_TOKEN, SKILL_ID, testConfig} from './helpers.ts';

const FALLBACK = testConfig({
  accountTokenFallback: true,
  policy: {...testConfig().policy, readAccepts: ['person', 'account']},
});

function mapped(fixture: string, config = testConfig()) {
  return mapRequest(parseRequestEnvelope(loadEnvelope(fixture)), config);
}

interface PersonEnvelope {
  context: {System: {person: {personId: string; accessToken?: string}}};
}

test('launch with only an account link: no usable token by default, account evidence', () => {
  const result = mapped('launch');
  assert.deepEqual(result.voice.input, {kind: 'launch'});
  assert.deepEqual(result.voice.speaker, {
    userId: 'alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT',
    evidence: ['account'],
  });
  assert.equal(result.voice.locale, 'en-GB');
  assert.equal(result.voice.requestId, 'amzn1.echo-api.request.LAUNCH1');
  assert.equal(result.accessToken, undefined);
  assert.equal(result.tokenSource, 'none');
  assert.equal(result.accountTokenPresent, true);
  assert.deepEqual(result.voice.capabilities, {
    ssml: true,
    earcons: true,
    display: false,
    followUp: true,
    maxSpeechChars: 4000,
  });
});

test('launch with the account-token fallback on: the account token, still account evidence', () => {
  const result = mapped('launch', FALLBACK);
  assert.equal(result.accessToken, ACCOUNT_TOKEN);
  assert.equal(result.tokenSource, 'account');
  assert.deepEqual(result.voice.speaker.evidence, ['account']);
});

test('the enrolled person with their own token is person evidence, with that token', () => {
  const result = mapped('intent-person-match');
  assert.deepEqual(result.voice.speaker, {
    userId: `alexa:person:${ENROLLED_PERSON_ID}`,
    evidence: ['person'],
  });
  assert.equal(result.personMatched, true);
  assert.equal(result.accessToken, PERSON_TOKEN);
  assert.equal(result.tokenSource, 'person');
  assert.equal(result.voice.capabilities.display, true);
});

test('the enrolled voice without its own token is never person evidence, in either mode', () => {
  const envelope = loadEnvelope('intent-person-match') as unknown as PersonEnvelope;
  delete envelope.context.System.person.accessToken;

  const safe = mapRequest(parseRequestEnvelope(envelope), testConfig());
  assert.equal(safe.tokenSource, 'none');
  assert.equal(safe.accessToken, undefined);
  assert.deepEqual(safe.voice.speaker.evidence, ['account']);
  assert.equal(safe.personMatched, true);

  const fallback = mapRequest(parseRequestEnvelope(envelope), FALLBACK);
  assert.equal(fallback.tokenSource, 'account');
  assert.equal(fallback.accessToken, ACCOUNT_TOKEN);
  assert.deepEqual(fallback.voice.speaker.evidence, ['account']);
});

test('a recognised person who is not the enrolled one: their own token if linked, account evidence', () => {
  const unlinked = mapped('intent-person-other');
  assert.deepEqual(unlinked.voice.speaker.evidence, ['account']);
  assert.equal(unlinked.voice.speaker.userId, 'alexa:person:amzn1.ask.person.SOMEONEELSEINTHEROOM');
  assert.equal(unlinked.personMatched, false);
  assert.equal(unlinked.tokenSource, 'none');

  const envelope = loadEnvelope('intent-person-other') as unknown as PersonEnvelope;
  envelope.context.System.person.accessToken = 'OTHER-PERSON-TOKEN';
  const linked = mapRequest(parseRequestEnvelope(envelope), testConfig());
  assert.equal(linked.tokenSource, 'person');
  assert.equal(linked.accessToken, 'OTHER-PERSON-TOKEN');
  assert.deepEqual(linked.voice.speaker.evidence, ['account']);
});

test('with no enrolled person configured, even the household member is only account evidence', () => {
  const result = mapped('intent-person-match', testConfig({enrolledPersonId: undefined}));
  assert.deepEqual(result.voice.speaker.evidence, ['account']);
  assert.equal(result.personMatched, false);
});

test('an empty enrolled person id never matches', () => {
  const envelope = loadEnvelope('intent-person-match') as unknown as PersonEnvelope;
  envelope.context.System.person.personId = '';
  const result = mapRequest(parseRequestEnvelope(envelope), testConfig({enrolledPersonId: ''}));
  assert.deepEqual(result.voice.speaker.evidence, ['account']);
  // A person token with no personId (YA-22 F2 decides whether it is usable at all) keeps its own record.
  assert.equal(result.voice.speaker.userId, 'alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT:person');
});

test('no personId: account evidence, and an AMAZON.NUMBER ordinal arrives as its digits', () => {
  const result = mapped('intent-no-person', FALLBACK);
  assert.deepEqual(result.voice.speaker.evidence, ['account']);
  assert.equal(result.personId, undefined);
  assert.deepEqual(result.voice.input, {kind: 'intent', intent: 'open', slots: {ordinal: '2'}});
});

test('no access token anywhere leaves the request without a credential, even with the fallback', () => {
  const result = mapped('intent-no-token', FALLBACK);
  assert.equal(result.accessToken, undefined);
  assert.equal(result.tokenSource, 'none');
  assert.equal(result.accountTokenPresent, false);
});

test('session pinning: a turn reuses the pinned record only under the same tracker identity', () => {
  const accountIdentity = trackerIdentity('account', 'amzn1.ask.account.HOUSEHOLDACCOUNT');
  const personIdentity = trackerIdentity('person', ENROLLED_PERSON_ID);
  const pinnedKey = `alexa:person:${ENROLLED_PERSON_ID}:account`;
  const envelope = loadEnvelope('intent-open-unrecognised') as {session: {attributes: Record<string, unknown>}};
  envelope.session.attributes = {speaker: {key: pinnedKey, identity: accountIdentity}};

  const pinned = mapRequest(parseRequestEnvelope(envelope), FALLBACK);
  assert.equal(pinned.voice.speaker.userId, pinnedKey);
  assert.equal(pinned.keyChoice, 'pinned');
  assert.equal(pinned.trackerIdentity, accountIdentity);
  assert.deepEqual(pinned.voice.speaker.evidence, ['account'], 'pinning never upgrades evidence');

  envelope.session.attributes = {speaker: {key: `alexa:person:${ENROLLED_PERSON_ID}`, identity: personIdentity}};
  const crossed = mapRequest(parseRequestEnvelope(envelope), FALLBACK);
  assert.equal(crossed.keyChoice, 'fresh');
  assert.match(crossed.voice.speaker.userId, /^alexa:user:amzn1\.ask\.account\.HOUSEHOLDACCOUNT:session:[0-9a-f]{12}$/);

  for (const bad of [
    {key: 'someone', identity: accountIdentity},
    {key: pinnedKey},
    {key: pinnedKey, tokenSource: 'account'},
    {key: pinnedKey, identity: 'account:raw-id'},
    'alexa:person:x',
  ]) {
    envelope.session.attributes = {speaker: bad};
    const result = mapRequest(parseRequestEnvelope(envelope), FALLBACK);
    assert.equal(result.keyChoice, 'own', JSON.stringify(bad));
    assert.equal(result.voice.speaker.userId, 'alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT');
  }
});

test('state keys: one per voice and link, and the tracker identity never carries a raw id', () => {
  const own = mapped('intent-person-match');
  assert.equal(own.voice.speaker.userId, `alexa:person:${ENROLLED_PERSON_ID}`);
  assert.match(own.trackerIdentity ?? '', /^person:[0-9a-f]{12}$/);
  assert.equal((own.trackerIdentity ?? '').includes(ENROLLED_PERSON_ID), false);

  const envelope = loadEnvelope('intent-person-match') as unknown as PersonEnvelope;
  delete envelope.context.System.person.accessToken;
  const viaAccount = mapRequest(parseRequestEnvelope(envelope), FALLBACK);
  assert.equal(viaAccount.voice.speaker.userId, `alexa:person:${ENROLLED_PERSON_ID}:account`);
  assert.match(viaAccount.trackerIdentity ?? '', /^account:[0-9a-f]{12}$/);

  assert.equal(
    mapped('intent-no-person', FALLBACK).voice.speaker.userId,
    'alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT',
  );
  assert.equal(mapped('intent-no-person').trackerIdentity, undefined, 'no usable token, no identity');
});

test('session pinning: a recognised person after another identity starts fresh, and a new session ignores attributes', () => {
  const envelope = loadEnvelope('intent-person-other') as {
    session: {new: boolean; attributes: Record<string, unknown>};
    context: {System: {person: {accessToken?: string}}};
  };
  envelope.session.new = false;
  envelope.session.attributes = {
    speaker: {key: `alexa:person:${ENROLLED_PERSON_ID}`, identity: trackerIdentity('person', ENROLLED_PERSON_ID)},
  };
  envelope.context.System.person.accessToken = 'OTHER-PERSON-TOKEN';
  const other = mapRequest(parseRequestEnvelope(envelope), testConfig());
  assert.equal(other.keyChoice, 'fresh');
  assert.match(other.voice.speaker.userId, /^alexa:person:amzn1\.ask\.person\.SOMEONEELSEINTHEROOM:session:/);

  const fresh = loadEnvelope('intent-open-unrecognised') as {session: {new: boolean; attributes: object}};
  fresh.session.new = true;
  fresh.session.attributes = {
    speaker: {key: `alexa:person:${ENROLLED_PERSON_ID}`, identity: trackerIdentity('person', ENROLLED_PERSON_ID)},
  };
  assert.equal(mapRequest(parseRequestEnvelope(fresh), FALLBACK).keyChoice, 'own');
});

test('entity resolution: the canonical id wins over what was heard; no match keeps the heard value', () => {
  const list = mapped('intent-person-match');
  assert.deepEqual(list.voice.input, {kind: 'intent', intent: 'list', slots: {scope: 'in-progress'}});

  const read = mapped('entity-resolution');
  assert.deepEqual(read.voice.input, {kind: 'intent', intent: 'read', slots: {part: 'comments'}});

  const noMatch = mapped('entity-resolution-no-match');
  assert.deepEqual(noMatch.voice.input, {kind: 'intent', intent: 'read', slots: {part: 'comment'}});
});

test('a SearchQuery slot keeps the raw words', () => {
  assert.deepEqual(mapped('search-query').voice.input, {
    kind: 'intent',
    intent: 'find',
    slots: {words: 'login page times out'},
  });
});

test('YA-35: a person on ListIntent arrives as the SearchQuery words, possessive kept; an empty scope is absent', () => {
  assert.deepEqual(mapped('intent-list-person').voice.input, {
    kind: 'intent',
    intent: 'list',
    slots: {person: "chris's"},
  });
});

test('YA-35: a name Alexa filed in the scope slot keeps the heard words, for the core to hear as a person', () => {
  const envelope = loadEnvelope('intent-list-person') as {request: {intent: {slots: Record<string, unknown>}}};
  envelope.request.intent.slots = {
    scope: {
      name: 'scope',
      value: 'zoe',
      confirmationStatus: 'NONE',
      resolutions: {resolutionsPerAuthority: [{authority: 'ScopeValues', status: {code: 'ER_SUCCESS_NO_MATCH'}}]},
    },
    person: {name: 'person', confirmationStatus: 'NONE'},
  };
  const request = mapRequest(parseRequestEnvelope(envelope), testConfig());
  assert.deepEqual(request.voice.input, {kind: 'intent', intent: 'list', slots: {scope: 'zoe'}});
});

test('built-ins map to canonical intents; MoreIntent is not one of them', () => {
  const cases: Array<[string, string]> = [
    ['AMAZON.HelpIntent', 'help'],
    ['AMAZON.StopIntent', 'stop'],
    ['AMAZON.CancelIntent', 'cancel'],
    ['AMAZON.RepeatIntent', 'repeat'],
    ['AMAZON.NextIntent', 'more'],
    ['AMAZON.PreviousIntent', 'previous'],
    ['AMAZON.YesIntent', 'confirm'],
    ['AMAZON.NoIntent', 'deny'],
    ['AMAZON.NavigateHomeIntent', 'stop'],
    ['WhereIntent', 'where'],
    ['OpenByIdIntent', 'openById'],
    ['SetVerbosityIntent', 'setVerbosity'],
    ['FinishDictationIntent', 'finishDictation'],
  ];
  const envelope = loadEnvelope('built-in-next') as {request: {intent: {name: string}}};
  for (const [alexaName, canonical] of cases) {
    envelope.request.intent.name = alexaName;
    const input = mapRequest(parseRequestEnvelope(envelope), testConfig()).voice.input;
    assert.deepEqual(input, {kind: 'intent', intent: canonical, slots: {}}, alexaName);
  }
  envelope.request.intent.name = 'AMAZON.MoreIntent';
  assert.equal(mapRequest(parseRequestEnvelope(envelope), testConfig()).voice.input.kind, 'utterance');
});

test('AMAZON.FallbackIntent and unknown intents become an empty utterance with no confidence', () => {
  const fallback = mapped('fallback').voice.input;
  assert.deepEqual(fallback, {kind: 'utterance', text: ''});
  assert.equal('confidence' in fallback, false);

  const envelope = loadEnvelope('built-in-next') as {request: {intent: {name: string}}};
  envelope.request.intent.name = 'SomeoneElsesIntent';
  const input = mapRequest(parseRequestEnvelope(envelope), testConfig()).voice.input;
  assert.deepEqual(input, {kind: 'utterance', text: ''});
});

test('session ended reasons map to the contract', () => {
  assert.deepEqual(mapped('session-ended').voice.input, {kind: 'sessionEnded', reason: 'silence'});
  assert.deepEqual(mapped('session-ended-error').voice.input, {kind: 'sessionEnded', reason: 'error'});
  const envelope = loadEnvelope('session-ended') as {request: {reason: string}};
  envelope.request.reason = 'USER_INITIATED';
  assert.deepEqual(mapRequest(parseRequestEnvelope(envelope), testConfig()).voice.input, {
    kind: 'sessionEnded',
    reason: 'user',
  });
});

test('slots: empty and "?" values are absent; the Ordinal companion fills only an empty base slot', () => {
  assert.deepEqual(
    mapSlots({
      ordinal: {name: 'ordinal', value: '?'},
      ordinal_ordinal: {name: 'ordinal_ordinal', value: '3'},
      part: {name: 'part', value: '   '},
      words: {name: 'words'},
    }),
    {ordinal: '3'},
  );
  assert.deepEqual(
    mapSlots({ordinal: {name: 'ordinal', value: '2'}, ordinal_ordinal: {name: 'ordinal_ordinal', value: '5'}}),
    {ordinal: '2'},
  );
});

test('display is detected from supportedInterfaces keys as well as Viewport', () => {
  const envelope = loadEnvelope('launch') as {context: {System: {device: {supportedInterfaces: object}}}};
  envelope.context.System.device.supportedInterfaces = {Display: {}};
  assert.equal(mapRequest(parseRequestEnvelope(envelope), testConfig()).voice.capabilities.display, true);
});

test('malformed envelopes are refused without echoing their values', () => {
  assert.throws(() => parseRequestEnvelope(null), InvalidEnvelopeError);
  assert.throws(() => parseRequestEnvelope({request: {type: 'LaunchRequest'}}), InvalidEnvelopeError);

  const noIntent = loadEnvelope('built-in-next') as {request: {intent?: unknown}};
  delete noIntent.request.intent;
  assert.throws(() => parseRequestEnvelope(noIntent), /request\.intent must be an object/);

  const badUser = loadEnvelope('launch') as {context: {System: {user: {userId: unknown}}}};
  badUser.context.System.user.userId = 42;
  assert.throws(
    () => parseRequestEnvelope(badUser),
    (error: Error) => !error.message.includes('42'),
  );
  assert.throws(() => parseRequestEnvelope(loadEnvelope('launch-no-timestamp')), /request\.timestamp/);
});

test('other request types are reported as unsupported, carrying every application id', () => {
  const envelope = loadEnvelope('wrong-application') as {request: {type: string}};
  envelope.request.type = 'System.ExceptionEncountered';
  assert.throws(
    () => parseRequestEnvelope(envelope),
    (error: unknown) =>
      error instanceof UnsupportedRequestError &&
      error.requestType === 'System.ExceptionEncountered' &&
      error.applicationIds.length === 2 &&
      error.applicationIds.every((id) => id !== SKILL_ID),
  );
});

test('configFromEnvironment defaults to option A: person-only reads and writes, no fallback, no cards', () => {
  const config = configFromEnvironment({SKILL_ID, ENROLLED_PERSON_ID});
  assert.equal(config.skillId, SKILL_ID);
  assert.equal(config.enrolledPersonId, ENROLLED_PERSON_ID);
  assert.deepEqual(config.policy.readAccepts, ['person']);
  assert.deepEqual(config.policy.writeAccepts, ['person']);
  assert.equal(config.accountTokenFallback, false);
  assert.equal(config.cards, false);
  assert.equal(config.enrolmentLog, false);
  assert.equal(config.progressiveAfterMs, 5000);
  assert.equal(config.answerByMs, 7000);
  assert.deepEqual(describeConfig(config), {
    readAccepts: ['person'],
    writeAccepts: ['person'],
    accountLinkFallback: false,
    cards: false,
    enrolmentLog: false,
    enrolledPersonConfigured: true,
    progressiveAfterMs: 5000,
    answerByMs: 7000,
    addressConsentCard: false,
  });
  assert.equal(JSON.stringify(describeConfig(config)).includes(ENROLLED_PERSON_ID), false);
});

test('configFromEnvironment accepts option B only when both switches say so', () => {
  const config = configFromEnvironment({SKILL_ID, ACCOUNT_TOKEN_FALLBACK: 'true', READ_ACCEPTS: 'person,account'});
  assert.equal(config.accountTokenFallback, true);
  assert.deepEqual(config.policy.readAccepts, ['person', 'account']);
  assert.equal(configFromEnvironment({SKILL_ID, CARDS: 'on', ENROLMENT_LOG: 'true'}).cards, true);
});

test('configFromEnvironment refuses bad and contradictory values', () => {
  const refusals: Array<[Record<string, string>, RegExp]> = [
    [{}, /SKILL_ID is required/],
    [{SKILL_ID, WRITE_ACCEPTS: 'account'}, /WRITE_ACCEPTS must not include account/],
    [{SKILL_ID, READ_ACCEPTS: 'none'}, /not Alexa evidence/],
    [{SKILL_ID, READ_ACCEPTS: 'caller-id'}, /not Alexa evidence/],
    [{SKILL_ID, READ_ACCEPTS: 'account'}, /needs ACCOUNT_TOKEN_FALLBACK=true/],
    [{SKILL_ID, READ_ACCEPTS: ' , '}, /lists no evidence kind/],
    [{SKILL_ID, ACCOUNT_TOKEN_FALLBACK: 'yes'}, /ACCOUNT_TOKEN_FALLBACK must be/],
    [{SKILL_ID, CARDS: 'true'}, /CARDS must be/],
    [{SKILL_ID, ENROLMENT_LOG: '1'}, /ENROLMENT_LOG must be/],
    [{SKILL_ID, ANSWER_BY_MS: '8000'}, /under 8000/],
    [{SKILL_ID, PROGRESSIVE_AFTER_MS: '7000'}, /under ANSWER_BY_MS/],
  ];
  for (const [env, expected] of refusals) {
    assert.throws(() => configFromEnvironment(env), expected, JSON.stringify(env));
  }
  assert.equal(configFromEnvironment({SKILL_ID, ENROLLED_PERSON_ID: '  '}).enrolledPersonId, undefined);
});
