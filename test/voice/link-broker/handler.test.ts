import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {RECOVERY_SECTION, type LinkRequestContext} from '../../../src/voice/link-broker/handler.ts';
import type {FunctionUrlEvent, FunctionUrlResult} from '../../../src/voice/link-broker/http.ts';
import {
  ALEXA_REDIRECT,
  ALEXA_STATE,
  assertNoSecretsLogged,
  basic,
  brokerUnderTest,
  DOMAIN,
  getEvent,
  HOUSEHOLD_HUB_ID,
  HOUSEHOLD_LOGIN,
  HUB,
  location,
  OTHER_HUB_ID,
  ORIGIN,
  SECRETS,
  SERVICE_ID,
  SKILL_ID,
  tokenEvent,
  YOUTRACK_URL,
  type BrokerUnderTest,
  type WorldOptions,
} from './fakes.ts';

const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/**
 * A broker with the log canary and the no-CORS check registered to run after the test, whatever it did. `/authorize`
 * is turned on here, because most of these tests exercise it; its default (off) has its own test.
 */
function setup(t: TestContext, options: Parameters<typeof brokerUnderTest>[0] = {}) {
  const b = brokerUnderTest({...options, env: {LINK_BROKER_AUTHORIZE: 'on', ...options.env}});
  const results: FunctionUrlResult[] = [];
  const call = async (event: FunctionUrlEvent, context?: LinkRequestContext): Promise<FunctionUrlResult> => {
    const result = await b.handler(event, context);
    results.push(result);
    return result;
  };
  t.after(() => {
    assertNoSecretsLogged(b);
    for (const result of results) {
      const names = Object.keys(result.headers).map((name) => name.toLowerCase());
      assert.equal(
        names.some((name) => name.startsWith('access-control-')),
        false,
      );
      assert.equal(result.headers['Cache-Control'], 'no-store');
    }
  });
  return {...b, call};
}

type Setup = ReturnType<typeof setup>;

function authorizeEvent(overrides: Record<string, string | undefined> = {}): FunctionUrlEvent {
  const query: Record<string, string> = {};
  const base: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: SECRETS.brokerClientId,
    redirect_uri: ALEXA_REDIRECT,
    state: ALEXA_STATE,
    scope: 'read',
    ...overrides,
  };
  for (const [name, value] of Object.entries(base)) if (value !== undefined) query[name] = value;
  return getEvent('/authorize', query);
}

/** Alexa-initiated linking up to the redirect back to Alexa: returns that redirect's URL. */
async function alexaFlowToCode(b: Setup, overrides: Record<string, string | undefined> = {}): Promise<URL> {
  const toYouTrack = location(await b.call(authorizeEvent(overrides)));
  const back = await b.call(b.world.youtrackSignIn(toYouTrack));
  return location(back);
}

