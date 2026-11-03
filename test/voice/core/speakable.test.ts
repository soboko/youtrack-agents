import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  asSentence,
  MAX_NAME_CHARS,
  nameForSpeech,
  speakableBlocks,
  speakablePersonName,
  speakableInline,
  speakableSegments,
  splitForSpeech,
} from '../../../src/voice/core/speakable.ts';

test('links become their text, bare URLs and autolinks become "a link"', () => {
  assert.equal(speakableInline('See [the notes](https://wiki.example/notes).'), 'See the notes.');
  assert.equal(speakableInline('See [the notes][1].'), 'See the notes.');
  assert.equal(
    speakableInline('Download from https://example.com/x?y=1, then run it.'),
    'Download from a link, then run it.',
  );
  assert.equal(speakableInline('Mirror at <https://mirror.example/>.'), 'Mirror at a link.');
  assert.equal(speakableInline('Or www.example.com.'), 'Or a link.');
  assert.equal(speakableInline('[https://example.com](https://example.com)'), 'a link');
});

test('images become "an image", with alt text when there is some', () => {
  assert.equal(speakableInline('![Wiring diagram](d.png)'), 'an image: Wiring diagram');
  assert.equal(speakableInline('![](d.png)'), 'an image');
});

test('code spans lose their backticks; emphasis, strikethrough and escapes lose their markers', () => {
  assert.equal(speakableInline('Run `npm test` now'), 'Run npm test now');
  assert.equal(
    speakableInline('This is **very** _really_ *quite* ~~not~~ important'),
    'This is very really quite not important',
  );
  assert.equal(speakableInline('Keep snake_case_names and 5 * 3 alone'), 'Keep snake_case_names and 5 * 3 alone');
  assert.equal(speakableInline('A literal \\*star\\*'), 'A literal *star*');
});

test('issue ids become "an issue"; look-alike names do not', () => {
  assert.equal(speakableInline('Blocked by YA-8 and MM-357.'), 'Blocked by an issue and an issue.');
  assert.equal(speakableInline('Save as UTF-8 per ISO-8601.'), 'Save as UTF-8 per ISO-8601.');
  assert.equal(speakableInline('Policy HX-7730291-B.'), 'Policy HX-7730291-B.');
});

test('mentions and HTML', () => {
  assert.equal(speakableInline('Thanks @sam.'), 'Thanks sam.');
  assert.equal(speakableInline('One<br>two <b>three</b> &amp; four'), 'One two three & four');
});

test('blocks: paragraphs, headings joined to the next paragraph, tables, code blocks, lists', () => {
  const markdown = [
    '# Plan',
    'First we measure.',
    'Then we decide.',
    '',
    '| Name | Size |',
    '| --- | ---: |',
    '| a | 1 |',
    '| b | 2 |',
    '',
    '```ts',
    'const x = `nope`;',
    '```',
    '',
    '- [ ] one thing',
    '- [x] **another** thing',
    '  continued',
    '',
    '---',
    '',
    '> Quoted words',
    '',
    '[1]: https://example.com',
    '## Trailing heading',
  ].join('\n');
  assert.deepEqual(speakableBlocks(markdown), [
    'Plan. First we measure. Then we decide.',
    'A table of 2 rows.',
    'A code block.',
    'A list of 2 items. one thing. another thing continued.',
    'Quoted words.',
    'Trailing heading.',
  ]);
});

test('a table with one data row, and a table without a header separator', () => {
  assert.deepEqual(speakableBlocks('| a |\n| --- |\n| 1 |'), ['A table of 1 row.']);
  assert.deepEqual(speakableBlocks('| a | b |\n| c | d |'), ['A table of 2 rows.']);
});

test('a fence with no closing fence, or with backticks after it, never swallows the rest', () => {
  assert.deepEqual(
    speakableBlocks('Intro\n\n```\nsecret stuff\n\nNo closing fence\n\nImportant paragraph that must be read.'),
    ['Intro.', 'secret stuff.', 'No closing fence.', 'Important paragraph that must be read.'],
  );
  assert.deepEqual(speakableBlocks('```npm install``` is the first step.\n\nSecond paragraph.'), [
    'npm install is the first step.',
    'Second paragraph.',
  ]);
  assert.deepEqual(speakableBlocks('Steps:\n~~~ is how we mark ranges\n\nImportant last paragraph.'), [
    'Steps: is how we mark ranges.',
    'Important last paragraph.',
  ]);
  assert.deepEqual(speakableBlocks('A\n\n````ts\ncode\n```\nstill code\n````\n\nB'), ['A.', 'A code block.', 'B.']);
});

