/**
 * Runs every transcript in test/voice/core/transcripts. Each file is one conversation; see transcript-runner.ts for
 * the format and for the invariants checked on every response.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {responseInvariantFailures, runTranscript, TRANSCRIPTS_DIR} from './transcript-runner.ts';

const files = readdirSync(TRANSCRIPTS_DIR)
  .filter((file) => file.endsWith('.txt'))
  .sort();

test('there is a transcript for every numbered design rule that stage 1 implements', () => {
  for (const rule of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(
      files.some((file) => file.startsWith(`rule${rule}-`)),
      `no transcript named rule${rule}-*.txt`,
    );
  }
});

for (const file of files) {
  test(`transcript ${file}`, async () => {
    const result = await runTranscript(readFileSync(join(TRANSCRIPTS_DIR, file), 'utf8'), file);
    assert.ok(result.turns.length > 0, 'a transcript with no turns tests nothing');
    assert.deepEqual(result.failures, []);
  });
}

test('the runner reports a wrong expectation with its line number', async () => {
  const result = await runTranscript('> my issues\n< You have 99 issues.\n< ...\n', 'broken.txt');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^broken\.txt:1: "my issues"/);
});

test('the runner catches a turn with no expectation', async () => {
  const result = await runTranscript('> help\n> my issues\n< You have 8 issues.\n< ...\n', 'missing.txt');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /missing\.txt:1: turn "help" has no expected lines/);
});

test('malformed directives fail loudly, naming the line', async () => {
  const cases: Array<[string, RegExp]> = [
    ['@maxchars 150x\n> help\n< ...', /bad\.txt:1: Not a whole number: "150x"/],
    ['@confidence low', /bad\.txt:1: Confidence must be between 0 and 1/],
    ['@fail getIssue unavailble', /bad\.txt:1: Unknown failure kind "unavailble"/],
    ['@fail getIsue unavailable', /bad\.txt:1: Unknown tracker method "getIsue"/],
    ['@cap 3\n@fixture team', /bad\.txt:2: @fixture would discard tracker settings/],
    ['@update YA-21 summary', /bad\.txt:1: @update takes KEY field=value/],
    ['@update YA-21 colour=red', /bad\.txt:1: Cannot update field "colour"/],
    ['@policy persn', /bad\.txt:1: Unknown evidence kind "persn"/],
    ['@end banana', /bad\.txt:1: Unknown end reason "banana"/],
    ['@intent explode', /bad\.txt:1: Unknown intent "explode"/],
    ['> help\n< ...', /bad\.txt:2: "< \.\.\." needs at least one expected line/],
    ['< orphan', /bad\.txt:1: expected line with no turn before it/],
    ['@assert listen true', /bad\.txt:1: @assert with no turn before it/],
    ['> help\n< ...x\n@assert colour blue', /bad\.txt:3: Unknown assertion "colour"/],
    ['@wibble', /bad\.txt:1: Unknown directive @wibble/],
    ['@at yesterday', /bad\.txt:1: @at takes an ISO 8601 time/],
    ['hello', /bad\.txt:1: unrecognised line/],
  ];
  for (const [source, message] of cases) {
    await assert.rejects(runTranscript(source, 'bad.txt'), message, source);
  }
});

test('each response invariant fires on a response that breaks it', () => {
  const base = {segments: [{text: 'Fine.'}], listen: false, ratePercent: 100};
  assert.deepEqual(responseInvariantFailures(base, 100, false), []);
  const broken: Array<[string, string]> = [
    ['Run `npm test`', 'forbidden'],
    ['a | b', 'forbidden'],
    ['see https://x.example', 'forbidden'],
    ['blocked by YA-12', 'forbidden'],
    ['token ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'forbidden'],
    ['hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b', 'forbidden'],
    ['~~old~~ text', 'forbidden'],
    ['a <br> b', 'forbidden'],
    ['a &amp; b', 'forbidden'],
    ['Please check the app.', 'forbidden'],
  ];
  for (const [text, kind] of broken) {
    const failures = responseInvariantFailures({...base, segments: [{text}]}, 1000, false);
    assert.ok(
      failures.some((failure) => failure.includes(kind)),
      text,
    );
  }
  assert.match(responseInvariantFailures({...base, segments: [{text: 'x'.repeat(101)}]}, 100, false)[0], /over 100/);
  assert.match(responseInvariantFailures({...base, listen: true}, 100, false)[0], /no reprompt/);
  assert.match(responseInvariantFailures(base, 100, true)[0], /after the session ended/);
  assert.match(
    responseInvariantFailures({...base, listen: true, reprompt: [{text: 'y'.repeat(101)}]}, 100, false)[0],
    /reprompt is 101 chars/,
  );
});