function json(result: FunctionUrlResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

function events(b: BrokerUnderTest): string[] {
  return b.logs.events();
}

// ---- /authorize and /youtrack-callback, Alexa-initiated -------------------------------------------------------------

test('Alexa-initiated: authorize, YouTrack with the broker PKCE, back to Alexa, then /token issues the YouTrack tokens', async (t) => {
  const b = setup(t);
  const toYouTrack = location(await b.call(authorizeEvent()));
  assert.equal(`${toYouTrack.origin}${toYouTrack.pathname}`, `${HUB}/auth`);
  assert.equal(toYouTrack.searchParams.get('redirect_uri'), `${ORIGIN}/youtrack-callback`);
  const brokerState = toYouTrack.searchParams.get('state') ?? '';
  assert.equal(brokerState.length, 43, '256-bit state');
  assert.notEqual(brokerState, ALEXA_STATE, "the broker's own state, not Alexa's");
  assert.equal(b.table.items.size, 1);
  const [storedId] = [...b.table.items.keys()];
  assert.equal(JSON.stringify([...b.table.items.values()]).includes(brokerState), false, 'state never stored');
  assert.match(storedId ?? '', /^state#[0-9a-f]{64}$/);

  const back = location(await b.call(b.world.youtrackSignIn(toYouTrack)));
  assert.equal(`${back.origin}${back.pathname}`, ALEXA_REDIRECT);
  assert.equal(back.searchParams.get('state'), ALEXA_STATE);
  const code = back.searchParams.get('code') ?? '';
  assert.equal(code.length, 43);
  assert.equal(b.table.items.size, 1, 'the state record is gone, the code record is there');
  assert.match([...b.table.items.keys()][0] ?? '', /^code#/);
  const stored = JSON.stringify([...b.table.items.values()]);
  for (const value of b.world.issued) assert.equal(stored.includes(value), false, 'tokens are sealed at rest');

  const hubExchange = b.world.requests.find((request) => request.url === `${HUB}/token`);
  assert.equal(hubExchange?.headers.authorization, basic('alexa-voice-client', SECRETS.youtrackClientSecret));
  assert.ok(new URLSearchParams(hubExchange?.body).get('code_verifier'));

  const answer = await b.call(tokenEvent({grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT}));
  assert.equal(answer.statusCode, 200);
  const body = json(answer);
  assert.match(String(body.access_token), /^CANARY-YT-ACCESS-/);
  assert.match(String(body.refresh_token), /^CANARY-YT-REFRESH-/);
  assert.equal(body.expires_in, 3600);
  assert.equal(body.token_type, 'Bearer');
  assert.equal(answer.headers['Content-Type'], 'application/json;charset=UTF-8');
  assert.equal(b.table.items.size, 0, 'tokens deleted once redeemed');
  assert.ok(events(b).includes('link.token.issued'));
});

test('Alexa-initiated with PKCE: /token needs the verifier for the challenge Alexa sent (RFC 7636 vector)', async (t) => {
  const b = setup(t);
  const back = await alexaFlowToCode(b, {code_challenge: RFC_CHALLENGE, code_challenge_method: 'S256'});
  const code = back.searchParams.get('code') ?? '';
  const form = {grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT};

  const wrong = await b.call(tokenEvent({...form, code_verifier: `${RFC_VERIFIER.slice(0, -1)}Y`}));
  assert.equal(wrong.statusCode, 400);
  assert.deepEqual(json(wrong), {error: 'invalid_grant'});
  // A failed verifier spends the code: a second try with the right one is refused too.
  const retry = await b.call(tokenEvent({...form, code_verifier: RFC_VERIFIER}));
  assert.deepEqual(json(retry), {error: 'invalid_grant'});

  const again = await alexaFlowToCode(b, {code_challenge: RFC_CHALLENGE, code_challenge_method: 'S256'});
  const right = await b.call(
    tokenEvent({...form, code: again.searchParams.get('code') ?? '', code_verifier: RFC_VERIFIER}),
  );
  assert.equal(right.statusCode, 200);
});

test('/authorize: an unknown client or a redirect_uri outside the allowlist gets a plain page, no redirect, nothing stored', async (t) => {
  const b = setup(t);
  const cases = [
    {client_id: 'someone-else'},
    {redirect_uri: 'https://evil.example/api/skill/link/A1B2C3D4E5F6GH'},
    {redirect_uri: 'https://pitangui.amazon.com/api/skill/link/OTHERVENDOR1'},
    {redirect_uri: `${ALEXA_REDIRECT}/`},
    {redirect_uri: `${ALEXA_REDIRECT}?x=1`},
    {redirect_uri: 'http://pitangui.amazon.com/api/skill/link/A1B2C3D4E5F6GH'},
    {redirect_uri: undefined},
  ];
  for (const overrides of cases) {
    const result = await b.call(authorizeEvent(overrides));
    assert.equal(result.statusCode, 400, JSON.stringify(overrides));
    assert.equal(result.headers.Location, undefined);
    assert.match(result.headers['Content-Type'] ?? '', /^text\/html/);
  }
  for (const redirect of [
    'https://layla.amazon.com/api/skill/link/A1B2C3D4E5F6GH',
    'https://alexa.amazon.co.jp/api/skill/link/A1B2C3D4E5F6GH',
  ]) {
    assert.equal((await b.call(authorizeEvent({redirect_uri: redirect}))).statusCode, 302);
  }
  assert.equal(b.table.items.size, 2, 'only the two allowed redirects started flows');
  assert.equal(b.world.requests.length, 0);
});

test('/authorize: a bad response_type, missing state or non-S256 PKCE is sent back to Alexa as an OAuth error', async (t) => {
  const b = setup(t);
  const cases: [Record<string, string | undefined>, string][] = [
    [{response_type: 'token'}, 'unsupported_response_type'],
    [{state: undefined}, 'invalid_request'],
    [{code_challenge: RFC_VERIFIER, code_challenge_method: 'plain'}, 'invalid_request'],
    [{code_challenge_method: 'S256'}, 'invalid_request'],
  ];
  for (const [overrides, error] of cases) {
    const back = location(await b.call(authorizeEvent(overrides)));
    assert.equal(`${back.origin}${back.pathname}`, ALEXA_REDIRECT);
    assert.equal(back.searchParams.get('error'), error);
    assert.equal(back.searchParams.get('code'), null);
  }
  const repeated = await b.call(getEvent('/authorize', `${authorizeEvent().rawQueryString}&state=second`));
  assert.equal(repeated.statusCode, 400);
  assert.equal(b.table.items.size, 0);
});

test('/youtrack-callback: a replayed state is refused and YouTrack is not asked again', async (t) => {
  const b = setup(t);
  const toYouTrack = location(await b.call(authorizeEvent()));
  const callback = b.world.youtrackSignIn(toYouTrack);
  assert.equal((await b.call(callback)).statusCode, 302);
  const exchanges = b.world.requests.length;

  const replay = await b.call(callback);
  assert.equal(replay.statusCode, 400);
  assert.match(replay.body, /expired or has already been used/);
  assert.equal(b.world.requests.length, exchanges);
  assert.ok(events(b).includes('link.youtrack.stateRefused'));
});

test('/youtrack-callback: a state older than ten minutes is refused', async (t) => {
  const b = setup(t);
  const toYouTrack = location(await b.call(authorizeEvent()));
  const callback = b.world.youtrackSignIn(toYouTrack);
  b.clock.advance(600_000);
  const result = await b.call(callback);
  assert.equal(result.statusCode, 400);
  assert.equal(b.world.requests.length, 0);

  const fresh = location(await b.call(authorizeEvent()));
  const inTime = b.world.youtrackSignIn(fresh);
  b.clock.advance(599_000);
  assert.equal((await b.call(inTime)).statusCode, 302);
});

test('/youtrack-callback: a state the broker never issued, or none, is refused', async (t) => {
  const b = setup(t);
  assert.equal((await b.call(getEvent('/youtrack-callback', {code: 'x', state: 'forged'}))).statusCode, 400);
  assert.equal((await b.call(getEvent('/youtrack-callback', {code: 'x'}))).statusCode, 400);
  assert.equal(b.world.requests.length, 0);
});

test('household account: any other YouTrack account is refused, no code is minted and nothing is stored', async (t) => {
  const b = setup(t, {youtrackLogin: 'The_Owner'});
  const toYouTrack = location(await b.call(authorizeEvent()));
  const result = await b.call(b.world.youtrackSignIn(toYouTrack));
  assert.equal(result.statusCode, 403);
  assert.equal(result.headers.Location, undefined);
  assert.match(result.body, /Only the household YouTrack account/);
  assert.equal(result.body.includes('The_Owner'), false);
  assert.equal(b.table.items.size, 0);
  const mismatch = b.logs.parsed().find((line) => line.event === 'link.youtrack.accountChecked');
  assert.equal(mismatch?.match, false);
  assert.equal(JSON.stringify(b.logs.parsed()).includes('The_Owner'), false, 'the login is logged as a tag');
  assert.ok(events(b).includes('link.youtrack.tokensDiscarded'));
});

test('household account: identified by its Hub user id, not by its login (S4)', async (t) => {
  // The household login on a different Hub account (a renamed or look-alike account) is refused.
  const impostor = setup(t, {youtrackLogin: HOUSEHOLD_LOGIN, youtrackHubId: OTHER_HUB_ID});
  const toYouTrack = location(await impostor.call(authorizeEvent()));
  const refused = await impostor.call(impostor.world.youtrackSignIn(toYouTrack));
  assert.equal(refused.statusCode, 403);
  assert.equal(impostor.table.items.size, 0);
  const line = impostor.logs.parsed().find((entry) => entry.event === 'link.youtrack.accountChecked');
  assert.equal(line?.match, false);
  assert.equal(line?.loginAsConfigured, true);

  // The household's Hub account under another spelling of the login (a rename) is accepted.
  const renamed = setup(t, {youtrackLogin: 'household_user', youtrackHubId: HOUSEHOLD_HUB_ID});
  const back = await alexaFlowToCode(renamed);
  assert.ok(back.searchParams.get('code'));

  // A Hub id differing only in case is a different id.
  const cased = setup(t, {youtrackLogin: HOUSEHOLD_LOGIN, youtrackHubId: HOUSEHOLD_HUB_ID.toUpperCase()});
  const casedToYouTrack = location(await cased.call(authorizeEvent()));
  assert.equal((await cased.call(cased.world.youtrackSignIn(casedToYouTrack))).statusCode, 403);
});

test('/authorize is off by default (S1): a plain "not enabled" page, logged at info, nothing stored', async (t) => {
  const b = brokerUnderTest();
  t.after(() => {
    assertNoSecretsLogged(b);
  });
  const result = await b.handler(authorizeEvent());
  assert.equal(result.statusCode, 403);
  assert.equal(result.headers.Location, undefined);
  assert.match(result.body, /Alexa-initiated linking is not enabled/);
  assert.equal(b.table.items.size, 0);
  assert.equal(b.world.requests.length, 0);
  const line = b.logs.parsed().find((entry) => entry.event === 'link.authorize.disabled');
  assert.equal(line?.level, 'info');
});

const youtrackFailures: [string, WorldOptions, (b: BrokerUnderTest) => void, number, RegExp][] = [
  [
    'Hub refuses the code',
    {},
    (b) => b.world.failures.set('hub-token', Response.json({error: 'invalid_grant'}, {status: 400})),
    502,
    /YouTrack answered 400 \(invalid_grant\)/,
  ],
  [
    "Hub's description is shown, scrubbed of token-like runs",
    {},
    (b) =>
      b.world.failures.set(
        'hub-token',
        Response.json(
          {
            error: 'invalid_grant',
            error_description: 'Unknown authorization code <b>x</b> perm:abcdefghijklmnopqrstuvwxyz0123',
          },
          {status: 400},
        ),
      ),
    502,
    /YouTrack said: Unknown authorization code b x b perm:\[removed\]\./,
  ],
  ['Hub is unreachable', {}, (b) => b.world.failures.set('hub-token', 'network'), 502, /could not be reached/],
  [
    'Hub answers without an access token',
    {},
    (b) => b.world.failures.set('hub-token', Response.json({expires_in: 3600})),
    502,
    /refused the sign-in/,
  ],
  [
    'Hub issues no refresh token',
    {issueRefreshToken: false},
    () => {},
    502,
    new RegExp(`no refresh token[\\s\\S]*${RECOVERY_SECTION}`),
  ],
  [
    'users/me fails',
    {},
    (b) => b.world.failures.set('users-me', new Response('boom', {status: 500})),
    502,
    new RegExp(`answered 500 when asked who signed in[\\s\\S]*${RECOVERY_SECTION}`),
  ],
  ['users/me is unreachable', {}, (b) => b.world.failures.set('users-me', 'network'), 502, /could not be reached/],
];

for (const [name, options, arrange, status, message] of youtrackFailures) {
  test(`YouTrack error during the callback (${name}): a plain page, nothing stored`, async (t) => {
    const b = setup(t, options);
    arrange(b);
    const toYouTrack = location(await b.call(authorizeEvent()));
    const result = await b.call(b.world.youtrackSignIn(toYouTrack));
    assert.equal(result.statusCode, status);
    assert.match(result.body, message);
    assert.equal(result.headers.Location, undefined);
    assert.equal(b.table.items.size, 0);
  });
}

test('YouTrack error at authorization (error=access_denied): a plain page, the state is spent', async (t) => {
  const b = setup(t);
  const toYouTrack = location(await b.call(authorizeEvent()));
  const state = toYouTrack.searchParams.get('state') ?? '';
  const denied = await b.call(getEvent('/youtrack-callback', {error: 'access_denied', state}));
  assert.equal(denied.statusCode, 400);
  assert.match(denied.body, /YouTrack answered: access_denied/);
  assert.equal(b.table.items.size, 0);
  const hostile = await b.call(getEvent('/youtrack-callback', {error: '<script>', state}));
  assert.equal(hostile.statusCode, 400);
  assert.equal(hostile.body.includes('<script>'), false);
});

// ---- /token --------------------------------------------------------------------------------------------------------

test('/token: a code is single use, and expires after five minutes', async (t) => {
  const b = setup(t);
  const code = (await alexaFlowToCode(b)).searchParams.get('code') ?? '';
  const form = {grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT};
  assert.equal((await b.call(tokenEvent(form))).statusCode, 200);
  const replay = await b.call(tokenEvent(form));
  assert.equal(replay.statusCode, 400);
  assert.deepEqual(json(replay), {error: 'invalid_grant'});

  const late = (await alexaFlowToCode(b)).searchParams.get('code') ?? '';
  b.clock.advance(300_000);
  const expired = await b.call(tokenEvent({...form, code: late}));
  assert.deepEqual(json(expired), {error: 'invalid_grant'});
});

test('/token: wrong or missing Basic credentials are refused with 401 before the code is touched', async (t) => {
  const b = setup(t);
  const code = (await alexaFlowToCode(b)).searchParams.get('code') ?? '';
  const form = {grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT};
  const attempts = [
    basic(SECRETS.brokerClientId, `${SECRETS.brokerClientSecret}x`),
    basic('alexa-voice-client', SECRETS.brokerClientSecret),
    basic(SECRETS.brokerClientId, ''),
    `Bearer ${SECRETS.brokerClientSecret}`,
    'Basic !!!',
    null,
  ];
  for (const authorization of attempts) {
    const result = await b.call(tokenEvent(form, authorization));
    assert.equal(result.statusCode, 401);
    assert.deepEqual(json(result), {error: 'invalid_client'});
    assert.equal(result.headers['WWW-Authenticate'], 'Basic realm="youtrack-voice-link"');
  }
  // Credentials in the body instead of Basic are not accepted either.
  const inBody = await b.call(
    tokenEvent({...form, client_id: SECRETS.brokerClientId, client_secret: SECRETS.brokerClientSecret}, null),
  );
  assert.equal(inBody.statusCode, 401);
  const both = await b.call(tokenEvent({...form, client_secret: SECRETS.brokerClientSecret}));
  assert.deepEqual(json(both), {error: 'invalid_request'});

  assert.equal((await b.call(tokenEvent(form))).statusCode, 200, 'the code survived the refused attempts');
  assert.equal(b.logs.parsed().filter((line) => line.event === 'link.token.refused').length, 8);
});

test('/token: a redirect_uri other than the one the code was issued for spends the code and is refused', async (t) => {
  const b = setup(t);
  const code = (await alexaFlowToCode(b)).searchParams.get('code') ?? '';
  const form = {grant_type: 'authorization_code', code};
  const wrong = await b.call(
    tokenEvent({...form, redirect_uri: 'https://layla.amazon.com/api/skill/link/A1B2C3D4E5F6GH'}),
  );
  assert.deepEqual(json(wrong), {error: 'invalid_grant'});
  assert.deepEqual(json(await b.call(tokenEvent({...form, redirect_uri: ALEXA_REDIRECT}))), {error: 'invalid_grant'});

  const missing = (await alexaFlowToCode(b)).searchParams.get('code') ?? '';
  assert.deepEqual(json(await b.call(tokenEvent({grant_type: 'authorization_code', code: missing}))), {
    error: 'invalid_grant',
  });
});

test('/token: other grants, a non-form body, a GET and a repeated parameter are refused', async (t) => {
  const b = setup(t);
  assert.deepEqual(json(await b.call(tokenEvent({grant_type: 'client_credentials'}))), {
    error: 'unsupported_grant_type',
  });
  const jsonBody = tokenEvent({grant_type: 'refresh_token'});
  jsonBody.headers = {...jsonBody.headers, 'content-type': 'application/json'};
  assert.equal((await b.call(jsonBody)).statusCode, 400);
  const get = await b.call(getEvent('/token', {grant_type: 'refresh_token'}));
  assert.equal(get.statusCode, 405);
  const repeated = tokenEvent({grant_type: 'authorization_code'}, undefined, false);
  repeated.headers = {...repeated.headers, authorization: basic(SECRETS.brokerClientId, SECRETS.brokerClientSecret)};
  repeated.body = 'grant_type=authorization_code&code=a&code=b';
  assert.deepEqual(json(await b.call(repeated)), {error: 'invalid_request'});
  assert.equal(b.world.requests.length, 0);
});

test('/token refresh: proxied to YouTrack with the YouTrack client secret; the refresh token is kept when Hub sends none', async (t) => {
  const b = setup(t);
  const refreshToken = b.world.seedRefreshToken();
  const result = await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: refreshToken}, undefined, false));
  assert.equal(result.statusCode, 200);
  const body = json(result);
  assert.match(String(body.access_token), /^CANARY-YT-ACCESS-/);
  assert.equal(body.refresh_token, refreshToken);
  assert.equal(body.expires_in, 3600);
  const upstream = b.world.requests.at(-1);
  assert.equal(upstream?.url, `${HUB}/token`);
  assert.equal(upstream?.headers.authorization, basic('alexa-voice-client', SECRETS.youtrackClientSecret));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(upstream?.body)), {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: `${SERVICE_ID} offline_access`,
  });
  assert.equal(b.table.items.size, 0, 'a refresh stores nothing');
});