test('secrets: real token shapes become "a long code"; ordinary words, dates, paths and versions do not', () => {
  const secrets: Array<[string, string]> = [
    ['Token perm:c2FtLndvcmtz.NTctMQ==.aGVsbG8 here', 'Token a long code here'],
    ['Use ghp_16C7e42F292c6912E7710c838347Ae178B4a.', 'Use a long code.'],
    ['Old github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'Old a long code'],
    ['In backticks `sk-abcdefghijklmnop1234`', 'In backticks a long code'],
    ['Key AKIAIOSFODNN7EXAMPLE', 'Key a long code'],
    ['Hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b, then', 'Hash a long code, then'],
    ['JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N ok', 'JWT a long code ok'],
    ['base64 c2VjcmV0LXZhbHVlLXRoYXQtaXMtbG9uZw==', 'base64 a long code'],
    ['Slack xoxb-123456789012-abcdefABCDEF', 'Slack a long code'],
    ['random Xy7Kp2Lm9Qz4Rt8Vw', 'random a long code'],
    ['heroku key 3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f', 'heroku key a long code'],
    ['uuid 123e4567-e89b-12d3-a456-426614174000 in prose', 'uuid a long code in prose'],
    ['token abcd1234efgh5678ijkl9012mnop34', 'token a long code'],
    ['api_key=abc123def456ghi789jkl0mn', 'api key: a long code'],
    ['password=Summer2026!', 'password: a long code'],
    ['secret: hunter22', 'secret: a long code'],
    ['set ACCESS_TOKEN="abcDEF12345".', 'set ACCESS TOKEN: a long code.'],
    ['Authorization: Bearer abc.def-ghi_jklmnop', 'Authorization: bearer a long code'],
    ['curl -H "Authorization: Bearer 0123456789abcdef"', 'curl -H "Authorization: bearer a long code"'],
  ];
  const ordinary = [
    'We need internationalisation-friendly, well-thought-through-and-tested copy for state-of-the-art-kitchen',
    'Deploy at 2026-09-12T10:00:00Z, build 1.2.3-beta.4+build.2026',
    'Edit src/voice/core/converse_helpers and the working_set_ttl_ms_setting',
    'Email chris.coulter2@example.com or robin@example.com',
    'Meeting in the ASIA-Pacific region about sk-learn-pipeline',
    'The internationalisation work',
    'Asia and Africa',
    'Serial 12345678901234567890',
    'Model XJ220 and iPhone15 and covid19',
    'The key is in the drawer, and the hotkey: ctrl.',
    'the monkey=business test',
    'internationalisation2026 plans',
  ];
  for (const [text, expected] of secrets) assert.equal(speakableInline(text), expected, text);
  for (const text of ordinary) assert.equal(speakableInline(text), text, text);
});

test('empty and null descriptions have no blocks', () => {
  assert.deepEqual(speakableBlocks(null), []);
  assert.deepEqual(speakableBlocks('  \n\n  '), []);
});

test('no speakable block ever carries markdown syntax', () => {
  const markdown = '## H\n\n`a` **b** [c](http://d) |e| ![f](g)\n\n* item `x`\n\n| t |\n|---|\n| u |';
  for (const block of speakableBlocks(markdown)) {
    assert.doesNotMatch(block, /[`|]|\*\*|\]\(|:\/\/|^#/, block);
  }
});

test('segments are one per paragraph with a long pause', () => {
  assert.deepEqual(speakableSegments('One.\n\nTwo.'), [
    {text: 'One.', pauseAfter: 'long'},
    {text: 'Two.', pauseAfter: 'long'},
  ]);
});

test('splitting prefers sentence ends, then words, and never exceeds the limit', () => {
  const text = 'Short one. This second sentence is somewhat longer than the first. Third.';
  const pieces = splitForSpeech(text, 40);
  assert.deepEqual(pieces, ['Short one.', 'This second sentence is somewhat longer', 'than the first. Third.']);
  for (const piece of pieces) assert.ok(piece.length <= 40);
  assert.deepEqual(splitForSpeech('short', 40), ['short']);
  assert.ok(splitForSpeech('x'.repeat(100), 30).every((piece) => piece.length <= 30));
});

test('asSentence ends text with punctuation once', () => {
  assert.equal(asSentence('Hello'), 'Hello.');
  assert.equal(asSentence('Hello:'), 'Hello.');
  assert.equal(asSentence('Hello?'), 'Hello?');
  assert.equal(asSentence('  '), '');
});

test('YA-35 F1: a person has no speakable name when it is empty, an email, or their login in any case', () => {
  assert.equal(speakablePersonName('ccoulter', 'ccoulter'), null);
  assert.equal(speakablePersonName('CCoulter', ' ccoulter '), null);
  assert.equal(speakablePersonName('mary smith', 'Mary Smith'), null);
  assert.equal(speakablePersonName('jo', 'jo.bloggs@example.com'), null);
  assert.equal(speakablePersonName('jo', 'Jo <jo@example.com>'), null);
  assert.equal(speakablePersonName('sam', '   '), null);
  assert.equal(speakablePersonName('sam', null), null);
  assert.equal(speakablePersonName('sam', undefined), null);
  assert.equal(speakablePersonName('ccoulter', 'Chris  Coulter'), 'Chris Coulter');
  // Recheck R1: login- or email-shaped words, and the login as a word exactly as written.
  assert.equal(speakablePersonName('jbloggs', 'jo.bloggs'), null);
  assert.equal(speakablePersonName('pnair', 'pnair Priya'), null);
  assert.equal(speakablePersonName('jsmith', 'j_smith'), null);
  assert.equal(speakablePersonName('chrisx', 'chris2'), null);
  assert.equal(speakablePersonName('klee', 'Kim Lee kim.lee@example.com'), null);
  assert.equal(speakablePersonName('klee', 'Kim Lee (kim@example.com)'), null);
  for (const [login, name] of [
    ['mjones', 'Mary Jones'],
    ['jbloggs', 'Jo Bloggs'],
    ['amoneil', "Anne-Marie O'Neil"],
    ['mjj', 'Mary J. Jones'],
    ['dsmith', 'Dr. Dana Smith'],
    ['robin', 'Robin Hale'],
  ]) {
    assert.equal(speakablePersonName(login, name), name, name);
  }
  assert.equal(speakablePersonName(null, 'Zoë Ångström'), 'Zoë Ångström');
});

test('YA-35 F6: a spoken name is cut at a word boundary to the name limit', () => {
  const long = 'Bartholomew '.repeat(10).trim();
  const cut = nameForSpeech(long);
  assert.ok(cut.length <= MAX_NAME_CHARS, cut);
  assert.ok(long.startsWith(cut) && cut.endsWith('Bartholomew'), cut);
  assert.equal(speakablePersonName('bart', long), cut);
  assert.equal(nameForSpeech('Mary Jones'), 'Mary Jones');
});
