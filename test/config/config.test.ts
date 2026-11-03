import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {configFiles, configuredProject, loadConfig} from '../../src/config.ts';
import {createClient} from '../../client.ts';
import {resolveIdentity} from '../../identity.ts';

const BASE = {YOUTRACK_TOKEN: 'private-token', YOUTRACK_URL: 'https://tracker.example', YOUTRACK_PROJECT: 'YA'};

/** A scratch directory removed by the runner, even when an assertion fails first. */
function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'ya25-config-'));
  t.after(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  return directory;
}

function envFile(t: TestContext, text: string): string {
  const file = join(scratch(t), 'env');
  writeFileSync(file, text);
  return file;
}

test('file config resolves owner and identity without mutating the environment', (t) => {
  const file = envFile(
    t,
    'YOUTRACK_TOKEN=private\nYOUTRACK_URL=https://tracker.example\nYOUTRACK_PROJECT=YA\nYOUTRACK_OWNER=owner\nYOUTRACK_BOARD=Main\nAI_MODEL=file-model\n',
  );
  const before = {...process.env};
  const config = loadConfig({}, {environment: {}, files: [file]});
  assert.equal(config.owner, 'owner');
  assert.equal(config.ownerIsDefault, false);
  assert.equal(config.sprintBoard, 'Main');
  assert.equal(config.source, file);
  assert.equal(resolveIdentity({}, config.environment).model, 'file-model');
  assert.ok(JSON.stringify({...process.env}) === JSON.stringify(before), 'process environment changed');
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.environment));
});

test('explicit values override environment and malformed URLs reject', () => {
  const environment = {...BASE, YOUTRACK_OWNER: 'env-owner'};
  assert.equal(loadConfig({owner: 'explicit'}, {environment, files: []}).owner, 'explicit');
  assert.throws(() => loadConfig({baseUrl: 'https://user:pass@tracker.example'}, {environment, files: []}));
});

// Reviewer candidate R-G1 (YA-8 review T10): the environment wins over the env file, owner included.
test('environment overrides the env file for owner', (t) => {
  const file = envFile(
    t,
    'YOUTRACK_TOKEN=t\nYOUTRACK_URL=https://x.example\nYOUTRACK_PROJECT=YA\nYOUTRACK_OWNER=file-owner\n',
  );
  assert.equal(loadConfig({}, {environment: {YOUTRACK_OWNER: 'env-owner'}, files: [file]}).owner, 'env-owner');
});

// Reviewer candidate R-G2 (YA-8 review T10): an explicit YOUTRACK_ENV_FILE is consulted before any discovered file.
test('YOUTRACK_ENV_FILE is the first candidate', () => {
  assert.equal(configFiles('/', {YOUTRACK_ENV_FILE: '/explicit/env'})[0], '/explicit/env');
});

// YA-25 B3: the permanent token is a bearer credential, so it only travels in cleartext to the local machine.
test('the URL must be https, except http to a loopback host', () => {
  const load = (url: string) => loadConfig({}, {environment: {...BASE, YOUTRACK_URL: url}, files: []});
  assert.equal(load('https://tracker.example').baseUrl, 'https://tracker.example');
  for (const url of ['http://localhost:8080', 'http://127.0.0.1:8111/youtrack', 'http://[::1]:9000']) {
    assert.equal(load(url).baseUrl, url);
  }
  for (const url of [
    'http://tracker.example',
    'http://localhost.example',
    'http://127.0.0.2',
    'http://10.0.0.1',
    'http://[::2]',
    'ftp://tracker.example',
  ]) {
    assert.throws(() => load(url), /https:/, url);
  }
});

