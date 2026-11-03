import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {parseArgs, pairs} from '../../src/cli/args.ts';
import {noteText, longText} from '../../src/cli/input.ts';

test('repeatable --set retains every field, boolean flags preserve positionals', () => {
  const args = parseArgs(['--json', 'create', '--set', 'Priority=Major', '--set=Subsystem=Test']);
  assert.deepEqual(args._, ['create']);
  assert.equal(args.opts.json, true);
  assert.deepEqual(args.opts.set, ['Priority=Major', 'Subsystem=Test']);
  assert.deepEqual(pairs(Array.isArray(args.opts.set) ? args.opts.set : []), {Priority: 'Major', Subsystem: 'Test'});
});

test('malformed options and field names are rejected', () => {
  assert.throws(() => parseArgs(['create', '--role']), /needs a value/);
  assert.throws(() => parseArgs(['--jsoon']), /unknown option/);
  assert.throws(() => parseArgs(['--json=true']), /does not take/);
  assert.throws(() => parseArgs(['--role=Builder', '--role=Director']), /not repeatable/);
  assert.throws(() => pairs([' =value']), /expected Field=Value/);
});

test('--file reads contents rather than supplying the filename; stdin is explicit', () => {
  const read = (path: string | number) => (path === 0 ? 'stdin contents' : `contents of ${path}`);
  assert.equal(noteText([], '/tmp/note.md', read), 'contents of /tmp/note.md');
  assert.equal(noteText(['-'], undefined, read), 'stdin contents');
  assert.equal(longText({'description-file': '/tmp/text.md'}, 'description', read), 'contents of /tmp/text.md');
  assert.throws(() => noteText(['inline'], '/tmp/note.md', read), /choose/);
});

// YA-8 review L4: `--` ends option parsing, so later words are positional even when they look like options.
test('-- ends option parsing', () => {
  const args = parseArgs(['comment', 'PRJ-1', '--', '--json', '--role']);
  assert.deepEqual(args._, ['comment', 'PRJ-1', '--json', '--role']);
  assert.deepEqual(args.opts, {});
});
