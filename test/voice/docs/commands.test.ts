/**
 * The voice command guide agrees with the code (YA-32). docs/voice/commands.md is written for people, so these tests
 * read it the way its conventions say it is written:
 *
 * - A phrase in double quotes is something to say. It must parse, through the core grammar and one of the catalogue's
 *   own samples (so Alexa's model has it too), to an intent named by the nearest `<!-- intent: ... -->` tag above it
 *   under the same heading. "Alexa, open issue desk" is the one launch phrase.
 * - A block quote line is something the skill says. It must be a line some transcript expects, or one of the Alexa
 *   adapter's own sentences.
 * - Intents of a later stage, and the issues that will build them, appear only under "Coming later".
 * - The block between the generated markers is exactly what the generator writes today.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {MESSAGES} from '../../../src/voice/alexa/messages.ts';
import {buildInteractionModel} from '../../../src/voice/alexa/model.ts';
import {parseUtterance} from '../../../src/voice/core/grammar.ts';
import {INTENT_CATALOGUE} from '../../../src/voice/core/intents.ts';
import type {IntentSpec} from '../../../src/voice/core/types.ts';
import {
  builtIntents,
  COMMANDS_DOC_PATH,
  extractGeneratedBlock,
  GENERATED_BEGIN,
  GENERATED_END,
  GUIDE_INVOCATION_NAME,
  renderGeneratedBlock,
  replaceGeneratedBlock,
} from '../../../src/voice/docs/generate-commands.ts';
import {runTranscript, TRANSCRIPTS_DIR} from '../core/transcript-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE_TRANSCRIPTS_DIR = join(HERE, 'transcripts');
const COMING_LATER = 'Coming later';
/** The issues that will build what the guide may only list as coming later. */
const UNBUILT_ISSUES = ['YA-17', 'YA-18', 'YA-28', 'YA-30', 'YA-31'];

interface Located {
  text: string;
  line: number;
  /** The level-2 heading the line sits under, or '' before the first. */
  section: string;
  generated: boolean;
}

interface QuotedPhrase extends Located {
  tags: readonly string[];
}

interface IntentTag extends Located {
  intents: readonly string[];
}

interface ScannedGuide {
  phrases: QuotedPhrase[];
  replies: Located[];
  tags: IntentTag[];
  /** Every line outside code, comments and tags, for checks on the prose itself. */
  prose: Located[];
}

const TAG = /^<!-- intent: ([A-Za-z]+(?: [A-Za-z]+)*) -->$/;

/** Reads a guide by its conventions. Pure, so a broken guide can be tested as a string. */
function scanGuide(document: string): ScannedGuide {
  const scanned: ScannedGuide = {phrases: [], replies: [], tags: [], prose: []};
  let section = '';
  let tags: readonly string[] = [];
  let inFence = false;
  let inComment = false;
  let generated = false;

  document.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === GENERATED_BEGIN) generated = true;
    if (trimmed === GENERATED_END) generated = false;
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const tag = TAG.exec(trimmed);
    if (tag) {
      tags = tag[1].split(' ');
      scanned.tags.push({text: trimmed, line, section, generated, intents: tags});
      return;
    }
    if (inComment || trimmed.startsWith('<!--')) {
      inComment = !trimmed.includes('-->');
      return;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(trimmed);
    if (heading) {
      tags = [];
      if (heading[1].length <= 2) section = heading[2];
    }
    const located = {line, section, generated};
    const quote = /^> ?(.*)$/.exec(trimmed);
    if (quote) {
      if (quote[1] !== '') scanned.replies.push({...located, text: quote[1]});
      scanned.prose.push({...located, text: trimmed});
      return;
    }
    scanned.prose.push({...located, text: trimmed});
    const withoutCode = trimmed.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/"([^"]*)"/g)) {
      scanned.phrases.push({...located, text: match[1], tags});
    }
  });
  return scanned;
}

const catalogueByName = new Map<string, IntentSpec>(INTENT_CATALOGUE.map((intent) => [intent.name, intent]));

/** What is wrong with one quoted phrase, or null. */
function phraseProblem(phrase: QuotedPhrase): string | null {
  const where = `line ${phrase.line} "${phrase.text}"`;
  let said = phrase.text;
  const wake = /^Alexa, (.*)$/.exec(said);
  if (wake) {
    if (wake[1] === `open ${GUIDE_INVOCATION_NAME}`) return null;
    said = wake[1];
  }
  // A one-shot request ("Alexa, ask issue desk for my issues"): the words after the invocation name are the command.
  if (said === `ask ${GUIDE_INVOCATION_NAME}`) return null;
  const oneShot = new RegExp(`^ask ${GUIDE_INVOCATION_NAME} (?:for |to )?(.+)$`).exec(said);
  if (oneShot) said = oneShot[1];
  if (phrase.tags.length === 0) return `${where}: a quoted phrase with no intent tag under its heading`;
  const parsed = parseUtterance(said);
  if (!parsed.matched) return `${where}: the grammar does not understand it`;
  if (!phrase.tags.includes(parsed.intent)) {
    return `${where}: parses to ${parsed.intent}, but the section claims ${phrase.tags.join(' or ')}`;
  }
  if (!catalogueByName.get(parsed.intent)?.samples.includes(parsed.sample)) {
    return `${where}: understood only by the text grammar (sample "${parsed.sample}"), not by the Alexa model`;
  }
  return null;
}