test('/token refresh: Hub rotating the refresh token passes the new one on', async (t) => {
  const b = setup(t);
  const old = b.world.seedRefreshToken();
  const rotated = b.world.next('CANARY-YT-REFRESH');
  b.world.failures.set(
    'hub-refresh',
    Response.json({access_token: b.world.next('CANARY-YT-ACCESS'), refresh_token: rotated, expires_in: 3600}),
  );
  const body = json(await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: old})));
  assert.equal(body.refresh_token, rotated);
});

test('/token refresh: only YouTrack rejecting the refresh token (invalid_grant) tells Amazon the link is gone', async (t) => {
  const b = setup(t);
  const dead = await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: 'CANARY-UNKNOWN-REFRESH-TOKEN'}));
  assert.equal(dead.statusCode, 400);
  assert.deepEqual(json(dead), {error: 'invalid_grant'});

  const token = b.world.seedRefreshToken();
  b.world.failures.set('hub-refresh', Response.json({error: 'invalid_client'}, {status: 401}));
  const misconfigured = await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: token}));
  assert.equal(misconfigured.statusCode, 502);
  assert.deepEqual(json(misconfigured), {error: 'server_error'});

  b.world.failures.set('hub-refresh', new Response('<html>maintenance</html>', {status: 503}));
  assert.equal((await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: token}))).statusCode, 502);

  b.world.failures.set('hub-refresh', 'network');
  const down = await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: token}));
  assert.equal(down.statusCode, 503);
  assert.deepEqual(json(down), {error: 'temporarily_unavailable'});

  assert.deepEqual(json(await b.call(tokenEvent({grant_type: 'refresh_token'}))), {error: 'invalid_request'});
});

