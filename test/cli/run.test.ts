import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from '../../src/cli/run.ts';
import {loadConfig, createClient} from '../../client.ts';
import {TrackerFailure} from '../../src/tracker.ts';
import {fixture} from '../workflow/fake.ts';
import {isolated, runNode} from './subprocess.ts';
import {HELP} from '../../src/cli/help.ts';

const reviewConfig = loadConfig(
  {baseUrl: 'https://tracker.example', project: 'YA', token: 'private-token'},
  {environment: {}, files: []},
);

function setup() {
  const state = fixture();
  const output: string[] = [];
  const errors: string[] = [];
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
  return {
    ...state,
    output,
    errors,
    config,
    dependencies: {
      loadConfig: () => config,
      tracker: state.tracker,
      stdout: (text: string) => {
        output.push(text);
      },
      stderr: (text: string) => {
        errors.push(text);
      },
    },
  };
}

test('run resolves configured identity before client and owner policy; repeat --set survives', async () => {
  const {dependencies, output, issue, config, tracker} = setup();
  let fields: unknown;
  const originalCreate = tracker.createIssue;
  tracker.createIssue = async (input) => {
    fields = input.extraFields;
    return originalCreate(input);
  };
  const code = await run(
    [
      'create',
      '--summary',
      'Decision',
      '--role',
      'Owner decides',
      '--recommend',
      'owner (no model)',
      '--set',
      'Subsystem=Test',
      '--set',
      'Priority=Major',
      '--json',
    ],
    {
      ...dependencies,
      createClient: (identity, options) => {
        assert.deepEqual(identity, {model: 'test-model', session: 'test-session'});
        assert.equal(options?.config, config);
        return createClient(identity, options);
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(fields, {Priority: 'Major'});
  assert.equal(issue.workflow.assignee, 'configured-owner');
  assert.equal(JSON.parse(output.join('')).version, 1);
});

test('handoff --file passes file contents to workflow', async () => {
  const {dependencies, writes} = setup();
  assert.equal(
    await run(['handoff', 'PRJ-1', 'Builder', '--file', 'notes.md'], {
      ...dependencies,
      readText: (path) => {
        assert.equal(path, 'notes.md');
        return 'Inspect the failing tests';
      },
    }),
    0,
  );
  assert.deepEqual(writes, ['update', 'comment:**Hand-off to Builder**\n\nInspect the failing tests']);
});

test('partial placement has nonzero exit and machine-readable pending steps', async () => {
  const {dependencies, tracker, output, errors} = setup();
  tracker.placeInIteration = async () => {
    throw new TrackerFailure('permission', 'denied');
  };
  assert.equal(await run(['take', 'PRJ-1', '--json'], dependencies), 1);
  const result = JSON.parse(output.join(''));
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.pending, ['place in Board: Sprint 1']);
  assert.deepEqual(errors, []);
});

test('failed read is rejected at CLI error boundary', async () => {
  const {dependencies, output} = setup();
  assert.equal(
    await run(['whoami', '--json'], {
      ...dependencies,
      createClient: (identity, options) =>
        createClient(identity, {
          ...options,
          fetch: async () => {
            throw new Error('lost reply');
          },
        }),
    }),
    1,
  );
  // whoami is a read, so its failure is unavailable/rejected rather than an uncertain write.
  assert.equal(JSON.parse(output.join('')).status, 'rejected');
});

const EXECUTABLE = fileURLToPath(new URL('../../yt.ts', import.meta.url));

test('subprocess help and argument failures do not need credentials or network', (t) => {
  const sandbox = isolated(t, {YOUTRACK_TOKEN: 'synthetic'});
  const help = runNode(sandbox, [EXECUTABLE, 'help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /yt: YouTrack for agents/);
  const bad = runNode(sandbox, [EXECUTABLE, 'create', '--role', '--json']);
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /--role needs a value/);
});

// YA-25 B12 (YA-8 C8.1): help shows the configured project's keys, from the environment, a flag or the env file.
test('subprocess help uses the configured project key without a token', (t) => {
  const fromEnvironment = runNode(isolated(t, {YOUTRACK_PROJECT: 'ABC'}), [EXECUTABLE, 'help']);
  assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
  assert.match(fromEnvironment.stdout, /^yt: YouTrack for agents \(project ABC\)/);
  assert.match(fromEnvironment.stdout, /yt show ABC-1 /);
  assert.doesNotMatch(fromEnvironment.stdout, /PRJ-/);

  const fromFlag = runNode(isolated(t, {YOUTRACK_PROJECT: 'ABC'}), [EXECUTABLE, 'help', '--project', 'XYZ']);
  assert.match(fromFlag.stdout, /yt take XYZ-1 /);

  const sandbox = isolated(t);
  const file = join(sandbox.home, 'env');
  writeFileSync(file, 'YOUTRACK_PROJECT=FILE\n');
  const fromFile = runNode({...sandbox, env: {...sandbox.env, YOUTRACK_ENV_FILE: file}}, [EXECUTABLE, '--help']);
  assert.match(fromFile.stdout, /yt show FILE-1 /);

  const none = runNode(isolated(t), [EXECUTABLE, 'help']);
  assert.match(none.stdout, /yt show PRJ-1 /);
});

// YA-25 Y8 (the security review's canary run, as a test): an `.env.youtrack` in an ancestor of the child's working
// directory holds a token, a loopback URL that refuses connections, and a project. The child must never read it.
test('subprocess config discovery never reaches an env file in an ancestor of its working directory', (t) => {
  const sandbox = isolated(t);
  writeFileSync(
    join(sandbox.home, '.env.youtrack'),
    'YOUTRACK_TOKEN=CANARY-ANCESTOR-TOKEN\nYOUTRACK_URL=http://127.0.0.1:9\nYOUTRACK_PROJECT=CANARY\n',
  );
  const whoami = runNode(sandbox, [EXECUTABLE, 'whoami', '--json']);
  assert.equal(whoami.status, 1);
  assert.match(JSON.parse(whoami.stdout).error, /no YouTrack token/);
  const help = runNode(sandbox, [EXECUTABLE, 'help']);
  assert.match(help.stdout, /yt show PRJ-1 /);
  assert.doesNotMatch(help.stdout + help.stderr, /CANARY/);
});

// YA-8 review T13: a child with no token must fail on configuration, never fall back to real credentials.
test('subprocess whoami with no token and a fake home fails before any network', (t) => {
  const result = runNode(isolated(t), [EXECUTABLE, 'whoami', '--json']);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /no YouTrack token/);
});

// This drives run() through a module subprocess rather than yt.ts, so a fake tracker can be injected; what it shares
// with the executable is real env-file discovery and ordering (YA-8 review T19).
test('run() in a subprocess takes the owner and identity from YOUTRACK_ENV_FILE', (t) => {
  const sandbox = isolated(t);
  const configPath = join(sandbox.home, '.env.youtrack');
  writeFileSync(
    configPath,
    'YOUTRACK_TOKEN=synthetic\nYOUTRACK_URL=https://example.invalid\nYOUTRACK_PROJECT=PRJ\nYOUTRACK_OWNER=file-owner\nAI_MODEL=file-model\n',
  );
  const runner = fileURLToPath(new URL('../../src/cli/run.ts', import.meta.url));
  const client = fileURLToPath(new URL('../../client.ts', import.meta.url));
  const fake = fileURLToPath(new URL('../workflow/fake.ts', import.meta.url));
  // This subprocess exercises actual env-file startup without exposing a real provider or credentials.
  const source = `import {run} from ${JSON.stringify(runner)};
import {createClient} from ${JSON.stringify(client)};
import {fixture} from ${JSON.stringify(fake)};
const f = fixture();
const code = await run(['create','--summary','Decision','--role','Owner decides','--recommend','owner (no model)','--subsystem','Test','--json'], {
tracker:f.tracker,
createClient:(identity,options)=>{if(identity.model!=='file-model') throw new Error('identity loaded too early');return createClient(identity,options);}
});
process.exitCode=code;`;
  const result = runNode({...sandbox, env: {...sandbox.env, YOUTRACK_ENV_FILE: configPath}}, [
    '--input-type=module',
    '-e',
    source,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).issue.workflow.assignee, 'file-owner');
});

test('native mutation unknown outcome is machine-readable and not retried', async () => {
  const {dependencies, output} = setup();
  let attempts = 0;
  const code = await run(['comment', 'PRJ-1', 'note', '--json'], {
    ...dependencies,
    createClient: (identity, options) => {
      const client = createClient(identity, options);
      client.addComment = async () => {
        attempts++;
        throw new TrackerFailure('unknown', 'reply lost');
      };
      return client;
    },
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(output.join('')).status, 'unknown');
  assert.equal(attempts, 1);
});

test('confirmed native mutations survive failed display refreshes without mutation retries', async () => {
  const cases = [
    {args: ['cmd', 'PRJ-1', 'State Fixed'], applied: 'execute native command', receipt: {issueKeys: ['PRJ-1']}},
    {
      args: ['sprint', 'add', 'PRJ-1', 'Sprint 1', '--board', 'Board'],
      applied: 'add to sprint',
      receipt: {issueKeys: ['PRJ-1'], board: 'Board', sprint: 'Sprint 1'},
    },
    {
      args: ['sprint', 'enable', '--board', 'Board'],
      applied: 'set sprints enabled',
      receipt: {board: 'Board', enabled: true},
    },
    {args: ['subsystems', 'add', 'Test'], applied: 'add subsystem', receipt: {subsystem: 'Test'}},
  ];
  for (const example of cases) {
    const {dependencies, output} = setup();
    const calls: string[] = [];
    const code = await run([...example.args, '--json'], {
      ...dependencies,
      createClient: (identity, options) => {
        const client = createClient(identity, options);
        const write = async () => {
          calls.push('confirmed write');
        };
        const read = async (): Promise<never> => {
          calls.push('failed read');
          throw new Error('refresh offline');
        };
        client.command = write;
        client.addToSprint = write;
        client.setSprintsEnabled = write;
        client.addSubsystem = write;
        client.getIssue = read;
        client.sprints = read;
        client.field = read;
        return client;
      },
    });
    assert.equal(code, 1, example.args.join(' '));
    const result = JSON.parse(output.join(''));
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.applied, [example.applied]);
    assert.deepEqual(result.receipt, example.receipt);
    assert.deepEqual(result.pending, ['refresh display']);
    assert.deepEqual(result.uncertain, []);
    assert.deepEqual(calls, ['confirmed write', 'failed read']);
  }
});

test('R-L2/L3 human-mode errors on stderr; unknown command exits 2', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const f = fixture();
  const deps = {
    loadConfig: () => reviewConfig,
    tracker: f.tracker,
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
  };
  assert.equal(await run(['take'], deps), 1);
  assert.deepEqual(out, []);
  assert.match(err.join(''), /usage: yt take/);
  assert.equal(await run(['nonsense'], deps), 2);
});

test('R-L6/L8 CLI take --force reaches the workflow', async () => {
  const f = fixture();
  f.issue.workflow.role = 'Owner decides';
  const code = await run(['take', 'PRJ-1', '--force', '--json'], {
    loadConfig: () => reviewConfig,
    tracker: f.tracker,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
});

test('a failed display refresh in human mode still tells stderr the write succeeded', async () => {
  const {dependencies, output, errors} = setup();
  const code = await run(['cmd', 'PRJ-1', 'State Fixed', '--quiet'], {
    ...dependencies,
    createClient: (identity, options) => {
      const client = createClient(identity, options);
      client.command = async () => {};
      client.getIssue = async () => {
        throw new Error('refresh offline');
      };
      return client;
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join(''), /execute native command succeeded, but refresh failed: refresh offline/);
});

const FIXED_REMINDER =
  '[yt] reminder: Fixed without --check. If a person must verify this (any UI change, or anything the tests do not cover), post a "Things to check" comment (AGENTS.md).\n';

test('state Fixed without --check prints the reminder in human mode only, and still hands off', async () => {
  const human = setup();
  assert.equal(await run(['state', 'PRJ-1', 'Fixed'], human.dependencies), 0);
  // Human mode also logs the client's connection line; the reminder must be written exactly once.
  assert.equal(human.errors.filter((line) => line === FIXED_REMINDER).length, 1, human.errors.join(''));
  assert.equal(human.issue.workflow.assignee, 'configured-owner');
  assert.equal(human.issue.workflow.role, 'Owner verifies');
  for (const flag of ['--json', '--quiet']) {
    const silent = setup();
    assert.equal(await run(['state', 'PRJ-1', 'Fixed', flag], silent.dependencies), 0);
    assert.deepEqual(silent.errors, [], flag);
  }
  const checked = setup();
  assert.equal(await run(['state', 'PRJ-1', 'Fixed', '--check', 'open the board'], checked.dependencies), 0);
  assert.doesNotMatch(checked.errors.join(''), /reminder/);
  const other = setup();
  assert.equal(await run(['state', 'PRJ-1', 'In Progress'], other.dependencies), 0);
  assert.doesNotMatch(other.errors.join(''), /reminder/);
});

test('state Fixed --check-file posts the file contents as the Things to check comment', async () => {
  const {dependencies, writes, errors} = setup();
  const paths: Array<string | number> = [];
  const code = await run(['state', 'PRJ-1', 'Fixed', '--check-file', 'check.md', '--json'], {
    ...dependencies,
    readText: (path) => {
      paths.push(path);
      return 'Open port 5201 and click Save\n';
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(paths, ['check.md']);
  assert.ok(writes.includes('comment:**Things to check**\n\nOpen port 5201 and click Save'), writes.join(' | '));
  assert.deepEqual(errors, []);
});

test('actual --tokens is refused before any request, and says nothing was written', async () => {
  const {dependencies, output} = setup();
  let fetches = 0;
  const code = await run(['actual', 'PRJ-1', '--tokens', '1M', '--json'], {
    ...dependencies,
    createClient: (identity, options) =>
      createClient(identity, {
        ...options,
        fetch: async () => {
          fetches++;
          throw new Error('must not call');
        },
      }),
  });
  assert.equal(code, 1);
  const result = JSON.parse(output.join(''));
  assert.equal(result.status, 'rejected');
  assert.match(result.error, /Nothing was written/);
  assert.equal(fetches, 0);
});

// YA-25 B12 (YA-8 C8.2): text output keeps what the baseline printed: the new issue's URL, and where a take left it.
test('create prints the issue URL and take prints the assignee and sprints', async () => {
  const created = setup();
  const createCode = await run(
    ['create', '--summary', 'Task', '--role', 'Builder', '--recommend', 'gpt-6', '--subsystem', 'Test', '--quiet'],
    created.dependencies,
  );
  assert.equal(createCode, 0);
  assert.match(
    created.output.join(''),
    /^PRJ-1 {2}\[Submitted\] {2}Task\n {2}https:\/\/example\.invalid\/issue\/PRJ-1\n/,
  );

  const taken = setup();
  assert.equal(await run(['take', 'PRJ-1', '--quiet'], taken.dependencies), 0);
  assert.match(taken.output.join(''), /\n-> In Progress, assigned agent, on Board: Sprint 1\n-> Role: Builder\./);

  const json = setup();
  await run(['take', 'PRJ-1', '--json'], json.dependencies);
  assert.equal(JSON.parse(json.output.join('')).issueSnapshot, 'after');
});

test('take text never claims an assignment its update did not confirm', async () => {
  const {dependencies, tracker, output} = setup();
  tracker.updateIssue = async () => {
    throw new TrackerFailure('unknown', 'reply lost');
  };
  assert.equal(await run(['take', 'PRJ-1', '--quiet'], dependencies), 1);
  assert.doesNotMatch(output.join(''), /assigned/);
  assert.match(output.join(''), /workflow: unknown/);
});

// YA-25 B4: whoami says when the owner is the unconfigured placeholder, and owner hand-offs refuse it.
test('whoami shows the owner and marks the admin default; Fixed refuses that default', async () => {
  const whoami = async (environment: Record<string, string>, json: boolean) => {
    const output: string[] = [];
    const config = loadConfig(
      {},
      {
        environment: {
          YOUTRACK_URL: 'https://example.invalid',
          YOUTRACK_TOKEN: 't',
          YOUTRACK_PROJECT: 'PRJ',
          ...environment,
        },
        files: [],
      },
    );
    const code = await run(['whoami', '--quiet', ...(json ? ['--json'] : [])], {
      loadConfig: () => config,
      stdout: (text) => {
        output.push(text);
      },
      createClient: (identity, options) =>
        createClient(identity, {
          ...options,
          fetch: async () => Response.json({id: '1', login: 'agent', fullName: 'Agent', email: null}),
        }),
    });
    assert.equal(code, 0);
    return output.join('');
  };
  assert.match(await whoami({}, false), /\nowner: admin \(default\)\n/);
  assert.match(await whoami({YOUTRACK_OWNER: 'owner-login'}, false), /\nowner: owner-login\n/);
  const envelope = JSON.parse(await whoami({}, true));
  assert.equal(envelope.owner, 'admin');
  assert.equal(envelope.ownerIsDefault, true);

  const {dependencies, output, writes} = setup();
  const code = await run(['state', 'PRJ-1', 'Fixed', '--check', 'x', '--json'], {
    ...dependencies,
    loadConfig: () => reviewConfig,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(output.join('')).status, 'rejected');
  assert.deepEqual(writes, []);
});

// YA-25 B10: the --debug help line describes what the flag adds.
test('help describes --debug as the provider error detail', () => {
  const line = HELP.split('\n').find((text) => /--debug/.test(text)) ?? '';
  assert.match(line, /error_description/);
  assert.match(line, /token/);
});

// YA-8 review T6 and T8: collection guards fail loudly instead of returning a short or inflated inventory.
test('a listing that ignores the page size, or never ends, fails instead of truncating', async (t) => {
  const listing = async (page: (top: number, skip: number) => unknown[]) => {
    const {dependencies, output} = setup();
    let requests = 0;
    const code = await run(['fields', '--json'], {
      ...dependencies,
      createClient: (identity, options) =>
        createClient(identity, {
          ...options,
          fetch: async (input) => {
            requests++;
            const url = new URL(String(input));
            return Response.json(page(Number(url.searchParams.get('$top')), Number(url.searchParams.get('$skip'))));
          },
        }),
    });
    return {code, envelope: JSON.parse(output.join('')), requests};
  };
  await t.test('an oversized page', async () => {
    const result = await listing((top) =>
      Array.from({length: top + 1}, (_, i) => ({id: `0-${i}`, shortName: `P${i}`})),
    );
    assert.equal(result.code, 1);
    assert.equal(result.envelope.status, 'rejected');
    assert.match(result.envelope.error, /page size/);
    assert.equal(result.requests, 1);
  });
  await t.test('the safety limit', async () => {
    const result = await listing((top, skip) =>
      Array.from({length: top}, (_, i) => ({id: `0-${skip + i}`, shortName: `P${skip + i}`})),
    );
    assert.equal(result.code, 1);
    assert.equal(result.envelope.status, 'rejected');
    assert.match(result.envelope.error, /safety limit/);
  });
});

// YA-8 B1 (CLI part): a capped listing says on stderr when more issues matched, so a duplicate check is not misled.
test('list and board say on stderr when more issues exist than they show', async (t) => {
  const issue = {
    id: '2-1',
    idReadable: 'PRJ-1',
    summary: 'Task',
    description: null,
    resolved: null,
    created: 0,
    updated: 0,
    reporter: null,
    fields: {State: 'Open'},
    url: 'https://example.invalid/issue/PRJ-1',
  };
  const invoke = async (argv: string[], complete: boolean) => {
    const {dependencies, output, errors} = setup();
    const searches: unknown[][] = [];
    const code = await run(argv, {
      ...dependencies,
      createClient: (identity, options) => {
        const client = createClient(identity, options);
        client.boardColumns = async () => ({field: 'State', columns: [{name: 'Open', values: ['Open']}]});
        client.searchIssues = async (query = '', top = 50) => {
          searches.push([query, top]);
          return {issues: [issue], complete};
        };
        return client;
      },
    });
    return {code, output: output.join(''), errors: errors.join(''), searches};
  };
  await t.test('list', async () => {
    const capped = await invoke(['list', 'State: Open', '--top', '1', '--json'], false);
    assert.equal(capped.code, 0);
    assert.equal(JSON.parse(capped.output)[0].idReadable, 'PRJ-1');
    assert.equal(capped.errors, '[yt] (showing 1; more exist: raise --top)\n');
    assert.deepEqual(capped.searches, [['State: Open', 1]]);
    assert.equal((await invoke(['list', '--json'], true)).errors, '');
  });
  await t.test('board', async () => {
    const capped = await invoke(['board', '--quiet'], false);
    assert.equal(capped.code, 0);
    assert.match(capped.output, /## Open \(1\)/);
    assert.equal(capped.errors, '[yt] (showing 1 unresolved issues; more exist)\n');
    assert.deepEqual(capped.searches, [['#Unresolved sort by: updated desc', 500]]);
    assert.equal((await invoke(['board', '--quiet'], true)).errors, '');
  });
});
