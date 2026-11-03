/**
 * Offline fakes for the link broker tests (YA-33): a DynamoDB client that evaluates the store's condition expressions,
 * a settable clock, a deterministic random source, a log capture, Function URL events, and one fake "world" that
 * plays YouTrack Hub, Login with Amazon, the Skill Enablement API and the person's browser. Nothing touches a network,
 * AWS or a real timer.
 *
 * Every secret, token, code and key is a distinctive CANARY value, so the log canary can search for each one.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createJsonLogger} from '../../../src/voice/alexa/log.ts';
import {brokerSettings, type BrokerSettings} from '../../../src/voice/link-broker/config.ts';
import {s256Challenge} from '../../../src/voice/link-broker/crypto.ts';
import {createLinkBroker, type LinkBrokerDeps, type LinkBrokerHandler} from '../../../src/voice/link-broker/handler.ts';
import type {FunctionUrlEvent, FunctionUrlResult} from '../../../src/voice/link-broker/http.ts';
import type {
  LwaClient,
  SetupSecrets,
  SsmParameterClient,
  TokenSecrets,
} from '../../../src/voice/link-broker/secrets.ts';
import {
  createDynamoLinkStore,
  type LinkDeleteItemInput,
  type LinkItemClient,
  type LinkPutItemInput,
  type LinkStore,
} from '../../../src/voice/link-broker/store.ts';

export const START_TIME = Date.parse('2026-09-13T22:00:00Z');
export const DOMAIN = 'abcdefghij0123456789klmnopqrstuv.lambda-url.us-east-1.on.aws';
export const ORIGIN = `https://${DOMAIN}`;
export const YOUTRACK_URL = 'https://household.youtrack.example';
export const HUB = `${YOUTRACK_URL}/hub/api/rest/oauth2`;
export const VENDOR_ID = 'A1B2C3D4E5F6GH';
export const SKILL_ID = 'amzn1.ask.skill.00000000-1111-2222-3333-555555555555';
export const ALEXA_REDIRECT = `https://pitangui.amazon.com/api/skill/link/${VENDOR_ID}`;
export const ALEXA_STATE = 'AlexaStateValue-0123456789';
export const HOUSEHOLD_LOGIN = 'Household_User';
export const SERVICE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const HOUSEHOLD_HUB_ID = 'ffffffff-1111-4222-8333-444444444444';
export const OTHER_HUB_ID = '0badc0de-0000-4000-8000-000000000001';

/** All six SSM values, by their secrets.ts keys. */
export const SECRETS = {
  youtrackClientSecret: 'CANARY-YT-CLIENT-SECRET-q8w7e6r5',
  lwaClientId: 'amzn1.application-oa2-client.CANARYLWACLIENTID1',
  lwaClientSecret: 'CANARY-LWA-CLIENT-SECRET-z1x2c3v4',
  brokerClientId: 'CANARY-BROKER-CLIENT-ID-a9s8d7f6',
  brokerClientSecret: 'CANARY-BROKER-CLIENT-SECRET-0000111122223333',
  setupKey: 'CANARY-SETUP-KEY-44445555666677778888',
} as const;

export const TOKEN_SECRETS: TokenSecrets = {
  youtrackClientSecret: SECRETS.youtrackClientSecret,
  brokerClientId: SECRETS.brokerClientId,
  brokerClientSecret: SECRETS.brokerClientSecret,
};

/**
 * The setup secrets as SSM would serve them, per request, from a map a test can change: delete `setupKey` to turn
 * `/start` off. `reads` counts the calls, so a test can see that nothing was cached.
 */
