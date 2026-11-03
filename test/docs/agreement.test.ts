// AGENTS.md is copied into, and obeyed by, agents in other repositories, so a command example the CLI refuses is a
// defect the owner meets on every milestone (YA-8 review A2/A7, T2). These tests hold the documents to the code.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {parseArgs} from '../../src/cli/args.ts';
import {HELP} from '../../src/cli/help.ts';
import {run} from '../../src/cli/run.ts';
import type {CliDependencies} from '../../src/cli/run.ts';
import {assertAccountingSupported} from '../../src/accounting/actuals.ts';
import {createTrackerAdapter} from '../../src/youtrack/adapter.ts';
import {finishIssue, takeIssue} from '../../src/workflow/operations.ts';
import {ROLES} from '../../src/workflow/policy.ts';
import {createClient, loadConfig} from '../../client.ts';
import {fixture} from '../workflow/fake.ts';

const EXAMPLE_DOCUMENTS = ['AGENTS.md', 'README.md', 'ADOPTING.md', 'templates/AGENTS-section.md'];
const WORDING_DOCUMENTS = [...EXAMPLE_DOCUMENTS, 'docs/architecture/overview.md'];

function readDocument(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

interface Example {
  document: string;
  text: string;
}

/**
 * `yt ...` commands in fenced blocks (one per line, indented fences included) and in inline code spans, which may
 * wrap across lines. A fence left in the prose would pair its backticks with the spans after it.
 */
function commandExamples(document: string): Example[] {
  const examples: Example[] = [];
  const command = /^(?:node \S*yt\.ts|yt)\s+(\S.*)$/;
  const prose = readDocument(document).replace(
    /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm,
    (_block, body: string) => {
      for (const line of body.split('\n')) {
        const match = command.exec(line.replace(/\s+#\s.*$/, '').trim());
        if (match) examples.push({document, text: `yt ${match[1]}`});
      }
      return '';
    },
  );
  for (const span of prose.matchAll(/`([^`]+)`/g)) {
    const match = command.exec(span[1].replace(/\s+/g, ' ').trim());
    if (match) examples.push({document, text: `yt ${match[1]}`});
  }
  return examples;
}

/** Shell words after `yt`. Quotes group; unquoted `[` and `]` mark optional parts in synopses and are dropped. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  for (const character of text.slice('yt '.length)) {
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (character !== '[' && character !== ']') {
      word += character;
      started = true;
    }
  }
  assert.equal(quote, '', `unbalanced quote in: ${text}`);
  if (started) words.push(word);
  return words;
}

/**
 * Parse an example with the CLI's own option schema. Prose often names a value option at the end of a span
 * (`yt cmd --comment`); that is a mention, not a malformed call, so it is given a placeholder value.
 */
function parseExample(example: Example): string[] {
  const words = shellWords(example.text);
  try {
    parseArgs(words);
    return words;
  } catch (error) {
    const last = words.at(-1) ?? '';
    if (!(error instanceof Error) || !/needs a value/.test(error.message) || !last.startsWith('--')) throw error;
    parseArgs([...words, 'value']);
    return [...words, 'value'];
  }
}

const config = loadConfig(
  {},
  {
    environment: {
      YOUTRACK_URL: 'https://example.invalid',
      YOUTRACK_TOKEN: 'synthetic-test-token',
      YOUTRACK_PROJECT: 'PRJ',
      YOUTRACK_OWNER: 'configured-owner',
      AI_MODEL: 'test-model',
      AI_SESSION_ID: 'test-session',
    },
    files: [],
  },
);

/** In-process CLI with a fake tracker and a provider client that can never reach a network. */
function offlineCli() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const state = fixture();
  const dependencies: CliDependencies = {
    loadConfig: () => config,
    tracker: state.tracker,
    readText: () => 'text from a file',
    createClient: (identity, options) =>
      createClient(identity, {
        ...options,
        fetch: async () => {
          throw new Error('offline: documentation tests never reach a tracker');
        },
      }),
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
  };
  return {dependencies, stdout, stderr, state};
}

function refusalMessage(): string {
  try {
    assertAccountingSupported({tokens: 1}, {atomicAccounting: false});
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('token actuals are no longer refused; revisit the documentation checks');
}

const examples = EXAMPLE_DOCUMENTS.flatMap(commandExamples);

test('the documents carry command examples to check', () => {
  for (const document of ['AGENTS.md', 'README.md']) {
    assert.ok(examples.filter((example) => example.document === document).length >= 10, document);
  }
});

test('every documented yt example parses with the CLI schema and names a command the CLI dispatches', async () => {
  const known = new Map<string, boolean>();
  for (const example of examples) {
    let words: string[];
    try {
      words = parseExample(example);
    } catch (error) {
      assert.fail(`${example.document}: \`${example.text}\` does not parse: ${(error as Error).message}`);
    }
    const command = words.find((word) => !word.startsWith('--')) ?? 'help';
    if (!known.has(command)) {
      // An unknown command is the only way run() exits 2; every known one fails on its missing arguments instead.
      known.set(command, (await run([command, '--quiet'], offlineCli().dependencies)) !== 2);
    }
    assert.ok(known.get(command), `${example.document}: \`${example.text}\` uses unknown command "${command}"`);
  }
});