function problemsIn(document: string): string[] {
  const problems: string[] = [];
  for (const phrase of scanGuide(document).phrases) {
    const problem = phraseProblem(phrase);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

function flattenMessages(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenMessages);
  if (typeof value === 'object' && value !== null) {
    return 'text' in value && typeof value.text === 'string'
      ? [value.text]
      : Object.values(value).flatMap(flattenMessages);
  }
  return [];
}

function transcriptFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.txt'))
    .sort()
    .map((file) => join(directory, file));
}

/** Every line a transcript expects the skill to say, and every reprompt one asserts. */
function spokenLines(files: readonly string[]): Set<string> {
  const lines = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const said = /^< (.*)$/.exec(line) ?? /^@assert reprompt (.*)$/.exec(line);
      if (said && said[1] !== '...' && !said[1].startsWith('[earcon')) lines.add(said[1].trim());
    }
  }
  return lines;
}

const guide = readFileSync(COMMANDS_DOC_PATH, 'utf8');
const scanned = scanGuide(guide);
const built = builtIntents();

test('the guide has phrases, replies and tags to check', () => {
  assert.ok(scanned.phrases.length >= 100, `only ${scanned.phrases.length} quoted phrases found`);
  assert.ok(scanned.replies.length >= 40, `only ${scanned.replies.length} quoted reply lines found`);
  assert.ok(scanned.tags.length >= built.length * 2, `only ${scanned.tags.length} intent tags found`);
});

test('every phrase in double quotes parses, through a catalogue sample, to the intent its section claims', () => {
  assert.deepEqual(problemsIn(guide), []);
});

