// YA-25 B6 (YA-8 C6, T5): whether a failed workflow step may have changed the tracker depends on what it sent, not
// on what it threw. These tests drive the real adapter and client over a fake fetch and count the POSTs.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createClient, loadConfig} from '../../client.ts';
import type {YouTrackClient} from '../../client.ts';
import {run} from '../../src/cli/run.ts';
import {createTrackerAdapter} from '../../src/youtrack/adapter.ts';
import {createIssue, handoffIssue} from '../../src/workflow/operations.ts';
import type {WorkflowContext} from '../../src/workflow/operations.ts';
import type {NewIssue, TrackerPort} from '../../src/tracker.ts';

const config = loadConfig(
  {},
  {
    environment: {
      YOUTRACK_URL: 'https://example.invalid',
      YOUTRACK_TOKEN: 'synthetic-test-token',
      YOUTRACK_PROJECT: 'PRJ',
      YOUTRACK_OWNER: 'configured-owner',
    },
    files: [],
  },
);

const FIELDS = [
  {id: 'f1', canBeEmpty: true, field: {name: 'AI Model', fieldType: {id: 'string'}}},
  {id: 'f2', canBeEmpty: true, field: {name: 'AI Session ID', fieldType: {id: 'string'}}},
  {id: 'f3', canBeEmpty: true, field: {name: 'Role', fieldType: {id: 'enum[1]'}}, bundle: {id: 'role'}},
  {id: 'f4', canBeEmpty: true, field: {name: 'Recommended model', fieldType: {id: 'enum[1]'}}, bundle: {id: 'model'}},
  {id: 'f5', canBeEmpty: true, field: {name: 'Subsystem', fieldType: {id: 'ownedField[1]'}}, bundle: {id: 'sub'}},
  {id: 'f6', canBeEmpty: true, field: {name: 'State', fieldType: {id: 'state[1]'}}, bundle: {id: 'state'}},
  {id: 'f7', canBeEmpty: true, field: {name: 'Assignee', fieldType: {id: 'user[1]'}}},
  {id: 'f8', canBeEmpty: true, field: {name: 'Priority', fieldType: {id: 'enum[1]'}}, bundle: {id: 'priority'}},
  {id: 'f9', canBeEmpty: true, field: {name: 'Due', fieldType: {id: 'date'}}},
  {id: 'f10', canBeEmpty: true, field: {name: 'Points', fieldType: {id: 'integer'}}},
  {id: 'f11', canBeEmpty: true, field: {name: 'Odd', fieldType: {id: 'mystery[1]'}}},
];

const BUNDLES: Record<string, string[]> = {
  'enum/role': ['Builder', 'Owner decides'],
  'enum/model': ['gpt-6'],
  'ownedField/sub': ['Test'],
  'state/state': ['Submitted', 'Open', 'In Progress'],
  'enum/priority': ['Major'],
};

const ISSUE = {
  id: '2-1',
  idReadable: 'PRJ-1',
  summary: 'Task',
  customFields: [
    {name: 'State', value: {name: 'Open'}},
    {name: 'Role', value: {name: 'Builder'}},
  ],
};

interface Provider {
  projects?: unknown;
  fields?: unknown;
  /** Answers every POST; the default is a well-formed issue or comment. */
  write?: (path: string) => Response;
}

function offline(provider: Provider = {}) {
  const posts: string[] = [];
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/api\//, '');
        if ((init?.method ?? 'GET') !== 'GET') {
          posts.push(path);
          if (provider.write) return provider.write(path);
          return Response.json(path.endsWith('/comments') ? {id: 'c1', text: 'note'} : ISSUE);
        }
        if (path === 'admin/projects') return Response.json(provider.projects ?? [{id: '0-1', shortName: 'PRJ'}]);
        if (path === 'admin/projects/0-1/customFields') return Response.json(provider.fields ?? FIELDS);
        const bundle = /^admin\/customFieldSettings\/bundles\/(.+)\/values$/.exec(path);
        if (bundle) return Response.json((BUNDLES[bundle[1]] ?? []).map((name, ordinal) => ({name, ordinal})));
        if (path === 'issues/PRJ-1') return Response.json(ISSUE);
        return new Response('', {status: 404});
      },
    },
  );
  return {client, posts};
}

function contextFor(client: YouTrackClient, tracker: TrackerPort = createTrackerAdapter(client)): WorkflowContext {
  return {tracker, owner: 'configured-owner', project: 'PRJ', writes: () => client.writes};
}

function newIssue(extraFields: NewIssue['extraFields'] = {}): NewIssue {
  return {
    summary: 'Task',
    workflow: {role: 'Builder', recommendedModel: 'gpt-6', subsystem: 'Test'},
    extraFields,
  };
}

