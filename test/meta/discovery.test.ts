// The gate is only as good as the files it runs. npm hands each script to `sh -c`, and sh has no globstar, so an
// unquoted `test/**/*.test.ts` silently means `test/*/*.test.ts` (YA-8 review A4). These tests run the real scripts
// through sh in a scratch tree instead of trusting how the pattern reads.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {scripts: Record<string, string>})
  .scripts;

/** Every `*.test.ts` under a directory, as posix paths relative to its parent: what `find test -name` lists. */
function testFiles(base: string): string[] {
  return readdirSync(join(base, 'test'), {recursive: true, encoding: 'utf8'})
    .filter((path) => path.endsWith('.test.ts'))
    .map((path) => `test/${path.split(sep).join('/')}`)
    .sort();
}

/**
 * Environment for a child `node --test`: without NODE_TEST_CONTEXT it reports normally instead of to this runner.
 * The scratch tree doubles as HOME, so nothing the child runs can find the developer's config (YA-8 review T13).
 */
function childEnvironment(home: string): NodeJS.ProcessEnv {
  // An existing empty YOUTRACK_ENV_FILE ends config discovery before the walk reaches the temp directory's ancestors.
  const stop = join(home, '.empty-youtrack-env');
  writeFileSync(stop, '');
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    YOUTRACK_ENV_FILE: stop,
    TZ: 'UTC',
  };
}

/**
 * The argv a script's command receives after sh has expanded it, obtained by swapping the command word for printf.
 * A glob that survives as literal text was quoted, so the tool itself expands it recursively.
 */
function shellArgv(script: string, cwd: string): string[] {
  const rest = script.slice(script.indexOf(' '));
  const result = spawnSync('sh', ['-c', `printf '%s\\n'${rest}`], {
    cwd,
    encoding: 'utf8',
    env: childEnvironment(cwd),
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter(Boolean);
}

/** A scratch tree whose test files are trivial canaries, one per path, each named after its own path. */
function canaryTree(t: {after: (fn: () => void) => void}, paths: string[]): string {
  const base = mkdtempSync(join(tmpdir(), 'ya8-discovery-'));
  t.after(() => {
    rmSync(base, {recursive: true, force: true});
  });
  writeFileSync(join(base, 'package.json'), '{"type": "module"}\n');
  for (const path of paths) {
    mkdirSync(dirname(join(base, path)), {recursive: true});
    writeFileSync(join(base, path), `import {test} from 'node:test';\ntest('canary ${path}', () => {});\n`);
  }
  return base;
}

test('npm test runs every *.test.ts in the repository, including nested and top-level canaries', (t) => {
  const repository = testFiles(root);
  assert.ok(repository.length > 0, 'no test files found');
  // Mirror the repository's layout, then add the depths an unquoted sh glob misses: directly under test/, and deep.
  const extra = ['test/top-level-canary.test.ts', 'test/meta/nested/deeper/canary.test.ts'];
  const base = canaryTree(t, [...new Set([...repository, ...extra])]);
  const expected = testFiles(base);
  assert.ok(expected.includes(extra[0]) && expected.includes(extra[1]));

  const result = spawnSync('sh', ['-c', scripts.test], {
    cwd: base,
    encoding: 'utf8',
    env: childEnvironment(base),
    // Under the 30 s per-test timeout in `npm test`, so a hung child fails this test rather than the runner.
    timeout: 25_000,
    killSignal: 'SIGKILL',
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, output);
  const ran = [...new Set([...output.matchAll(/canary (test\/\S+\.test\.ts)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(ran, expected, 'npm test skipped or invented test files');
});

test('npm test and the format scripts pass their globs to the tool unexpanded by sh', (t) => {
  const base = canaryTree(t, ['test/a/b/c.test.ts', 'test/a/d.test.ts']);
  mkdirSync(join(base, 'src', 'a', 'b'), {recursive: true});
  writeFileSync(join(base, 'src', 'a', 'b', 'x.ts'), '');
  writeFileSync(join(base, 'src', 'a', 'y.ts'), '');
  writeFileSync(join(base, 'z.ts'), '');
  assert.ok(shellArgv(scripts.test, base).includes('test/**/*.test.ts'), scripts.test);
  // A hung test fails on its own instead of stalling the gate (YA-8 review T12).
  assert.ok(shellArgv(scripts.test, base).includes('--test-timeout=30000'), scripts.test);
  for (const name of ['format', 'format:check']) {
    const argv = shellArgv(scripts[name], base);
    for (const glob of ['*.ts', 'src/**/*.ts', 'test/**/*.ts']) {
      assert.ok(argv.includes(glob), `${name} lets sh expand ${glob}: ${scripts[name]}`);
    }
  }
});