test('no documented example is refused by the CLI', async () => {
  const refusal = refusalMessage();
  const adapter = createTrackerAdapter(createClient({model: 'test', session: 'test'}, {config}));
  for (const example of examples) {
    const words = parseExample(example);
    if (!adapter.capabilities.atomicAccounting && words[0] === 'actual') {
      assert.ok(!words.includes('--tokens'), `${example.document}: \`${example.text}\` logs refused token actuals`);
    }
    const cli = offlineCli();
    await run([...words, '--quiet'], cli.dependencies);
    const output = [...cli.stdout, ...cli.stderr].join('');
    assert.ok(!output.includes(refusal), `${example.document}: \`${example.text}\` is refused: ${output}`);
  }
});

test('ADOPTING.md lists exactly the canonical Role values', () => {
  const match = /`yt field add 'Role' --values '([^']+)'`/.exec(readDocument('ADOPTING.md'));
  assert.ok(match, 'ADOPTING.md no longer shows the Role field command');
  assert.deepEqual(match[1].split(','), [...ROLES]);
});

test('Fixed is described as a hand-off, never as merged, deployed or a machine state', () => {
  for (const document of WORDING_DOCUMENTS) {
    const text = readDocument(document).replace(/\s+/g, ' ');
    for (const phrase of [/merged and deployed/i, /machine state/i]) {
      assert.doesNotMatch(text, phrase, document);
    }
  }
});

// The Judge's canonical pending-step wording; stream A's workflow must report exactly this with the board filled in.
const BETWEEN_SPRINTS_STEP = 'place in <board>: no current sprint';

test('AGENTS.md and overview.md document the between-sprints pending step', () => {
  for (const document of ['AGENTS.md', 'docs/architecture/overview.md']) {
    assert.ok(readDocument(document).includes(`\`${BETWEEN_SPRINTS_STEP}\``), document);
  }
});

test('the CLI agrees with the documented Fixed reminder and the help synopsis', async (t) => {
  await t.test('state Fixed without --check prints the documented reminder', async () => {
    const agents = readDocument('AGENTS.md').replace(/\s+/g, ' ');
    assert.match(
      agents,
      /`yt state \.\.\. Fixed` without `--check` prints a reminder on stderr \(not with `--quiet` or `--json`\)/,
    );
    const human = offlineCli();
    await run(['state', 'PRJ-1', 'Fixed'], human.dependencies);
    assert.match(human.stderr.join(''), /reminder: Fixed without --check/);
    assert.equal(human.state.issue.workflow.assignee, 'configured-owner');
    assert.equal(human.state.issue.workflow.role, 'Owner verifies');
    for (const flag of ['--quiet', '--json']) {
      const silent = offlineCli();
      await run(['state', 'PRJ-1', 'Fixed', flag], silent.dependencies);
      assert.doesNotMatch(silent.stderr.join(''), /reminder/, flag);
    }
    const checked = offlineCli();
    await run(['state', 'PRJ-1', 'Fixed', '--check', 'open the page'], checked.dependencies);
    assert.doesNotMatch(checked.stderr.join(''), /reminder/, '--check');
  });

  await t.test('help shows no refused actual flag', () => {
    const lines = HELP.split('\n');
    const start = lines.findIndex((line) => /^\s+yt actual\b/.test(line));
    assert.ok(start >= 0, 'help has no actual synopsis');
    const end = lines.findIndex((line, index) => index > start && /^\s+yt \w/.test(line));
    const synopsis = lines.slice(start, end < 0 ? undefined : end).join('\n');
    assert.doesNotMatch(synopsis, /--tokens/);
    assert.doesNotMatch(synopsis, /stored as millions/);
  });
});

