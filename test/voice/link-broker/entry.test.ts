import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test, {type TestContext} from 'node:test';
import {createLinkEntry, SDK_CLIENT_CONFIG} from '../../../src/voice/link-broker/deploy/entry.ts';
import type {FunctionUrlEvent, FunctionUrlResult} from '../../../src/voice/link-broker/http.ts';
import {
  ALEXA_REDIRECT,
  ALEXA_STATE,
  counterRandom,
  DOMAIN,
  ENV,
  fakeLinkTable,
  fakeSsm,
  fakeWorld,
  getEvent,
  location,
  logCapture,
  SECRETS,
  TestClock,
} from './fakes.ts';

/** A Function URL event exactly as Lambda delivers one (payload format 2.0), for a browser GET or Amazon's POST. */
function functionUrlEvent(
  method: 'GET' | 'POST',
  url: URL,
  init: {body?: string; headers?: Record<string, string>} = {},
) {
  const event: FunctionUrlEvent = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers: {
      host: DOMAIN,
      'user-agent': method === 'GET' ? 'Mozilla/5.0 (iPhone)' : 'Apache-HttpClient',
      'x-forwarded-proto': 'https',
      ...init.headers,
    },
    requestContext: {
      domainName: DOMAIN,
      http: {method, path: url.pathname},
      requestId: `req-${url.pathname}`,
    },
    body: init.body === undefined ? undefined : Buffer.from(init.body).toString('base64'),
    isBase64Encoded: init.body !== undefined,
  };
  return event;
}

async function entryUnderTest(t: TestContext) {
  const world = fakeWorld();
  const clock = new TestClock();
  const table = fakeLinkTable();
  const logs = logCapture();
  const ssm = fakeSsm();
  const handler = await createLinkEntry({
    env: {...ENV, LOG_LEVEL: 'debug', LINK_BROKER_AUTHORIZE: 'on'},
    write: logs.write,
    dynamo: table.client,
    ssm: ssm.client,
    fetch: world.fetch,
    clock,
    random: counterRandom('entry'),
  });
  world.setBroker(handler);
  t.after(() => {
    const written = logs.lines.join('\n');
    for (const value of [...Object.values(SECRETS), ...world.issued]) {
      assert.equal(written.includes(value), false, `a log line contains ${value.slice(0, 18)}...`);
    }
  });
  return {handler, world, clock, table, logs, ssm};
}

test('end to end through Function URL events: Alexa-initiated linking, the code at /token, then a refresh', async (t) => {
  const e = await entryUnderTest(t);
  assert.deepEqual(
    e.ssm.calls.map((call) => call.action),
    ['GetParameters'],
    'one batched read at build',
  );
  const ready = e.logs.parsed().find((line) => line.event === 'link.entry.ready');
  assert.equal(ready?.authorizeEnabled, true);

  const authorize = new URL(`https://${DOMAIN}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: SECRETS.brokerClientId,
    response_type: 'code',
    state: ALEXA_STATE,
    scope: 'profile',
    redirect_uri: ALEXA_REDIRECT,
  }).toString();
  const toYouTrack = location(await e.handler(functionUrlEvent('GET', authorize)));
  const callback = e.world.youtrackSignIn(toYouTrack);
  const back = location(
    await e.handler(
      functionUrlEvent('GET', new URL(`https://${DOMAIN}${callback.rawPath}?${callback.rawQueryString}`)),
    ),
  );
  const code = back.searchParams.get('code') ?? '';

  const tokenUrl = new URL(`https://${DOMAIN}/token`);
  const credentials = Buffer.from(`${SECRETS.brokerClientId}:${SECRETS.brokerClientSecret}`).toString('base64');
  const post = (body: string): Promise<FunctionUrlResult> =>
    e.handler(
      functionUrlEvent('POST', tokenUrl, {
        body,
        headers: {'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${credentials}`},
      }),
    );
  const issued = await post(
    new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: ALEXA_REDIRECT}).toString(),
  );
  assert.equal(issued.statusCode, 200);
  const tokens = JSON.parse(issued.body) as {access_token: string; refresh_token: string};

  e.clock.advance(3_600_000);
  const refreshed = await post(
    new URLSearchParams({grant_type: 'refresh_token', refresh_token: tokens.refresh_token}).toString(),
  );
  assert.equal(refreshed.statusCode, 200);
  const next = JSON.parse(refreshed.body) as {access_token: string; refresh_token: string};
  assert.notEqual(next.access_token, tokens.access_token);
  assert.equal(next.refresh_token, tokens.refresh_token);
  assert.equal(e.table.items.size, 0);
});

