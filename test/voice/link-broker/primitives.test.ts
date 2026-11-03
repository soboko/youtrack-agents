import assert from 'node:assert/strict';
import test from 'node:test';
import {ALEXA_API_URLS, alexaRedirectUrls, brokerSettings} from '../../../src/voice/link-broker/config.ts';
import {
  constantTimeEqual,
  isPkceVerifier,
  isS256Challenge,
  open,
  randomToken,
  recordId,
  s256Challenge,
  seal,
} from '../../../src/voice/link-broker/crypto.ts';
import {basicCredentials, BadRequestError, escapeHtml, page, parseParams} from '../../../src/voice/link-broker/http.ts';
import {loadTokenSecrets, setupKeyUsable, ssmSetupSecrets} from '../../../src/voice/link-broker/secrets.ts';
import {createDynamoLinkStore, RecordExistsError} from '../../../src/voice/link-broker/store.ts';
import {counterRandom, ENV, fakeLinkTable, fakeSsm, SECRETS, START_TIME, TestClock, TOKEN_SECRETS} from './fakes.ts';

test('PKCE S256 matches the RFC 7636 appendix B test vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(s256Challenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(isPkceVerifier(verifier), true);
  assert.equal(isS256Challenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'), true);
  assert.equal(isPkceVerifier('too-short'), false);
  assert.equal(isS256Challenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c='), false);
});

test('random tokens are 256 bits of base64url and usable as PKCE verifiers', () => {
  const random = counterRandom();
  const a = randomToken(random);
  const b = randomToken(random);
  assert.equal(a.length, 43);
  assert.notEqual(a, b);
  assert.equal(isPkceVerifier(a), true);
  assert.throws(() => randomToken(() => new Uint8Array(16)), /wrong number of bytes/);
});

test('constant-time comparison is exact, including for different lengths', () => {
  assert.equal(constantTimeEqual('same-value', 'same-value'), true);
  assert.equal(constantTimeEqual('same-value', 'same-valuf'), false);
  assert.equal(constantTimeEqual('short', 'shorter'), false);
  assert.equal(constantTimeEqual('', 'x'), false);
});

test('sealed records open only with the value that named them, for the same kind', () => {
  const random = counterRandom();
  const secret = randomToken(random);
  const sealed = seal('code', secret, '{"tokens":"CANARY"}', random);
  assert.equal(sealed.includes('CANARY'), false);
  assert.equal(open('code', secret, sealed), '{"tokens":"CANARY"}');
  assert.equal(open('code', randomToken(random), sealed), null);
  assert.equal(open('state', secret, sealed), null);
  assert.equal(open('code', secret, `${sealed.slice(0, -2)}AA`), null);
  assert.equal(open('code', secret, 'garbage'), null);
  // The id reveals neither the value nor the key, and differs by kind.
  assert.notEqual(recordId('code', secret), recordId('state', secret));
  assert.equal(recordId('code', secret).includes(secret), false);
});

test('parameters: a repeated name is refused', () => {
  assert.equal(parseParams('a=1&b=two+words').get('b'), 'two words');
  assert.throws(() => parseParams('state=1&state=2'), BadRequestError);
});

test('Basic credentials are form-decoded after base64 (RFC 6749 2.3.1)', () => {
  const header = `Basic ${Buffer.from('my+id:p%40ss%3Aword').toString('base64')}`;
  assert.deepEqual(basicCredentials(header), {clientId: 'my id', clientSecret: 'p@ss:word'});
  assert.equal(basicCredentials(undefined), undefined);
  assert.equal(basicCredentials('Bearer abc'), undefined);
  assert.equal(basicCredentials(`Basic ${Buffer.from('no-colon').toString('base64')}`), undefined);
});

test('pages escape everything and carry no-store, no-referrer and no CORS header', () => {
  const result = page(400, '<b>', ['"x" & <script>']);
  assert.equal(result.body.includes('<script>'), false);
  assert.equal(escapeHtml(`<a href='x'>`), '&#60;a href=&#39;x&#39;&#62;');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(
    Object.keys(result.headers).some((name) => name.toLowerCase().startsWith('access-control-')),
    false,
  );
});

test('settings: required variables, allowlisted Alexa API origins, and a pinned origin that must be a Function URL', () => {
  const settings = brokerSettings(ENV);
  assert.equal(settings.stage, 'development');
  assert.equal(settings.secretsPrefix, '/youtrack-voice/link-broker/');
  assert.equal(settings.alexaApiUrl, ALEXA_API_URLS[0]);
  assert.deepEqual(alexaRedirectUrls('A1B2C3D4E5F6GH'), [
    'https://pitangui.amazon.com/api/skill/link/A1B2C3D4E5F6GH',
    'https://layla.amazon.com/api/skill/link/A1B2C3D4E5F6GH',
    'https://alexa.amazon.co.jp/api/skill/link/A1B2C3D4E5F6GH',
  ]);
  assert.throws(() => brokerSettings({...ENV, HOUSEHOLD_LOGIN: ''}), /HOUSEHOLD_LOGIN is required/);
  assert.throws(() => brokerSettings({...ENV, HOUSEHOLD_HUB_USER_ID: ''}), /HOUSEHOLD_HUB_USER_ID is required/);
  assert.throws(() => brokerSettings({...ENV, HOUSEHOLD_HUB_USER_ID: 'Household_User'}), /HOUSEHOLD_HUB_USER_ID/);
  assert.equal(settings.authorizeEnabled, false, '/authorize is off unless LINK_BROKER_AUTHORIZE=on');
  assert.equal(brokerSettings({...ENV, LINK_BROKER_AUTHORIZE: 'on'}).authorizeEnabled, true);
  assert.throws(() => brokerSettings({...ENV, LINK_BROKER_AUTHORIZE: 'yes'}), /LINK_BROKER_AUTHORIZE/);
  assert.throws(() => brokerSettings({...ENV, YOUTRACK_URL: 'http://evil.example'}), /YOUTRACK_URL/);
  assert.throws(() => brokerSettings({...ENV, ALEXA_API_URL: 'https://api.evil.example'}), /ALEXA_API_URL/);
  assert.throws(() => brokerSettings({...ENV, SKILL_STAGE: 'certification'}), /SKILL_STAGE/);
  assert.throws(() => brokerSettings({...ENV, BROKER_ORIGIN: 'https://evil.example'}), /BROKER_ORIGIN/);
  assert.equal(brokerSettings({...ENV, BROKER_ORIGIN: 'auto'}).brokerOrigin, undefined);
  assert.equal(
    brokerSettings({...ENV, BROKER_ORIGIN: 'https://abc123.lambda-url.us-east-1.on.aws/'}).brokerOrigin,
    'https://abc123.lambda-url.us-east-1.on.aws',
  );
});

test('token secrets: one decrypted GetParameters call at init; errors name the parameter but never a value', async () => {
  const ssm = fakeSsm();
  const secrets = await loadTokenSecrets(ssm.client, '/youtrack-voice/link-broker/');
  assert.deepEqual(secrets, TOKEN_SECRETS);
  assert.deepEqual(ssm.calls, [
    {
      action: 'GetParameters',
      names: [
        '/youtrack-voice/link-broker/youtrack-client-secret',
        '/youtrack-voice/link-broker/broker-client-id',
        '/youtrack-voice/link-broker/broker-client-secret',
      ],
      decrypt: true,
    },
  ]);

  // The setup parameters are not needed for /token: deleting them after linking must not stop the broker starting.
  for (const name of ['setup-key', 'lwa-client-id', 'lwa-client-secret']) {
    ssm.parameters.delete(`/youtrack-voice/link-broker/${name}`);
  }
  assert.deepEqual(await loadTokenSecrets(ssm.client, '/youtrack-voice/link-broker/'), TOKEN_SECRETS);

  ssm.parameters.delete('/youtrack-voice/link-broker/youtrack-client-secret');
  await assert.rejects(
    loadTokenSecrets(ssm.client, '/youtrack-voice/link-broker/'),
    /youtrack-client-secret is missing or empty/,
  );
  ssm.parameters.set('/youtrack-voice/link-broker/youtrack-client-secret', SECRETS.youtrackClientSecret);
  ssm.parameters.set('/youtrack-voice/link-broker/broker-client-secret', 'CANARY-TOO-SHORT');
  await assert.rejects(loadTokenSecrets(ssm.client, '/youtrack-voice/link-broker/'), (error: Error) => {
    assert.equal(error.message.includes('CANARY-TOO-SHORT'), false);
    return /broker-client-secret is too short/.test(error.message);
  });
  const failing = fakeSsm();
  failing.client.getParameters = async () => {
    throw Object.assign(new Error(`no ${SECRETS.youtrackClientSecret}`), {name: 'AccessDeniedException'});
  };
  await assert.rejects(loadTokenSecrets(failing.client, '/youtrack-voice/link-broker/'), (error: Error) => {
    assert.equal(error.message.includes(SECRETS.youtrackClientSecret), false);
    return /AccessDeniedException/.test(error.message);
  });
});

test('setup secrets: read from SSM on every call, so a deleted setup key or Alexa client takes effect at once', async () => {
  const ssm = fakeSsm();
  const setup = ssmSetupSecrets(ssm.client, '/youtrack-voice/link-broker/');
  assert.equal(await setup.setupKey(), SECRETS.setupKey);
  assert.deepEqual(await setup.lwaClient(), {clientId: SECRETS.lwaClientId, clientSecret: SECRETS.lwaClientSecret});
  assert.equal(setupKeyUsable(SECRETS.setupKey), true);
  assert.equal(setupKeyUsable('disabled'), false);
  assert.equal(setupKeyUsable(undefined), false);

  ssm.parameters.delete('/youtrack-voice/link-broker/setup-key');
  ssm.parameters.delete('/youtrack-voice/link-broker/lwa-client-secret');
  assert.equal(await setup.setupKey(), undefined);
  assert.equal(await setup.lwaClient(), undefined);
  assert.equal(ssm.calls.length, 4, 'nothing cached');

  ssm.client.getParameter = async () => {
    throw Object.assign(new Error('denied'), {name: 'AccessDeniedException'});
  };
  await assert.rejects(setup.setupKey(), /setup-key \(AccessDeniedException\)/);
});

test('store: puts refuse an existing id; take is single use and refuses an expired record', async () => {
  const clock = new TestClock();
  const table = fakeLinkTable();
  const store = createDynamoLinkStore({client: table.client, tableName: 'links', now: () => clock.now()});
  const expiresAt = Math.floor(START_TIME / 1000) + 300;

  await store.put('code#1', {sealed: 'v1.a', expiresAt});
  await assert.rejects(store.put('code#1', {sealed: 'v1.b', expiresAt}), RecordExistsError);
  assert.deepEqual(await store.take('code#1'), {sealed: 'v1.a', expiresAt});
  assert.equal(await store.take('code#1'), null);

  await store.put('code#2', {sealed: 'v1.c', expiresAt});
  const both = await Promise.all([store.take('code#2'), store.take('code#2')]);
  assert.equal(both.filter((record) => record !== null).length, 1);

  await store.put('code#3', {sealed: 'v1.d', expiresAt});
  clock.advance(300_000);
  assert.equal(await store.take('code#3'), null, 'expired at exactly expiresAt');
  assert.equal(table.items.has('code#3'), true, 'an expired record is left for TTL, not returned');
  await store.discard('code#3');
  assert.equal(table.items.has('code#3'), false);
});