// YA-25 Y1: an env file found by the upward walk must never choose where a token it did not supply is sent.
test('an env file without the token in use supplies nothing: not URL, project, owner, team, boards or identity', (t) => {
  const root = scratch(t);
  const repo = join(root, 'hostile-repo');
  const cwd = join(repo, 'sub');
  mkdirSync(cwd, {recursive: true});
  writeFileSync(
    join(repo, '.env.youtrack'),
    'YOUTRACK_URL=https://collector.evil.example\nYOUTRACK_PROJECT=EVIL\nYOUTRACK_OWNER=attacker\nYOUTRACK_TEAM_GROUP=Evil\nYOUTRACK_BOARD=Main\nYOUTRACK_SPRINT_BOARD=Evil board\nAI_MODEL=file-model\nAI_SESSION_ID=file-session\n',
  );
  const files = configFiles(cwd, {}).filter((candidate) => candidate.startsWith(root));
  assert.throws(
    () => loadConfig({}, {environment: {YOUTRACK_TOKEN: 'real-token', YOUTRACK_PROJECT: 'H'}, files}),
    (error: Error) =>
      /no YouTrack URL/.test(error.message) &&
      error.message.includes(join(repo, '.env.youtrack')) &&
      !error.message.includes('real-token'),
  );
  assert.throws(
    () => loadConfig({token: 'flag-token'}, {environment: {YOUTRACK_PROJECT: 'H'}, files}),
    /no YouTrack URL/,
  );

  // With the URL exported too, the file's URL, project, owner and team group are all ignored.
  const config = loadConfig(
    {},
    {environment: {YOUTRACK_TOKEN: 'real-token', YOUTRACK_URL: 'https://real.example', YOUTRACK_PROJECT: 'H'}, files},
  );
  assert.equal(config.baseUrl, 'https://real.example');
  assert.equal(config.project, 'H');
  assert.equal(config.owner, 'admin');
  assert.equal(config.ownerIsDefault, true);
  assert.equal(config.teamGroup, undefined);
  // Boards and identity don't come from the file either: a planted YOUTRACK_SPRINT_BOARD would choose where
  // `sprint add` writes under the real token, and a planted AI_MODEL would forge the stamp (YA-25 N1).
  assert.notEqual(config.board, 'Main');
  assert.notEqual(config.sprintBoard, 'Evil board');
  assert.notEqual(resolveIdentity({}, config.environment).model, 'file-model');
  assert.notEqual(resolveIdentity({}, config.environment).session, 'file-session');
  assert.equal(config.source, 'environment');
  // Without a URL of its own, no project from the file either.
  assert.throws(
    () => loadConfig({}, {environment: {YOUTRACK_TOKEN: 'real-token', YOUTRACK_URL: 'https://real.example'}, files}),
    /no YouTrack project/,
  );
});

test('an env file that holds the token supplies everything, even beneath the same exported token', (t) => {
  const file = envFile(
    t,
    'YOUTRACK_TOKEN=file-token\nYOUTRACK_URL=https://file.example\nYOUTRACK_PROJECT=YA\nYOUTRACK_OWNER=file-owner\nYOUTRACK_TEAM_GROUP=File Team\n',
  );
  const own = loadConfig({}, {environment: {}, files: [file]});
  assert.equal(own.baseUrl, 'https://file.example');
  assert.equal(own.owner, 'file-owner');
  assert.equal(own.source, file);
  const same = loadConfig(
    {},
    {environment: {YOUTRACK_TOKEN: 'file-token', YOUTRACK_BOARD: 'Env Board'}, files: [file]},
  );
  assert.equal(same.baseUrl, 'https://file.example');
  assert.equal(same.owner, 'file-owner');
  assert.equal(same.teamGroup, 'File Team');
  assert.equal(same.board, 'Env Board');
  assert.equal(same.source, `environment + ${file}`);
  // A different exported token is not the file's, so the file's URL is not used for it.
  assert.throws(() => loadConfig({}, {environment: {YOUTRACK_TOKEN: 'other-token'}, files: [file]}), /no YouTrack URL/);
});

// YA-25 B4: `admin` is a placeholder, and callers must be able to tell it from a configured owner.
test('an unconfigured or empty owner is marked as the admin default', () => {
  const unset = loadConfig({}, {environment: BASE, files: []});
  assert.equal(unset.owner, 'admin');
  assert.equal(unset.ownerIsDefault, true);
  const empty = loadConfig({}, {environment: {...BASE, YOUTRACK_OWNER: ' '}, files: []});
  assert.equal(empty.ownerIsDefault, true);
  const admin = loadConfig({}, {environment: {...BASE, YOUTRACK_OWNER: 'admin'}, files: []});
  assert.equal(admin.owner, 'admin');
  assert.equal(admin.ownerIsDefault, false);
});