test('between sprints the workflow reports the pending step AGENTS.md documents', async (t) => {
  await t.test('take and state Fixed owe the placement by name', async () => {
    // Assigned rather than written as a literal so this compiles before stream A adds withoutCurrent to the port.
    const discovery = {targets: [], unavailable: [], withoutCurrent: ['Board']};
    for (const operation of ['take', 'state'] as const) {
      const {context, tracker} = fixture();
      tracker.discoverIterations = async () => discovery;
      const result =
        operation === 'take'
          ? await takeIssue(context, 'PRJ-1')
          : await finishIssue(context, 'PRJ-1', {state: 'Fixed', check: 'x'});
      assert.equal(result.status, 'partial', operation);
      assert.deepEqual(result.pending, [BETWEEN_SPRINTS_STEP.replace('<board>', 'Board')], operation);
      assert.deepEqual(result.uncertain, [], operation);
    }
  });
});

// YA-25 B5: the owner decided closed states are placed on the current sprint; AGENTS.md must say what the code does.
test('AGENTS.md says closing an issue places it on the current sprint, as the workflow does', async () => {
  const sprints = readDocument('AGENTS.md').split('## Sprints')[1]?.split('\n## ')[0]?.replace(/\s+/g, ' ') ?? '';
  const closing = /\*\*Closing counts too:\*\*[^*]*/.exec(sprints)?.[0] ?? '';
  for (const state of ['Verified', "Won't fix", 'Duplicate', 'Obsolete']) {
    assert.ok(closing.includes(state), `AGENTS.md "Sprints" does not say ${state} is placed`);
    const {context, writes} = fixture();
    await finishIssue(context, 'PRJ-1', {state});
    assert.deepEqual(writes, ['update', 'place'], state);
  }
  assert.match(closing, /current sprint/);
});

// YA-8 NF3: the failure message and its classification are part of the documented contract.
test('overview.md documents the failure message the CLI prints and the issue snapshot label', async () => {
  const overview = readDocument('docs/architecture/overview.md').replace(/\s+/g, ' ');
  const output: string[] = [];
  const posts: string[] = [];
  await run(['subsystems', 'add', 'Radar', '--json'], {
    loadConfig: () => config,
    stdout: (text) => {
      output.push(text);
    },
    createClient: (identity, options) =>
      createClient(identity, {
        ...options,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const post = (init?.method ?? 'GET') !== 'GET';
          if (post) posts.push(path);
          if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
          if (path.endsWith('/customFields')) {
            return Response.json([
              {
                id: 'f',
                canBeEmpty: true,
                field: {name: 'Subsystem', fieldType: {id: 'ownedField[1]'}},
                bundle: {id: 'b'},
              },
            ]);
          }
          if (path.includes('/swimlaneSettings/')) return new Response('', {status: 503});
          if (path.endsWith('/values')) return post ? Response.json({id: 'v'}) : Response.json([]);
          if (path.endsWith('/agiles'))
            return Response.json([{id: 'a', name: 'Board', projects: [{shortName: 'PRJ'}]}]);
          return new Response('', {status: 503});
        },
      }),
  });
  const envelope = JSON.parse(output.join(''));
  assert.equal(envelope.status, 'unknown');
  assert.equal(posts.length, 2);
  assert.ok(overview.includes(`\`${envelope.message}\``), `overview.md does not show: ${envelope.message}`);
  for (const phrase of [
    '`message`',
    '`applied`, `pending` and `uncertain` step arrays',
    'never as confirmed',
    '`issueSnapshot`',
  ]) {
    assert.ok(overview.includes(phrase), `overview.md does not mention ${phrase}`);
  }
  const agents = readDocument('AGENTS.md').replace(/\s+/g, ' ');
  assert.match(agents, /fails after a write reports `partial` or `unknown` rather than `rejected`/);
});

// YA-25 B4: AGENTS.md quotes whoami's default-owner line; it must be what whoami prints.
test('AGENTS.md quotes the whoami line for an unconfigured owner', async () => {
  const agents = readDocument('AGENTS.md').replace(/\s+/g, ' ');
  const quoted = /`yt whoami` shows `(owner: [^`]+)`/.exec(agents)?.[1];
  assert.ok(quoted, 'AGENTS.md no longer quotes the whoami owner line');
  const output: string[] = [];
  const unconfigured = loadConfig(
    {},
    {environment: {YOUTRACK_URL: 'https://example.invalid', YOUTRACK_TOKEN: 't', YOUTRACK_PROJECT: 'PRJ'}, files: []},
  );
  await run(['whoami', '--quiet'], {
    loadConfig: () => unconfigured,
    stdout: (text) => {
      output.push(text);
    },
    createClient: (identity, options) =>
      createClient(identity, {
        ...options,
        fetch: async () => Response.json({id: '1', login: 'agent', fullName: 'Agent', email: null}),
      }),
  });
  assert.ok(output.join('').split('\n').includes(quoted), `whoami printed:\n${output.join('')}`);
});