export function fakeSetupSecrets(
  values: Partial<Record<'setupKey' | 'lwaClientId' | 'lwaClientSecret', string>> = SECRETS,
) {
  const current = new Map(Object.entries(values));
  const reads: string[] = [];
  const secrets: SetupSecrets = {
    setupKey: async () => {
      reads.push('setupKey');
      return current.get('setupKey');
    },
    lwaClient: async (): Promise<LwaClient | undefined> => {
      reads.push('lwaClient');
      const clientId = current.get('lwaClientId');
      const clientSecret = current.get('lwaClientSecret');
      return clientId === undefined || clientSecret === undefined ? undefined : {clientId, clientSecret};
    },
  };
  return {secrets, current, reads};
}

export const ENV: Readonly<Record<string, string>> = {
  YOUTRACK_URL,
  YOUTRACK_CLIENT_ID: 'alexa-voice-client',
  YOUTRACK_SCOPE: `${SERVICE_ID} offline_access`,
  HOUSEHOLD_LOGIN,
  HOUSEHOLD_HUB_USER_ID: HOUSEHOLD_HUB_ID,
  SKILL_ID,
  SKILL_STAGE: 'development',
  ALEXA_VENDOR_ID: VENDOR_ID,
  LINK_TABLE: 'youtrack-voice-LinkTable',
  LOG_LEVEL: 'debug',
};

export function testSettings(overrides: Record<string, string> = {}): BrokerSettings {
  return brokerSettings({...ENV, ...overrides});
}

export class TestClock {
  current = START_TIME;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Distinct, repeatable bytes: SHA-256 of a counter, repeated to the length asked for. */
export function counterRandom(seed = 'seed'): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    const out = Buffer.alloc(size);
    let block = 0;
    for (let offset = 0; offset < size; offset += 32) {
      createHash('sha256').update(`${seed}:${counter}:${block++}`).digest().copy(out, offset);
    }
    return out;
  };
}

type Item = LinkPutItemInput['Item'];

/** An in-memory link table evaluating exactly the conditions the store sends, as DynamoDB would. */
export function fakeLinkTable() {
  const items = new Map<string, Item>();
  const conditionFailed = () =>
    Object.assign(new Error('The conditional request failed'), {name: 'ConditionalCheckFailedException'});
  const client: LinkItemClient = {
    putItem: async (input: LinkPutItemInput) => {
      assert.equal(input.ConditionExpression, 'attribute_not_exists(#id)');
      const id = (input.Item.id as {S: string}).S;
      if (items.has(id)) throw conditionFailed();
      items.set(id, input.Item);
      return {};
    },
    deleteItem: async (input: LinkDeleteItemInput) => {
      const id = input.Key.id?.S ?? '';
      const current = items.get(id);
      if (input.ConditionExpression !== undefined) {
        assert.equal(input.ConditionExpression, 'attribute_exists(#id) AND #expiresAt > :now');
        const now = Number(input.ExpressionAttributeValues?.[':now']?.N);
        const expiresAt = current ? Number((current.expiresAt as {N: string}).N) : 0;
        if (current === undefined || !(expiresAt > now)) throw conditionFailed();
      }
      items.delete(id);
      return input.ReturnValues === 'ALL_OLD' && current !== undefined ? {Attributes: current} : {};
    },
  };
  return {client, items};
}

export interface LogLine {
  level: string;
  event: string;
  [field: string]: unknown;
}

export function logCapture() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
    parsed: () => lines.map((line) => JSON.parse(line) as LogLine),
    events: () => lines.map((line) => (JSON.parse(line) as LogLine).event),
  };
}

export function getEvent(path: string, query: Record<string, string> | string = {}): FunctionUrlEvent {
  const rawQueryString = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString,
    headers: {host: DOMAIN},
    isBase64Encoded: false,
    requestContext: {domainName: DOMAIN, http: {method: 'GET', path}, requestId: 'req-1'},
  };
}

export function basic(id: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${encode(id)}:${encode(secret)}`).toString('base64')}`;
}