test('a failure before any write is rejected with nothing uncertain, whatever was thrown', async (t) => {
  const cases: {name: string; provider?: Provider; extra?: NewIssue['extraFields']}[] = [
    {name: 'unknown field name', extra: {Prority: 'Major'}},
    {name: 'value outside the bundle', extra: {Priority: 'Bogus'}},
    {name: 'bad date (D7d)', extra: {Due: 'not a date'}},
    {name: 'bad integer', extra: {Points: 'many'}},
    {name: 'unsupported field type', extra: {Odd: 'x'}},
    {name: 'project not found (D7c)', provider: {projects: [{id: '0-9', shortName: 'OTHER'}]}},
    {name: 'malformed field metadata: TypeError', provider: {fields: [{id: 'f', canBeEmpty: true, field: null}]}},
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
      const {client, posts} = offline(example.provider);
      const result = await createIssue(contextFor(client), newIssue(example.extra));
      assert.equal(result.status, 'rejected', result.message);
      assert.deepEqual(result.uncertain, []);
      assert.deepEqual(result.pending, ['create issue']);
      assert.deepEqual(posts, []);
    });
  }
});

test('a plain Error from a tracker that sent nothing is rejected; the same Error after a write is unknown', async () => {
  const quiet = offline();
  const before = createTrackerAdapter(quiet.client);
  const thrownEarly = await createIssue(
    contextFor(quiet.client, {
      ...before,
      createIssue: async () => {
        throw new Error('broke while building the request');
      },
    }),
    newIssue(),
  );
  assert.equal(thrownEarly.status, 'rejected');
  assert.deepEqual(thrownEarly.uncertain, []);

  const sent = offline();
  const after = createTrackerAdapter(sent.client);
  const thrownLate = await createIssue(
    contextFor(sent.client, {
      ...after,
      createIssue: async (input) => {
        await after.createIssue(input);
        throw new TypeError('broke while reading the receipt');
      },
    }),
    newIssue(),
  );
  assert.equal(thrownLate.status, 'unknown');
  assert.deepEqual(thrownLate.uncertain, ['create issue']);
  assert.deepEqual(sent.posts, ['issues']);
});

test('dispatched writes: refused is not uncertain; lost, failed or unreadable replies are', async (t) => {
  const cases = [
    {name: '400 refused', status: 400, expected: 'partial', uncertain: [], pending: ['post handoff note']},
    {name: '503 after dispatch', status: 503, expected: 'unknown', uncertain: ['post handoff note'], pending: []},
    {name: '200 without a receipt', status: 200, expected: 'unknown', uncertain: ['post handoff note'], pending: []},
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
      const {client, posts} = offline({
        write: (path) => {
          if (!path.endsWith('/comments')) return Response.json(ISSUE);
          return example.status === 200 ? Response.json({}) : new Response('', {status: example.status});
        },
      });
      const result = await handoffIssue(contextFor(client), 'PRJ-1', {role: 'Builder', note: 'Continue'});
      assert.equal(result.status, example.expected);
      assert.deepEqual(result.applied, ['update issue']);
      assert.deepEqual(result.uncertain, example.uncertain);
      assert.deepEqual(result.pending, example.pending);
      assert.deepEqual(posts, ['issues/PRJ-1', 'issues/PRJ-1/comments']);
    });
  }
});

test('without write counts a plain Error stays uncertain, the conservative reading', async () => {
  const {client} = offline();
  const adapter = createTrackerAdapter(client);
  const result = await createIssue(
    {
      tracker: {
        ...adapter,
        createIssue: async () => {
          throw new Error('no counts to prove it was not sent');
        },
      },
      owner: 'configured-owner',
      project: 'PRJ',
    },
    newIssue(),
  );
  assert.equal(result.status, 'unknown');
});

test('yt create passes its client write counts to the workflow', async () => {
  const output: string[] = [];
  const posts: string[] = [];
  const code = await run(
    ['create', '--summary', 'Task', '--role', 'Builder', '--recommend', 'gpt-6', '--subsystem', 'Test', '--json'],
    {
      loadConfig: () => config,
      stdout: (text) => {
        output.push(text);
      },
      stderr: () => {},
      createClient: (identity, options) =>
        createClient(identity, {
          ...options,
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if ((init?.method ?? 'GET') !== 'GET') posts.push(path);
            if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
            // Metadata with a null field makes the client throw a TypeError before it can send anything.
            return Response.json([{id: 'f', canBeEmpty: true, field: null}]);
          },
        }),
    },
  );
  assert.equal(code, 1);
  const envelope = JSON.parse(output.join(''));
  assert.equal(envelope.status, 'rejected', envelope.message);
  assert.deepEqual(envelope.uncertain, []);
  assert.deepEqual(posts, []);
});