test('/token refresh (C4): the YouTrack call gets what remains of the 4 s budget from the invocation start', async (t) => {
  const timeouts: number[] = [];
  const b = setup(t, {
    deps: {
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    },
  });
  const refresh = () => tokenEvent({grant_type: 'refresh_token', refresh_token: b.world.seedRefreshToken()});
  // A cold build took 1.2 s before the handler ran.
  assert.equal((await b.call(refresh(), {startedAt: b.clock.now() - 1200})).statusCode, 200);
  assert.deepEqual(timeouts, [2800]);
  // Warm: the whole budget.
  assert.equal((await b.call(refresh())).statusCode, 200);
  assert.deepEqual(timeouts, [2800, 4000]);
  // Too little left to be worth asking Hub: a quick 503, which never unlinks.
  const late = await b.call(refresh(), {startedAt: b.clock.now() - 3800});
  assert.equal(late.statusCode, 503);
  assert.deepEqual(json(late), {error: 'temporarily_unavailable'});
  assert.equal(timeouts.length, 2, 'Hub was not called');

  const lines = b.logs.parsed().filter((line) => line.event === 'link.request');
  assert.deepEqual(
    lines.map((line) => line.coldStart),
    [true, false, false],
  );
  assert.equal(lines[0]?.sinceInvocationMs, 1200);
});