// YA-25 B11 (YA-8 S8): a host that logs its config or client must not log the shared credential.
test('the token is usable but never serialised or inspected', async () => {
  const config = loadConfig({}, {environment: {...BASE, YOUTRACK_TOKEN: 'secret-credential-value'}, files: []});
  assert.equal(config.token, 'secret-credential-value');
  assert.ok(!Object.keys(config).includes('token'));
  for (const text of [
    JSON.stringify(config),
    inspect(config),
    inspect(config, {showHidden: true, depth: 10}),
    `${JSON.stringify({wrapped: config})}`,
  ]) {
    assert.doesNotMatch(text, /secret-credential-value/);
  }
  let authorization = '';
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('Authorization') ?? '';
        return Response.json({id: '1', login: 'agent', fullName: 'Agent', email: null});
      },
    },
  );
  assert.doesNotMatch(JSON.stringify(client.config), /secret-credential-value/);
  assert.doesNotMatch(inspect(client, {showHidden: true, depth: 10}), /secret-credential-value/);
  await client.whoami();
  assert.equal(authorization, 'Bearer secret-credential-value');
});

// YA-25 B6 (YA-8 C6): a token that fetch would refuse is a configuration error, not an unknown write outcome.
test('a token that cannot be sent in a header rejects at load time without echoing it', () => {
  for (const token of ['perm:abc\ndef', 'perm abc', 'perm:été']) {
    assert.throws(
      () => loadConfig({}, {environment: {...BASE, YOUTRACK_TOKEN: token}, files: []}),
      (error: Error) => /HTTP header/.test(error.message) && !error.message.includes('abc'),
    );
  }
  assert.equal(loadConfig({}, {environment: {...BASE, YOUTRACK_TOKEN: ' perm:a.b.c '}, files: []}).token, 'perm:a.b.c');
});

// YA-25 B12: help shows the configured project key without needing a token.
test('configuredProject reads the environment, then the first env file, and never throws', (t) => {
  const file = envFile(t, 'YOUTRACK_PROJECT=FILE\n');
  assert.equal(configuredProject({environment: {YOUTRACK_PROJECT: 'ENV'}, files: [file]}), 'ENV');
  assert.equal(configuredProject({environment: {}, files: [file]}), 'FILE');
  assert.equal(configuredProject({environment: {}, files: []}), undefined);
  // A directory exists but cannot be read as a file.
  assert.equal(configuredProject({environment: {}, files: [scratch(t)]}), undefined);
});

// YA-8 review G4: the CLI uses the ambient environment, so that path must not write the file into process.env.
test('loading from the ambient environment leaves process.env untouched', (t) => {
  const saved = {...process.env};
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('YOUTRACK_') || name.startsWith('AI_')) delete process.env[name];
  }
  const file = envFile(
    t,
    'YOUTRACK_TOKEN=t\nYOUTRACK_URL=https://x.example\nYOUTRACK_PROJECT=YA\nAI_MODEL=file-model\n',
  );
  const config = loadConfig({}, {files: [file]});
  assert.equal(config.project, 'YA');
  assert.equal(process.env.YOUTRACK_TOKEN, undefined);
  assert.equal(process.env.AI_MODEL, undefined);
});

// YA-8 review G6: YOUTRACK_TEAM_GROUP reaches the config from the environment and from the file.
test('YOUTRACK_TEAM_GROUP is read from the environment and the env file', (t) => {
  assert.equal(
    loadConfig({}, {environment: {...BASE, YOUTRACK_TEAM_GROUP: 'Env Team'}, files: []}).teamGroup,
    'Env Team',
  );
  const file = envFile(t, `YOUTRACK_TOKEN=${BASE.YOUTRACK_TOKEN}\nYOUTRACK_TEAM_GROUP=File Team\n`);
  assert.equal(loadConfig({}, {environment: BASE, files: [file]}).teamGroup, 'File Team');
});