export function tokenEvent(
  form: Record<string, string>,
  /** null sends no Authorization header; undefined (or omitted) sends the broker's own credentials. */
  authorization: string | null | undefined = basic(SECRETS.brokerClientId, SECRETS.brokerClientSecret),
  base64 = true,
): FunctionUrlEvent {
  const body = new URLSearchParams(form).toString();
  return {
    version: '2.0',
    rawPath: '/token',
    rawQueryString: '',
    headers: {
      host: DOMAIN,
      'content-type': 'application/x-www-form-urlencoded',
      ...(authorization === null || authorization === undefined ? {} : {authorization}),
    },
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
    requestContext: {domainName: DOMAIN, http: {method: 'POST', path: '/token'}, requestId: 'req-token'},
  };
}

export function location(result: FunctionUrlResult): URL {
  assert.equal(result.statusCode, 302, `expected a redirect, got ${result.statusCode}: ${result.body.slice(0, 400)}`);
  const value = result.headers.Location;
  assert.ok(value !== undefined, 'redirect without Location');
  return new URL(value);
}

/** The six parameters as SSM holds them, by full name. */
export function ssmParameters(prefix = '/youtrack-voice/link-broker/'): Map<string, string> {
  return new Map([
    [`${prefix}youtrack-client-secret`, SECRETS.youtrackClientSecret],
    [`${prefix}lwa-client-id`, SECRETS.lwaClientId],
    [`${prefix}lwa-client-secret`, SECRETS.lwaClientSecret],
    [`${prefix}broker-client-id`, SECRETS.brokerClientId],
    [`${prefix}broker-client-secret`, SECRETS.brokerClientSecret],
    [`${prefix}setup-key`, SECRETS.setupKey],
  ]);
}

/** An SSM client over a map, answering as SSM does: ParameterNotFound for GetParameter, InvalidParameters for the batch. */
export function fakeSsm(parameters: Map<string, string> = ssmParameters()) {
  const calls: {action: 'GetParameter' | 'GetParameters'; names: string[]; decrypt: boolean}[] = [];
  const client: SsmParameterClient = {
    getParameter: async (input) => {
      calls.push({action: 'GetParameter', names: [input.Name], decrypt: input.WithDecryption});
      const value = parameters.get(input.Name);
      if (value === undefined)
        throw Object.assign(new Error(`Parameter ${input.Name} not found`), {name: 'ParameterNotFound'});
      return {Parameter: {Name: input.Name, Value: value}};
    },
    getParameters: async (input) => {
      calls.push({action: 'GetParameters', names: input.Names, decrypt: input.WithDecryption});
      return {
        Parameters: input.Names.filter((name) => parameters.has(name)).map((name) => ({
          Name: name,
          Value: parameters.get(name),
        })),
        InvalidParameters: input.Names.filter((name) => !parameters.has(name)),
      };
    },
  };
  return {client, calls, parameters};
}

export interface WorldOptions {
  /** The login YouTrack signs the browser in as. */
  youtrackLogin?: string;
  /** That account's Hub user id (`ringId`): the household's for the household login, another otherwise. */
  youtrackHubId?: string;
  /** Whether Hub includes a refresh token in the code exchange. */
  issueRefreshToken?: boolean;
  /**
   * Hub as its doc describes it: a refresh token only on a user's first code exchange for this client, until an
   * administrator removes it (`world.adminRemoveRefreshTokens`).
   */
  refreshTokenOncePerUser?: boolean;
}

/**
 * YouTrack Hub, Login with Amazon and the Skill Enablement API, as one `fetch`, plus the browser steps (signing in
 * at the authorization pages). The Enablement API redeems the broker code by calling the broker's `/token` through
 * `broker`, as Amazon would.
 */