test('/token refresh (C5): scope is sent as in the authorization request; Hub refusing it is not an unlink', async (t) => {
  const b = setup(t);
  const token = b.world.seedRefreshToken();
  assert.equal((await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: token}))).statusCode, 200);
  assert.deepEqual(b.world.refreshScopes, [`${SERVICE_ID} offline_access`]);
  b.world.failures.set('hub-refresh', Response.json({error: 'invalid_request'}, {status: 400}));
  const refused = await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: token}));
  assert.deepEqual(json(refused), {error: 'server_error'});
});

// ---- /start, /amazon-callback, /youtrack-callback: app-to-app -----------------------------------------------------

/** Owner-initiated linking, from /start to the final page: Amazon first, YouTrack last. */
async function appToApp(b: Setup): Promise<FunctionUrlResult> {
  const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
  const toYouTrack = location(await b.call(b.world.amazonSignIn(toAmazon)));
  return b.call(b.world.youtrackSignIn(toYouTrack));
}

function hubExchanges(b: BrokerUnderTest): number {
  return b.world.requests.filter(
    (request) => request.url === `${HUB}/token` && request.body.includes('grant_type=authorization_code'),
  ).length;
}

test('app-to-app: /start, Login with Amazon, then YouTrack, then the Enablement API redeems the broker code', async (t) => {
  const b = setup(t);
  const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
  assert.equal(`${toAmazon.origin}${toAmazon.pathname}`, 'https://www.amazon.com/ap/oa');
  assert.equal(toAmazon.searchParams.get('redirect_uri'), `${ORIGIN}/amazon-callback`);
  assert.equal(b.world.requests.length, 0, 'YouTrack is not involved yet');
  assert.match([...b.table.items.keys()][0] ?? '', /^lwa#/);

  const toYouTrack = location(await b.call(b.world.amazonSignIn(toAmazon)));
  assert.equal(`${toYouTrack.origin}${toYouTrack.pathname}`, `${HUB}/auth`);
  assert.equal(toYouTrack.searchParams.get('request_credentials'), 'required');
  assert.equal(hubExchanges(b), 0, 'no YouTrack token is issued before Amazon has signed in');
  assert.equal(b.table.items.size, 1);
  assert.match([...b.table.items.keys()][0] ?? '', /^state#/);
  const sealedState = JSON.stringify([...b.table.items.values()]);
  for (const value of b.world.issued) assert.equal(sealedState.includes(value), false, 'Amazon token sealed at rest');

  const lwaExchange = b.world.requests.find((request) => request.url === 'https://api.amazon.com/auth/o2/token');
  const lwaForm = new URLSearchParams(lwaExchange?.body);
  assert.equal(lwaForm.get('redirect_uri'), `${ORIGIN}/amazon-callback`);
  assert.equal(lwaForm.get('client_secret'), SECRETS.lwaClientSecret);
  assert.ok(lwaForm.get('code_verifier'));

  const done = await b.call(b.world.youtrackSignIn(toYouTrack));
  assert.equal(done.statusCode, 200, done.body);
  assert.match(done.body, /<h1>Linked<\/h1>/);
  assert.match(done.body, /account link is LINKED/);

  const enablement = b.world.requests.find((request) => request.url.endsWith('/enablement'));
  assert.equal(enablement?.url, `https://api.amazonalexa.com/v1/users/~current/skills/${SKILL_ID}/enablement`);
  assert.match(enablement?.headers.authorization ?? '', /^Bearer Atza\|CANARY-AMAZON-ACCESS-/);
  const sent = b.world.enablement.body as {stage: string; accountLinkRequest: Record<string, string>};
  assert.equal(sent.stage, 'development');
  assert.equal(sent.accountLinkRequest.type, 'AUTH_CODE');
  assert.equal(sent.accountLinkRequest.redirectUri, `${ORIGIN}/amazon-callback`);
  assert.equal(sent.accountLinkRequest.authCode?.length, 43);
  assert.equal(b.world.enablement.tokenAnswer?.statusCode, 200);
  assert.match(String(json(b.world.enablement.tokenAnswer as FunctionUrlResult).refresh_token), /^CANARY-YT-REFRESH-/);
  assert.equal(b.table.items.size, 0, 'nothing left in the table');
  assert.deepEqual(b.setup.reads, ['setupKey', 'lwaClient', 'lwaClient'], 'setup secrets read per request');
});

test('C1: an Amazon-side failure happens before YouTrack is asked, so a retry still gets a refresh token', async (t) => {
  // Hub as documented: a refresh token only on the household's first exchange.
  const b = setup(t, {refreshTokenOncePerUser: true});
  const failures: [string, () => Promise<FunctionUrlResult>][] = [
    [
      'the person cancels at Amazon',
      async () => {
        const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
        const state = toAmazon.searchParams.get('state') ?? '';
        return b.call(getEvent('/amazon-callback', {error: 'access_denied', state}));
      },
    ],
    [
      'Login with Amazon refuses the code (a wrong Alexa client secret)',
      async () => {
        b.world.failures.set('lwa-token', Response.json({error: 'invalid_client'}, {status: 401}));
        const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
        const page = await b.call(b.world.amazonSignIn(toAmazon));
        b.world.failures.delete('lwa-token');
        return page;
      },
    ],
    [
      'the Amazon sign-in takes more than ten minutes',
      async () => {
        const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
        const callback = b.world.amazonSignIn(toAmazon);
        b.clock.advance(600_000);
        return b.call(callback);
      },
    ],
  ];
  for (const [name, fail] of failures) {
    const page = await fail();
    assert.ok(page.statusCode >= 400, name);
    assert.equal(hubExchanges(b), 0, `${name}: YouTrack issued nothing`);
  }
  const done = await appToApp(b);
  assert.equal(done.statusCode, 200, 'the retry links');
  assert.match(done.body, /<h1>Linked<\/h1>/);
});

test('C1: a failure after the YouTrack exchange says how to recover; after the admin removal a retry links', async (t) => {
  const b = setup(t, {refreshTokenOncePerUser: true});
  b.world.failures.set('enablement', Response.json({message: 'Skill not found'}, {status: 404}));
  const first = await appToApp(b);
  assert.equal(first.statusCode, 502);
  assert.match(first.body, /<h1>Not linked<\/h1>/);
  assert.match(first.body, new RegExp(RECOVERY_SECTION));
  assert.match(first.body, /Amazon never called \/token/);
  b.world.failures.delete('enablement');

  const second = await appToApp(b);
  assert.equal(second.statusCode, 502);
  assert.match(second.body, /YouTrack issued no refresh token/);
  assert.match(second.body, new RegExp(RECOVERY_SECTION));
  assert.equal(b.world.enablement.body === undefined, true, 'a token set without a refresh token is never linked');

  b.world.adminRemoveRefreshTokens();
  const third = await appToApp(b);
  assert.equal(third.statusCode, 200);
  assert.match(third.body, /<h1>Linked<\/h1>/);
});

test('C2: a 201 whose account link is NOT_LINKED, or a LINKED answer without redeeming the code, is not success', async (t) => {
  const answers: [string, Response][] = [
    [
      'NOT_LINKED',
      Response.json(
        {skill: {id: SKILL_ID, stage: 'development'}, accountLink: {status: 'NOT_LINKED'}, status: 'ENABLED'},
        {status: 201},
      ),
    ],
    ['no accountLink', Response.json({status: 'ENABLED'}, {status: 201})],
    ['LINKED, code never redeemed', Response.json({accountLink: {status: 'LINKED'}, status: 'ENABLED'}, {status: 201})],
    [
      'ENABLING_FAILED <b>',
      Response.json({accountLink: {status: 'NOT_LINKED<b>'}, status: 'ENABLING_FAILED'}, {status: 201}),
    ],
  ];
  for (const [name, answer] of answers) {
    const b = setup(t);
    b.world.failures.set('enablement', answer);
    const result = await appToApp(b);
    assert.equal(result.statusCode, 502, name);
    assert.match(result.body, /<h1>Not linked<\/h1>/, name);
    assert.equal(result.body.includes('<h1>Linked</h1>'), false, name);
    assert.match(result.body, new RegExp(RECOVERY_SECTION), name);
    assert.equal(result.body.includes('<b>'), false, `${name}: escaped`);
    assert.equal(b.table.items.size, 0, name);
    const line = b.logs.parsed().find((entry) => entry.event === 'link.enablement.answered');
    assert.equal(line?.linked, false, name);
  }
});

test('/start: the wrong setup key or none is refused; deleting the setup-key parameter turns /start off at once (S2)', async (t) => {
  const b = setup(t);
  for (const query of [{k: `${SECRETS.setupKey}0`}, {k: ''}, {}] as Record<string, string>[]) {
    const result = await b.call(getEvent('/start', query));
    assert.equal(result.statusCode, 403);
    assert.match(result.body, /Setup link not valid/);
    assert.equal(result.headers.Location, undefined);
  }
  // The same warm broker: the key is read per request, so removing it takes effect on the next one.
  assert.equal((await b.call(getEvent('/start', {k: SECRETS.setupKey}))).statusCode, 302);
  b.setup.current.delete('setupKey');
  const off = await b.call(getEvent('/start', {k: SECRETS.setupKey}));
  assert.equal(off.statusCode, 403);
  assert.match(off.body, /turned off/);
  b.setup.current.set('setupKey', 'disabled');
  assert.match((await b.call(getEvent('/start', {k: 'disabled'}))).body, /turned off/);
  assert.equal(b.table.items.size, 1, 'only the one flow started while the key existed');
});

test('/start and /amazon-callback: a missing Login with Amazon client is a plain 503, and /token still works', async (t) => {
  const b = setup(t);
  const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
  b.setup.current.delete('lwaClientSecret');
  const callback = await b.call(b.world.amazonSignIn(toAmazon));
  assert.equal(callback.statusCode, 503);
  assert.match(callback.body, /not configured/);
  b.setup.current.delete('lwaClientId');
  assert.equal((await b.call(getEvent('/start', {k: SECRETS.setupKey}))).statusCode, 503);
  // After linking the owner deletes the Alexa client parameters; the refresh path never reads them.
  const refreshed = await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: b.world.seedRefreshToken()}));
  assert.equal(refreshed.statusCode, 200);
});