test('end to end through Function URL events: app-to-app linking with fake YouTrack, Login with Amazon and Alexa', async (t) => {
  const e = await entryUnderTest(t);
  const start = new URL(`https://${DOMAIN}/start`);
  start.searchParams.set('k', SECRETS.setupKey);
  const toAmazon = location(await e.handler(functionUrlEvent('GET', start)));
  const amazonBack = e.world.amazonSignIn(toAmazon);
  const toYouTrack = location(
    await e.handler(
      functionUrlEvent('GET', new URL(`https://${DOMAIN}${amazonBack.rawPath}?${amazonBack.rawQueryString}`)),
    ),
  );
  const ytBack = e.world.youtrackSignIn(toYouTrack);
  const done = await e.handler(
    functionUrlEvent('GET', new URL(`https://${DOMAIN}${ytBack.rawPath}?${ytBack.rawQueryString}`)),
  );
  assert.equal(done.statusCode, 200, done.body);
  assert.match(done.body, /Linked/);
  assert.equal(e.world.enablement.tokenAnswer?.statusCode, 200);
  assert.equal(e.table.items.size, 0);
  const request = e.logs.parsed().filter((line) => line.event === 'link.request');
  assert.deepEqual(
    request.map((line) => [line.route, line.status]),
    [
      ['/start', 302],
      ['/amazon-callback', 302],
      ['/token', 200],
      ['/youtrack-callback', 200],
    ],
  );
});

test('the entry refuses to start without its settings or secrets, logging names and never values', async () => {
  const logs = logCapture();
  await assert.rejects(
    createLinkEntry({
      env: {...ENV, HOUSEHOLD_LOGIN: ''},
      write: logs.write,
      dynamo: fakeLinkTable().client,
      ssm: fakeSsm().client,
    }),
    /HOUSEHOLD_LOGIN is required/,
  );
  await assert.rejects(
    createLinkEntry({
      env: ENV,
      write: logs.write,
      dynamo: fakeLinkTable().client,
      ssm: fakeSsm(new Map()).client,
    }),
    /youtrack-client-secret is missing or empty/,
  );
  const failures = logs.parsed().filter((line) => line.event === 'link.entry.startFailed');
  assert.equal(failures.length, 2);
  assert.equal(logs.lines.join('\n').includes(SECRETS.brokerClientSecret), false);
});

test('the entry loads both SDKs dynamically and checks them for the clients it needs', async () => {
  const configs: unknown[] = [];
  const ssm = fakeSsm();
  const handler = await createLinkEntry({
    env: ENV,
    write: () => {},
    loadSsmSdk: async () => ({
      SSM: class {
        constructor(config: unknown) {
          configs.push(config);
        }

        getParameter = ssm.client.getParameter;

        getParameters = ssm.client.getParameters;
      },
    }),
    loadDynamoSdk: async () => ({
      DynamoDB: class {
        constructor(config: unknown) {
          configs.push(config);
        }
      },
    }),
    fetch: fakeWorld().fetch,
  });
  assert.equal(typeof handler, 'function');
  assert.deepEqual(configs, [SDK_CLIENT_CONFIG, SDK_CLIENT_CONFIG]);
  const notFound = await handler(getEvent('/nothing'));
  assert.equal(notFound.statusCode, 404);

  await assert.rejects(
    createLinkEntry({env: ENV, write: () => {}, loadSsmSdk: async () => ({}), dynamo: fakeLinkTable().client}),
    /@aws-sdk\/client-ssm does not export an SSM client/,
  );
});

test('inside Lambda the module builds during init, and a failed init build does not fail the import', () => {
  const entry = fileURLToPath(new URL('../../../src/voice/link-broker/deploy/entry.ts', import.meta.url));
  const script = `const m = await import(${JSON.stringify(entry)}); console.log('imported', typeof m.handler);`;
  // No settings and no SDK: the init build fails, is logged, and the module still loads for the handler to retry.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {PATH: process.env.PATH ?? '', AWS_LAMBDA_FUNCTION_NAME: 'youtrack-voice-link'},
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.match(lines[0] ?? '', /"event":"link.entry.startFailed".*YOUTRACK_URL is required/);
  assert.equal(lines.at(-1), 'imported function');

  // Outside Lambda nothing is built at import.
  const test = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {PATH: process.env.PATH ?? ''},
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(test.stdout.trim(), 'imported function');
});