export function fakeWorld(options: WorldOptions = {}) {
  const requests: {url: string; method: string; headers: Record<string, string>; body: string}[] = [];
  const failures = new Map<string, Response | 'network'>();
  const youtrackCodes = new Map<string, {challenge: string; redirectUri: string; login: string; hubId: string}>();
  const hubIds = new Map<string, string>();
  const usersWithRefreshToken = new Set<string>();
  const lwaCodes = new Map<string, {challenge: string; redirectUri: string}>();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  let sequence = 0;
  let broker: LinkBrokerHandler | undefined;
  const world = {
    requests,
    youtrackLogin: options.youtrackLogin ?? HOUSEHOLD_LOGIN,
    /** Every token, code and key the fakes issued, for the log canary. */
    issued: [] as string[],
    /** The last enablement body and the broker's /token answer to Amazon. */
    enablement: {body: undefined as unknown, tokenAnswer: undefined as FunctionUrlResult | undefined},
    /** Upstream answers to force, by key: `hub-token`, `hub-refresh`, `users-me`, `lwa-token`, `enablement`. */
    failures,
    /** The Basic header Amazon redeems the broker code with; the configured broker credentials when unset. */
    redeemAuthorization: undefined as string | undefined,
    /** The Hub refresh requests' `scope` values, in order. */
    refreshScopes: [] as (string | null)[],
    /** The administrator's Hub REST DELETE of a user's refresh tokens for this client. */
    adminRemoveRefreshTokens(login = HOUSEHOLD_LOGIN) {
      usersWithRefreshToken.delete(login);
      for (const [token, owner] of refreshTokens) if (owner === login) refreshTokens.delete(token);
    },
    setBroker(handler: LinkBrokerHandler) {
      broker = handler;
    },
    next(prefix: string): string {
      sequence += 1;
      const value = `${prefix}-${String(sequence).padStart(4, '0')}-${'x'.repeat(24)}`;
      world.issued.push(value);
      return value;
    },
    /** The browser at YouTrack's login: signs in and follows the redirect back to the broker. */
    youtrackSignIn(authorizeUrl: URL): FunctionUrlEvent {
      assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, `${HUB}/auth`);
      const q = authorizeUrl.searchParams;
      assert.equal(q.get('response_type'), 'code');
      assert.equal(q.get('client_id'), 'alexa-voice-client');
      assert.equal(q.get('code_challenge_method'), 'S256');
      assert.equal(q.get('access_type'), 'offline');
      assert.equal(q.get('request_credentials'), 'required');
      assert.equal(q.get('scope'), `${SERVICE_ID} offline_access`);
      const code = world.next('CANARY-YT-CODE');
      youtrackCodes.set(code, {
        challenge: q.get('code_challenge') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
        login: world.youtrackLogin,
        hubId: options.youtrackHubId ?? (world.youtrackLogin === HOUSEHOLD_LOGIN ? HOUSEHOLD_HUB_ID : OTHER_HUB_ID),
      });
      const back = new URL(q.get('redirect_uri') ?? '');
      return getEvent(back.pathname, {code, state: q.get('state') ?? ''});
    },
    /** The browser at Amazon's login: signs in and follows the redirect back to the broker. */
    amazonSignIn(authorizeUrl: URL): FunctionUrlEvent {
      assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, 'https://www.amazon.com/ap/oa');
      const q = authorizeUrl.searchParams;
      assert.equal(q.get('client_id'), SECRETS.lwaClientId);
      assert.equal(q.get('scope'), 'alexa::skills:account_linking');
      assert.equal(q.get('response_type'), 'code');
      assert.equal(q.get('code_challenge_method'), 'S256');
      const code = world.next('CANARY-LWA-CODE');
      lwaCodes.set(code, {challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? ''});
      const back = new URL(q.get('redirect_uri') ?? '');
      return getEvent(back.pathname, {code, state: q.get('state') ?? ''});
    },
    /** A refresh token Hub knows, for tests that start at /token. */
    seedRefreshToken(login = HOUSEHOLD_LOGIN): string {
      const token = world.next('CANARY-YT-REFRESH');
      refreshTokens.set(token, login);
      return token;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({url: url.toString(), method: init?.method ?? 'GET', headers, body});
      assert.equal(init?.redirect, 'error', 'upstream requests must not follow redirects');
      const forced = (key: string) => {
        const failure = failures.get(key);
        if (failure === 'network') throw new TypeError('fetch failed');
        return failure;
      };
      const jsonResponse = (status: number, value: unknown) =>
        new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

      if (url.toString() === `${HUB}/token`) {
        const form = new URLSearchParams(body);
        const grant = form.get('grant_type');
        const key = grant === 'refresh_token' ? 'hub-refresh' : 'hub-token';
        const failure = forced(key);
        if (failure) return failure;
        if (headers.authorization !== basic('alexa-voice-client', SECRETS.youtrackClientSecret)) {
          return jsonResponse(401, {error: 'invalid_client'});
        }
        if (grant === 'authorization_code') {
          const issued = youtrackCodes.get(form.get('code') ?? '');
          youtrackCodes.delete(form.get('code') ?? '');
          if (
            issued === undefined ||
            issued.redirectUri !== form.get('redirect_uri') ||
            s256Challenge(form.get('code_verifier') ?? '') !== issued.challenge
          ) {
            return jsonResponse(400, {error: 'invalid_grant', error_description: 'bad code'});
          }
          const access = world.next('CANARY-YT-ACCESS');
          accessTokens.set(access, issued.login);
          hubIds.set(issued.login, issued.hubId);
          const answer: Record<string, unknown> = {access_token: access, expires_in: 3600};
          const firstTime = !usersWithRefreshToken.has(issued.login);
          if (options.issueRefreshToken !== false && (options.refreshTokenOncePerUser !== true || firstTime)) {
            usersWithRefreshToken.add(issued.login);
            const refresh = world.next('CANARY-YT-REFRESH');
            refreshTokens.set(refresh, issued.login);
            answer.refresh_token = refresh;
          }
          return jsonResponse(200, answer);
        }
        if (grant === 'refresh_token') {
          world.refreshScopes.push(form.get('scope'));
          // Hub's parameter table marks scope Required; this fake enforces the table.
          if (form.get('scope') !== `${SERVICE_ID} offline_access`)
            return jsonResponse(400, {error: 'invalid_request'});
          const login = refreshTokens.get(form.get('refresh_token') ?? '');
          if (login === undefined) return jsonResponse(400, {error: 'invalid_grant'});
          const access = world.next('CANARY-YT-ACCESS');
          accessTokens.set(access, login);
          return jsonResponse(200, {access_token: access, expires_in: 3600});
        }
        return jsonResponse(400, {error: 'unsupported_grant_type'});
      }

      if (url.toString() === `${YOUTRACK_URL}/api/users/me?fields=id,login,ringId`) {
        const failure = forced('users-me');
        if (failure) return failure;
        const login = accessTokens.get((headers.authorization ?? '').replace(/^Bearer /, ''));
        return login === undefined
          ? jsonResponse(401, {error: 'unauthorized'})
          : jsonResponse(200, {id: '1-7', login, ringId: hubIds.get(login), $type: 'Me'});
      }

      if (url.toString() === 'https://api.amazon.com/auth/o2/token') {
        const failure = forced('lwa-token');
        if (failure) return failure;
        const form = new URLSearchParams(body);
        const issued = lwaCodes.get(form.get('code') ?? '');
        lwaCodes.delete(form.get('code') ?? '');
        if (
          form.get('client_id') !== SECRETS.lwaClientId ||
          form.get('client_secret') !== SECRETS.lwaClientSecret ||
          issued === undefined ||
          issued.redirectUri !== form.get('redirect_uri') ||
          s256Challenge(form.get('code_verifier') ?? '') !== issued.challenge
        ) {
          return jsonResponse(400, {error: 'invalid_grant', error_description: 'The authorization code is invalid'});
        }
        const token = world.next('Atza|CANARY-AMAZON-ACCESS');
        accessTokens.set(token, 'amazon');
        return jsonResponse(200, {access_token: token, token_type: 'bearer', expires_in: 3600});
      }

      if (url.toString() === `https://api.amazonalexa.com/v1/users/~current/skills/${SKILL_ID}/enablement`) {
        const failure = forced('enablement');
        if (failure) return failure;
        const bearer = (headers.authorization ?? '').replace(/^Bearer /, '');
        if (accessTokens.get(bearer) !== 'amazon') return jsonResponse(401, {message: 'Invalid token'});
        const request = JSON.parse(body) as {
          stage: string;
          accountLinkRequest: {redirectUri: string; authCode: string; type: string};
        };
        world.enablement.body = request;
        assert.ok(broker, 'setBroker was not called');
        const answer = await broker(
          tokenEvent(
            {
              grant_type: 'authorization_code',
              code: request.accountLinkRequest.authCode,
              redirect_uri: request.accountLinkRequest.redirectUri,
            },
            world.redeemAuthorization,
          ),
        );
        world.enablement.tokenAnswer = answer;
        if (answer.statusCode !== 200) {
          // A message that repeats what it was sent, so the page's scrubbing is tested against a hostile echo.
          return jsonResponse(400, {
            message: `Invalid account linking credentials for code ${request.accountLinkRequest.authCode} with Bearer ${bearer}`,
          });
        }
        return jsonResponse(201, {
          skill: {id: SKILL_ID, stage: request.stage},
          user: {id: 'amzn1.ask.account.CANARYUSER'},
          accountLink: {status: 'LINKED'},
          status: 'ENABLED',
        });
      }
      return new Response('not found', {status: 404});
    }) as typeof fetch,
  };
  return world;
}