test('app-to-app: an Enablement API error is shown verbatim with every secret, token and code removed', async (t) => {
  const b = setup(t);
  // Amazon redeems with the wrong credentials, so /token refuses and the fake API echoes the code and bearer back.
  b.world.redeemAuthorization = basic(SECRETS.brokerClientId, 'not-the-secret-at-all');
  const result = await appToApp(b);
  assert.equal(result.statusCode, 502);
  assert.match(result.body, /Not linked/);
  assert.match(result.body, /answered 400/);
  assert.match(result.body, /Invalid account linking credentials for code \[redacted\] with Bearer \[redacted\]/);
  for (const value of [...Object.values(SECRETS), ...b.world.issued, ...b.generated]) {
    assert.equal(result.body.includes(value), false, `page shows ${value.slice(0, 16)}`);
  }
  assert.equal(b.table.items.size, 0, 'the unredeemed code is removed');
  assert.ok(events(b).includes('link.youtrack.tokensDiscarded'));
});

test('app-to-app: an Enablement API error body carrying the secrets themselves is scrubbed too', async (t) => {
  const b = setup(t);
  b.world.failures.set(
    'enablement',
    Response.json(
      {
        message: `Forbidden ${SECRETS.lwaClientSecret} ${SECRETS.youtrackClientSecret} ${encodeURIComponent(SECRETS.brokerClientSecret)} Atza|OTHER-TOKEN amzn1.oa2-cs.v1.abcdef0123 <img src=x>`,
        code: 'FORBIDDEN',
      },
      {status: 403},
    ),
  );
  const result = await appToApp(b);
  assert.equal(result.statusCode, 502);
  assert.match(result.body, /answered 403/);
  assert.match(result.body, /FORBIDDEN/);
  for (const value of [
    SECRETS.youtrackClientSecret,
    SECRETS.brokerClientSecret,
    'Atza|OTHER-TOKEN',
    'amzn1.oa2-cs.v1.abcdef0123',
    '<img',
  ]) {
    assert.equal(result.body.includes(value), false, value);
  }
  assert.equal(b.table.items.size, 0);
});

