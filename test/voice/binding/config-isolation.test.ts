/**
 * The binding never reads configuration files or the ambient environment (YA-15 review K8, lifted from the security
 * probe p2): with an `.env.youtrack` planted in the working directory, one under $HOME, one named by
 * YOUTRACK_ENV_FILE and hostile YOUTRACK_* variables in `process.env`, a full-entry turn touches none of those files
 * and talks only to the configured instance with the linked token.
 */
import assert from 'node:assert/strict';
import fs, {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ACCOUNT_TOKEN, FakeClock, FIXTURE_TIME, loadEnvelope, SKILL_ID} from '../alexa/helpers.ts';
import {createFakeYouTrack, FAKE_BASE_URL} from './fake-youtrack.ts';

const PLANTED = 'YOUTRACK_URL=https://collector.evil.example\nYOUTRACK_PROJECT=YA\nYOUTRACK_TOKEN=perm:PLANTED\n';
// The configuration files themselves, not any path under a checkout that happens to be named youtrack-agents.
const CANDIDATE = /\.env\.youtrack|youtrack-agents[\\/]env$|explicit\.env/;

test('planted env files and a hostile process environment are never read or used', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ya15-config-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.config', 'youtrack-agents'), {recursive: true});
  writeFileSync(join(home, '.config', 'youtrack-agents', 'env'), PLANTED);
  writeFileSync(join(root, '.env.youtrack'), PLANTED);
  writeFileSync(join(root, 'explicit.env'), PLANTED);

  const saved = {cwd: process.cwd(), env: {...process.env}};
  const originalExists = fs.existsSync;
  const originalRead = fs.readFileSync;
  const touched: string[] = [];
  t.after(() => {
    fs.existsSync = originalExists;
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    process.chdir(saved.cwd);
    for (const name of Object.keys(process.env)) if (!(name in saved.env)) delete process.env[name];
    Object.assign(process.env, saved.env);
    rmSync(root, {recursive: true, force: true});
  });

  Object.assign(process.env, {
    HOME: home,
    YOUTRACK_ENV_FILE: join(root, 'explicit.env'),
    YOUTRACK_URL: 'https://collector.evil.example',
    YOUTRACK_PROJECT: 'YA',
    YOUTRACK_TOKEN: 'perm:AMBIENT',
  });
  process.chdir(root);
  // Records every look at a configuration candidate, from any module, named ESM imports included.
  fs.existsSync = (path) => {
    if (CANDIDATE.test(String(path))) touched.push(`exists ${String(path)}`);
    return originalExists(path);
  };
  fs.readFileSync = ((path: Parameters<typeof originalRead>[0], ...rest: unknown[]) => {
    if (CANDIDATE.test(String(path))) touched.push(`read ${String(path)}`);
    return (originalRead as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof originalRead;
  syncBuiltinESMExports();

  const {createLambdaHandler} = await import('../../../src/voice/alexa/deploy/lambda-entry.ts');
  const hosts = new Set<string>();
  const youtrack = createFakeYouTrack({
    accounts: new Map([[ACCOUNT_TOKEN, {login: 'household', fullName: 'Household'}]]),
    issues: [{key: 'H-1', summary: 'Kettle descaling', state: 'Open', assignee: 'household', updated: FIXTURE_TIME}],
    otherHost: async (url) => {
      hosts.add(url.host);
      return new Response(null, {status: 404});
    },
  });
  const lines: string[] = [];
  const handler = await createLambdaHandler({
    // What the template sets, plus the ambient token and env file a careless deploy might add.
    env: {
      SKILL_ID,
      READ_ACCEPTS: 'person,account',
      ACCOUNT_TOKEN_FALLBACK: 'true',
      STATE_TABLE: 'table',
      YOUTRACK_URL: FAKE_BASE_URL,
      HOUSEHOLD_LOGIN: 'household',
      YOUTRACK_TOKEN: 'perm:AMBIENT',
      YOUTRACK_ENV_FILE: join(root, 'explicit.env'),
    },
    write: (line) => lines.push(line),
    dynamo: {getItem: async () => ({}), putItem: async () => ({})},
    clock: new FakeClock(FIXTURE_TIME),
    fetch: async (input, init) => {
      hosts.add(new URL(String(input)).host);
      return youtrack.fetch(input, init);
    },
  });

  const event = loadEnvelope('launch') as {request: Record<string, unknown>};
  event.request = {
    ...event.request,
    type: 'IntentRequest',
    intent: {name: 'ListIntent', confirmationStatus: 'NONE', slots: {scope: {name: 'scope', value: 'mine'}}},
  };
  const response = await handler(event);
  assert.match(response.response.outputSpeech?.ssml ?? '', /Kettle descaling/);
  assert.deepEqual(touched, []);
  assert.deepEqual([...hosts].sort(), ['api.eu.amazonalexa.com', new URL(FAKE_BASE_URL).host].sort());
  assert.deepEqual(
    [...new Set(youtrack.requests.map((request) => request.authorization))],
    [`Bearer ${ACCOUNT_TOKEN}`],
  );
  const queries = youtrack.requests.flatMap((request) => (request.query.query ? [request.query.query] : []));
  assert.deepEqual(queries, ['project: H for: me #Unresolved sort by: updated desc']);
  assert.equal(lines.join('\n').includes('AMBIENT'), false);
  assert.equal(lines.join('\n').includes('PLANTED'), false);
});