export interface BrokerUnderTest {
  handler: LinkBrokerHandler;
  world: ReturnType<typeof fakeWorld>;
  clock: TestClock;
  table: ReturnType<typeof fakeLinkTable>;
  store: LinkStore;
  logs: ReturnType<typeof logCapture>;
  /** Every 32-byte random value the broker drew (states, codes, verifiers), as the base64url text it used. */
  generated: string[];
  setup: ReturnType<typeof fakeSetupSecrets>;
}

export function brokerUnderTest(
  options: WorldOptions & {deps?: Partial<LinkBrokerDeps>; env?: Record<string, string>} = {},
): BrokerUnderTest {
  const world = fakeWorld(options);
  const clock = new TestClock();
  const table = fakeLinkTable();
  const store = createDynamoLinkStore({client: table.client, tableName: 'links', now: () => clock.now()});
  const logs = logCapture();
  const generated: string[] = [];
  const draw = counterRandom();
  const random = (size: number) => {
    const bytes = draw(size);
    if (size === 32) generated.push(Buffer.from(bytes).toString('base64url'));
    return bytes;
  };
  const setup = fakeSetupSecrets();
  const handler = createLinkBroker({
    settings: testSettings(options.env),
    secrets: TOKEN_SECRETS,
    setupSecrets: setup.secrets,
    store,
    fetch: world.fetch,
    clock,
    random,
    log: createJsonLogger({level: 'debug', write: logs.write, now: () => clock.now()}),
    ...options.deps,
  });
  world.setBroker(handler);
  return {handler, world, clock, table, store, logs, generated, setup};
}

/**
 * Asserts that no log line contains any secret, any value the fakes issued, or any state or code the broker put in a
 * URL or a token response. Registered with `t.after` by the tests, so it runs whatever the test did.
 */
export function assertNoSecretsLogged(b: BrokerUnderTest, extra: readonly string[] = []): void {
  const written = b.logs.lines.join('\n');
  const values = [...Object.values(SECRETS), ...b.world.issued, ...b.generated, ...extra].filter(
    (value) => value.length >= 8,
  );
  for (const value of values) {
    assert.equal(written.includes(value), false, `a log line contains ${value.slice(0, 18)}...`);
    assert.equal(
      written.includes(encodeURIComponent(value)),
      false,
      `a log line contains encoded ${value.slice(0, 18)}`,
    );
  }
}