test('app-to-app: the Enablement API unreachable leaves nothing behind and says whether Amazon redeemed the code', async (t) => {
  const b = setup(t);
  b.world.failures.set('enablement', 'network');
  const result = await appToApp(b);
  assert.equal(result.statusCode, 502);
  assert.match(result.body, /Amazon never called \/token/);
  assert.match(result.body, new RegExp(RECOVERY_SECTION));
  assert.equal(b.table.items.size, 0);
});

test('app-to-app: Login with Amazon errors are plain pages that show its message scrubbed', async (t) => {
  const b = setup(t);
  const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
  const state = toAmazon.searchParams.get('state') ?? '';
  const denied = await b.call(getEvent('/amazon-callback', {error: 'access_denied', state}));
  assert.equal(denied.statusCode, 400);
  assert.match(denied.body, /Amazon answered: access_denied/);
  assert.match(denied.body, /YouTrack was not asked for anything/);
  assert.equal(b.table.items.size, 0);
  const replay = await b.call(getEvent('/amazon-callback', {code: 'x', state}));
  assert.match(replay.body, /expired or has already been used/);

  const second = setup(t);
  second.world.failures.set(
    'lwa-token',
    Response.json({error: 'invalid_client', error_description: `bad secret ${SECRETS.lwaClientSecret}`}, {status: 401}),
  );
  const refused = await appToApp2(second);
  assert.equal(refused.statusCode, 502);
  assert.match(refused.body, /Login with Amazon answered 401/);
  assert.match(refused.body, /bad secret \[redacted\]/);
  assert.equal(second.table.items.size, 0);
  assert.equal(
    second.world.requests.some((request) => request.url.startsWith(HUB)),
    false,
  );
});