test('every intent tag names a real intent, and outside Coming later only one that is built', () => {
  const builtNames = new Set<string>(built.map((intent) => intent.name));
  const problems: string[] = [];
  for (const tag of scanned.tags) {
    for (const intent of tag.intents) {
      if (!catalogueByName.has(intent)) problems.push(`line ${tag.line}: ${intent} is not an intent`);
      else if (tag.section !== COMING_LATER && !builtNames.has(intent)) {
        problems.push(`line ${tag.line}: ${intent} is not built yet, so it belongs under ${COMING_LATER}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every built intent has a hand-written section with a phrase for it, and a generated list', () => {
  for (const intent of built) {
    const handWritten = scanned.phrases.filter((phrase) => {
      const parsed = parseUtterance(phrase.text);
      return !phrase.generated && phrase.tags.includes(intent.name) && parsed.matched && parsed.intent === intent.name;
    });
    assert.ok(handWritten.length > 0, `no hand-written phrase for ${intent.name}`);
    const ownSection = scanned.tags.some(
      (tag) => !tag.generated && tag.intents.length === 1 && tag.intents[0] === intent.name,
    );
    assert.ok(ownSection, `no hand-written section tagged for ${intent.name} alone`);
    assert.ok(
      scanned.tags.some((tag) => tag.generated && tag.intents[0] === intent.name),
      `no generated list for ${intent.name}`,
    );
  }
});

test('the generated block matches a fresh generation from the catalogue', () => {
  const block = extractGeneratedBlock(guide);
  assert.notEqual(block, null, 'the guide has no generated block');
  assert.equal(block, renderGeneratedBlock(), 'run: node src/voice/docs/generate-commands.ts');
});

test('a catalogue change without regenerating is caught', () => {
  const changed: IntentSpec[] = INTENT_CATALOGUE.map((intent) =>
    intent.name === 'where' ? {...intent, samples: [...intent.samples, 'where on earth am i']} : intent,
  );
  assert.notEqual(renderGeneratedBlock(changed), extractGeneratedBlock(guide));
  const promoted: IntentSpec[] = INTENT_CATALOGUE.map((intent) =>
    intent.name === 'comment' ? {...intent, stage: 1} : intent,
  );
  assert.throws(() => renderGeneratedBlock(promoted), /comment is built but has no title/);
});

test('the generated block can only be replaced whole', () => {
  const document = `intro\n${GENERATED_BEGIN}\nold\n${GENERATED_END}\noutro\n`;
  assert.equal(replaceGeneratedBlock(document, 'new'), 'intro\nnew\noutro\n');
  assert.throws(() => replaceGeneratedBlock('no markers', 'new'), /exactly one/);
  assert.throws(() => replaceGeneratedBlock(`${GENERATED_END}\n${GENERATED_BEGIN}`, 'new'), /exactly one/);
  assert.throws(() => replaceGeneratedBlock(`${document}${document}`, 'new'), /exactly one/);
});

test('unbuilt work is named only under Coming later, and every piece of it is named there', () => {
  const problems: string[] = [];
  for (const line of scanned.prose) {
    for (const issue of UNBUILT_ISSUES) {
      if (new RegExp(`\\b${issue}\\b`).test(line.text) && line.section !== COMING_LATER) {
        problems.push(`line ${line.line}: ${issue} outside ${COMING_LATER}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  const later = scanned.prose.filter((line) => line.section === COMING_LATER).map((line) => line.text);
  for (const issue of UNBUILT_ISSUES) {
    assert.ok(
      later.some((text) => text.includes(issue)),
      `${issue} is not listed under ${COMING_LATER}`,
    );
  }
});

test('the checks catch a phrase under the wrong intent, an untagged phrase, and a text-only phrasing', () => {
  assert.deepEqual(problemsIn('## A\n\n<!-- intent: list -->\n\n- "my issues"\n'), []);
  assert.match(problemsIn('## A\n\n<!-- intent: list -->\n\n- "open two"\n').join(), /parses to open/);
  assert.match(problemsIn('## A\n\n<!-- intent: list -->\n\n### B\n\n- "my issues"\n').join(), /no intent tag/);
  assert.match(problemsIn('## A\n\n<!-- intent: openById -->\n\n- "YA-13"\n').join(), /only by the text grammar/);
  assert.match(problemsIn('## A\n\n<!-- intent: stop -->\n\n- "wibble wobble"\n').join(), /does not understand/);
  assert.deepEqual(problemsIn('## A\n\nSay "Alexa, open issue desk".\n'), []);
  assert.match(problemsIn('## A\n\nSay "Alexa, open my tracker".\n').join(), /no intent tag/);
  assert.deepEqual(problemsIn('## A\n\n<!-- intent: list -->\n\nSay "Alexa, ask issue desk for my issues".\n'), []);
  assert.match(
    problemsIn('## A\n\n<!-- intent: open -->\n\nSay "Alexa, ask issue desk for my issues".\n').join(),
    /claims open/,
  );
  assert.deepEqual(problemsIn('## A\n\n```sh\necho "not a phrase"\n```\n\n`"code"` too\n'), []);
  const later = scanGuide('## Coming later\n\n<!-- intent: comment -->\n\n## Next\n\nYA-17\n');
  assert.deepEqual(
    later.tags.map((tag) => tag.section),
    [COMING_LATER],
  );
  assert.equal(later.prose.find((line) => line.text === 'YA-17')?.section, 'Next');
});

test('the guide transcripts pass', async () => {
  const files = transcriptFiles(GUIDE_TRANSCRIPTS_DIR);
  assert.ok(files.length > 0, 'no guide transcript');
  for (const file of files) {
    const result = await runTranscript(readFileSync(file, 'utf8'), file);
    assert.deepEqual(result.failures, []);
  }
});

test('every quoted reply is a line the skill really says', () => {
  const known = spokenLines([...transcriptFiles(TRANSCRIPTS_DIR), ...transcriptFiles(GUIDE_TRANSCRIPTS_DIR)]);
  for (const text of flattenMessages(MESSAGES)) known.add(text);
  const unknown = scanned.replies
    .filter((reply) => !known.has(reply.text))
    .map((reply) => `line ${reply.line}: ${reply.text}`);
  assert.deepEqual(unknown, []);
});

test('the invocation name in the guide is one the model generator accepts', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, {invocationName: GUIDE_INVOCATION_NAME});
  assert.equal(model.interactionModel.languageModel.invocationName, GUIDE_INVOCATION_NAME);
  assert.ok(scanned.phrases.some((phrase) => phrase.text === `Alexa, open ${GUIDE_INVOCATION_NAME}`));
});

test('the guide keeps to what a screen reader reads well', () => {
  const problems: string[] = [];
  for (const line of scanned.prose) {
    if (/^\|/.test(line.text)) problems.push(`line ${line.line}: a table`);
    if (/!\[/.test(line.text)) problems.push(`line ${line.line}: an image`);
    if (/\p{Extended_Pictographic}/u.test(line.text)) problems.push(`line ${line.line}: an emoji`);
    if (/[“”]/.test(line.text)) problems.push(`line ${line.line}: curly double quotes, which the checks do not read`);
    if (/see the (image|picture|screenshot)/i.test(line.text)) problems.push(`line ${line.line}: refers to a picture`);
  }
  assert.deepEqual(problems, []);
  assert.match(guide, /^# /, 'the guide starts with a heading');
});
