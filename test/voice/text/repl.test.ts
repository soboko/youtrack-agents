import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createFakeClock, FakeVoiceTracker, parseTrackerFixture} from '../../../src/voice/core/fakes.ts';
import type {VoiceResponse} from '../../../src/voice/core/types.ts';
import {FileStateStore} from '../../../src/voice/text/file-store.ts';
import {renderLines, sayWordsPerMinute} from '../../../src/voice/text/render.ts';
import {runRepl} from '../../../src/voice/text/repl.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLE = join(ROOT, 'docs', 'voice', 'sample-issues.json');
const REPL = join(ROOT, 'src', 'voice', 'text', 'repl.ts');
const NOW = Date.parse('2026-09-12T09:00:00Z');

async function sampleTracker(): Promise<FakeVoiceTracker> {
  return new FakeVoiceTracker(parseTrackerFixture(JSON.parse(await readFile(SAMPLE, 'utf8'))));
}

async function session(
  stateDir: string,
  lines: string[],
  extra: {evidence?: Array<'person' | 'account' | 'none'>; spoken?: VoiceResponse[]} = {},
): Promise<string[]> {
  let output = '';
  const spoken = extra.spoken;
  await runRepl({
    tracker: await sampleTracker(),
    store: new FileStateStore(stateDir),
    evidence: extra.evidence ?? ['person'],
    userId: 'text:test',
    maxSpeechChars: 2000,
    logLevel: 'off',
    echo: true,
    input: Readable.from(lines.map((line) => `${line}\n`)),
    output: {
      write: (text: string) => {
        output += text;
      },
    },
    errors: {write: () => true},
    now: createFakeClock(NOW).now,
    speak:
      spoken === undefined
        ? undefined
        : async (response) => {
            spoken.push(response);
          },
  });
  return output.trimEnd().split('\n');
}

test('the sample fixture loads and has about a dozen realistic issues', async () => {
  const fixture = parseTrackerFixture(JSON.parse(await readFile(SAMPLE, 'utf8')));
  assert.ok(fixture.issues.length >= 10 && fixture.issues.length <= 15);
  assert.ok(
    fixture.issues.some((issue) => (issue.description ?? '').includes('| ---')),
    'no table',
  );
  assert.ok(
    fixture.issues.some((issue) => /\]\(https?:/.test(issue.description ?? '')),
    'no link',
  );
  assert.ok(
    fixture.issues.some((issue) => (issue.comments ?? []).length > 1),
    'no comment thread',
  );
});

test('a scripted session prints the launch, echoes each line, and prints each segment on its own line', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-repl-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const lines = await session(stateDir, ['my issues', 'open two', 'read the description', 'where am I']);
  assert.deepEqual(lines.slice(0, 3), [
    "Tracker ready. Say 'my issues', or 'help'.",
    '> my issues',
    'You have 9 issues.',
  ]);
  assert.ok(lines.includes('[earcon: success]'));
  assert.ok(lines.includes('Draft the October community newsletter.'));
  assert.ok(lines.includes('Reading the description, paragraph 1 of 3.'));
});

test('state is kept in files, so the next run resumes where the last one stopped', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-repl-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  await session(stateDir, ['my issues', 'open two', 'description']);
  assert.equal((await readdir(stateDir)).length, 1);
  const lines = await session(stateDir, ['more']);
  assert.equal(lines[0], 'Welcome back.');
  assert.equal(lines[1], 'You were reading the description of Draft the October community newsletter.');
  assert.ok(lines.includes('Paragraph 2 of 3.'));
});

test('"stop" ends the session before the remaining input', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-repl-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const lines = await session(stateDir, ['stop', 'my issues']);
  assert.deepEqual(lines.slice(-2), ['> stop', 'Goodbye.']);
});

test('evidence from the command line gates reading', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-repl-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const lines = await session(stateDir, ['my issues'], {evidence: ['none']});
  assert.deepEqual(lines, [
    '[earcon: failure]',
    'Tracker ready.',
    "I can't read issues until I'm sure who's speaking.",
  ]);
});

test('with speech on, every response is handed to the speaker with its rate', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-repl-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const spoken: VoiceResponse[] = [];
  await session(stateDir, ['faster', 'help'], {spoken});
  assert.equal(spoken.length, 4);
  assert.equal(spoken[2].ratePercent, 125);
  assert.equal(spoken[3].segments.length, 0);
  assert.equal(sayWordsPerMinute(125), 219);
});