/** /start then the Amazon callback only, for failures that end there. */
async function appToApp2(b: Setup): Promise<FunctionUrlResult> {
  const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
  return b.call(b.world.amazonSignIn(toAmazon));
}

test('app-to-app: a YouTrack sign-in later than ten minutes after Amazon is refused', async (t) => {
  const b = setup(t);
  const toAmazon = location(await b.call(getEvent('/start', {k: SECRETS.setupKey})));
  const toYouTrack = location(await b.call(b.world.amazonSignIn(toAmazon)));
  const callback = b.world.youtrackSignIn(toYouTrack);
  b.clock.advance(600_000);
  const result = await b.call(callback);
  assert.equal(result.statusCode, 400);
  assert.equal(hubExchanges(b), 0);
});

test('app-to-app: the household check applies before the Enablement API is called', async (t) => {
  const b = setup(t, {youtrackLogin: 'Someone_Else'});
  const result = await appToApp(b);
  assert.equal(result.statusCode, 403);
  assert.equal(b.table.items.size, 0);
  assert.equal(b.world.enablement.body, undefined);
});

// ---- the edge -----------------------------------------------------------------------------------------------------

test('edge: unknown paths are 404, wrong methods 405, and a request not addressed to a Function URL is refused', async (t) => {
  const b = setup(t);
  assert.equal((await b.call(getEvent('/'))).statusCode, 404);
  assert.equal((await b.call(getEvent('/token/'))).statusCode, 404);
  const post = getEvent('/authorize');
  post.requestContext = {domainName: DOMAIN, http: {method: 'POST'}};
  const notAllowed = await b.call(post);
  assert.equal(notAllowed.statusCode, 405);
  assert.equal(notAllowed.headers.Allow, 'GET');

  const elsewhere = authorizeEvent();
  elsewhere.requestContext = {domainName: 'evil.example', http: {method: 'GET'}};
  assert.equal((await b.call(elsewhere)).statusCode, 400);
  assert.equal(b.table.items.size, 0);
});

test('edge: with BROKER_ORIGIN pinned, only that Function URL domain is served and used in redirect URIs', async (t) => {
  const pinned = setup(t, {env: {BROKER_ORIGIN: 'https://pinned0123.lambda-url.us-east-1.on.aws'}});
  assert.equal((await pinned.call(authorizeEvent())).statusCode, 400, 'another Function URL domain is refused');
  const event = authorizeEvent();
  event.requestContext = {domainName: 'pinned0123.lambda-url.us-east-1.on.aws', http: {method: 'GET'}};
  const toYouTrack = location(await pinned.call(event));
  assert.equal(
    toYouTrack.searchParams.get('redirect_uri'),
    'https://pinned0123.lambda-url.us-east-1.on.aws/youtrack-callback',
  );
});

test('edge: an unexpected failure (the table is down) is a plain 500 page, or server_error at /token', async (t) => {
  const b = setup(t, {
    deps: {
      store: {
        put: async () => {
          throw new Error(`table down ${SECRETS.brokerClientSecret}`);
        },
        take: async () => {
          throw new Error('table down');
        },
        discard: async () => {},
      },
    },
  });
  const page = await b.call(authorizeEvent());
  assert.equal(page.statusCode, 500);
  assert.equal(page.body.includes('table down'), false);
  const token = await b.call(tokenEvent({grant_type: 'authorization_code', code: 'c', redirect_uri: ALEXA_REDIRECT}));
  assert.deepEqual(json(token), {error: 'server_error'});
  assert.equal(token.statusCode, 500);
});

test('log canary: a full run of every route at debug writes no secret, token, code, state, verifier or key', async (t) => {
  const b = setup(t, {youtrackLogin: 'Household_User'});
  const code = (
    await alexaFlowToCode(b, {code_challenge: RFC_CHALLENGE, code_challenge_method: 'S256'})
  ).searchParams.get('code');
  await b.call(
    tokenEvent({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: ALEXA_REDIRECT,
      code_verifier: RFC_VERIFIER,
    }),
  );
  await b.call(tokenEvent({grant_type: 'authorization_code', code: code ?? '', redirect_uri: ALEXA_REDIRECT}));
  await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: b.world.seedRefreshToken()}));
  await b.call(tokenEvent({grant_type: 'refresh_token', refresh_token: 'CANARY-DEAD-REFRESH-TOKEN'}));
  await b.call(
    tokenEvent({grant_type: 'authorization_code', code: 'CANARY-GUESSED-CODE'}, 'Basic Q0FOQVJZOnNlY3JldA=='),
  );
  await b.call(getEvent('/start', {k: 'CANARY-WRONG-SETUP-KEY-000000000000'}));
  assert.equal((await appToApp(b)).statusCode, 200);
  b.world.redeemAuthorization = basic('x', 'y');
  await appToApp(b);

  const lines = b.logs.parsed();
  assert.ok(lines.some((line) => line.level === 'debug' || line.level === 'info'));
  const written = b.logs.lines.join('\n');
  for (const value of [
    'CANARY-DEAD-REFRESH-TOKEN',
    'CANARY-GUESSED-CODE',
    'Q0FOQVJZOnNlY3JldA',
    'CANARY-WRONG-SETUP-KEY',
    RFC_VERIFIER,
    RFC_CHALLENGE,
    ALEXA_STATE,
    'Atza|',
    'Bearer',
    'Basic',
  ]) {
    assert.equal(written.includes(value), false, `log contains ${value}`);
  }
  assert.equal(written.includes(YOUTRACK_URL), false, 'no URLs with query strings in logs');
});