test('rendering puts the earcon first, then one line per segment', () => {
  assert.deepEqual(
    renderLines({earcon: 'endOfList', segments: [{text: 'A.'}, {text: 'B.'}], listen: false, ratePercent: 100}),
    ['[earcon: endOfList]', 'A.', 'B.'],
  );
});

test('the file store never writes outside its directory and reports absent state as null', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-store-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const store = new FileStateStore(stateDir);
  assert.equal(dirname(store.fileFor('../../etc/passwd')), stateDir);
  assert.equal(dirname(store.fileFor('..')), stateDir);
  assert.equal(await store.load('nobody'), null);
  assert.equal(await store.save('alexa:person:a/b', '{"x":1}', null), true);
  assert.equal((await store.load('alexa:person:a/b'))?.serialized, '{"x":1}');
  assert.deepEqual(await readdir(stateDir), ['alexa%3Aperson%3Aa%2Fb.json']);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
});

test('the file store refuses a save against a version it no longer holds, and leaves no temporary files', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-store-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const store = new FileStateStore(stateDir);
  assert.equal(await store.save('u', 'first', null), true);
  assert.equal(await store.save('u', 'again from nothing', null), false, 'null only matches an empty store');

  const a = await store.load('u');
  const b = await store.load('u');
  assert.ok(a !== null && b !== null);
  assert.equal(a.version, b.version);
  assert.equal(await store.save('u', 'from A', a.version), true);
  assert.equal(await store.save('u', 'from B', b.version), false);
  assert.equal((await store.load('u'))?.serialized, 'from A');
  assert.notEqual((await store.load('u'))?.version, a.version);
  assert.deepEqual(await readdir(stateDir), ['u.json']);
});

test('the file store accepts exactly one of two saves started together, even across two store objects', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-store-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  for (let trial = 0; trial < 20; trial++) {
    const user = `race-${trial}`;
    const first = new FileStateStore(stateDir);
    const second = new FileStateStore(stateDir);
    assert.equal(await first.save(user, 'start', null), true);
    const loaded = await first.load(user);
    assert.ok(loaded !== null);
    const results = await Promise.all([
      first.save(user, 'from A', loaded.version),
      second.save(user, 'from B', loaded.version),
    ]);
    assert.deepEqual([...results].sort(), [false, true], `trial ${trial}`);
    assert.equal((await first.load(user))?.serialized, results[0] ? 'from A' : 'from B');
    const racingNew = await Promise.all([first.save(`${user}-new`, 'A', null), second.save(`${user}-new`, 'B', null)]);
    assert.deepEqual([...racingNew].sort(), [false, true], `trial ${trial}, empty store`);
  }
  assert.ok(
    (await readdir(stateDir)).every((name) => name.endsWith('.json')),
    'a lock or temporary file was left',
  );
});

test('the file store takes over a lock left by a crashed save', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-store-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const store = new FileStateStore(stateDir);
  const lock = `${store.fileFor('u')}.lock`;
  await writeFile(lock, '');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal(await store.save('u', 'after the crash', null), true);
});

test('the command line refuses a missing fixture with usage, and runs a piped session', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-cli-'));
  t.after(async () => {
    await rm(stateDir, {recursive: true, force: true});
  });
  const children: Array<{kill: () => boolean}> = [];
  t.after(() => {
    for (const child of children) child.kill();
  });
  const run = (args: string[], input: string): Promise<{code: number; stdout: string; stderr: string}> =>
    new Promise((resolve) => {
      // A hung REPL (one waiting on stdin forever) fails the test instead of hanging the suite.
      const child = execFile(
        process.execPath,
        [REPL, ...args],
        {timeout: 15_000, killSignal: 'SIGKILL'},
        (error, stdout, stderr) => {
          assert.notEqual(error?.killed, true, 'the REPL was killed by the timeout');
          resolve({code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr});
        },
      );
      children.push(child);
      child.stdin?.end(input);
    });

  const missing = await run([], '');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--fixture is required/);

  const piped = await run(['--fixture', SAMPLE, '--state', stateDir], 'my issues\nstop\n');
  assert.equal(piped.code, 0);
  assert.match(piped.stdout, /^Tracker ready\. .*\n> my issues\nYou have 9 issues\.\n/);
  assert.match(piped.stdout, /> stop\nGoodbye\.\n$/);
});
