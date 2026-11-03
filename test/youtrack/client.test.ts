import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {inspect} from 'node:util';
import {createClient, loadConfig} from '../../client.ts';
import {createIssue} from '../../src/workflow/operations.ts';
import {createTrackerAdapter} from '../../src/youtrack/adapter.ts';

const config = loadConfig(
  {baseUrl: 'https://tracker.example', project: 'YA', token: 'private-token'},
  {environment: {}, files: []},
);
const id = {model: 'test', session: 'test'};
const issue = {id: '1-1', idReadable: 'YA-1', summary: 'Issue', customFields: [], created: 0, updated: 0};

test('unsupported token actuals and invalid mixed inputs perform no reads or writes', async () => {
  let calls = 0;
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async () => {
        calls++;
        throw new Error('must not call');
      },
    },
  );
  await assert.rejects(client.addActual('YA-1', {tokens: '1M'}), {kind: 'unsupported'});
  await assert.rejects(client.addActual('YA-1', {time: '1h', tokens: '1M'}), {kind: 'unsupported'});
  await assert.rejects(client.addActual('YA-1', {time: ' '}), {kind: 'validation'});
  assert.equal(calls, 0);
});

/** A promise with its resolver exposed, so a test decides when each fake reply arrives. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return {promise, resolve};
}

// A serialised implementation never starts the second read, so the timeout turns that hang into a failure.
test(
  'B13 concurrent time actuals run in parallel, append once each and keep their own receipts',
  {timeout: 5000},
  async () => {
    const reads = [deferred<Response>(), deferred<Response>()];
    const bothRead = deferred<void>();
    let started = 0;
    let writes = 0;
    const client = createClient(
      {model: 'test', session: 'test'},
      {
        config,
        fetch: async (_input, options) => {
          if (options?.method === 'GET') {
            const reply = reads[started++].promise;
            if (started === 2) bothRead.resolve();
            return reply;
          }
          writes++;
          const body = JSON.parse(String(options?.body));
          assert.match(body.text, /agent: test/);
          return Response.json({id: `work-${body.duration.presentation}`, duration: {minutes: 60}, date: 0});
        },
      },
    );
    const first = client.addActual('YA-1', {time: '1h'});
    const second = client.addActual('YA-1', {time: '2h'});
    // Both reads are in flight before either is answered: neither call waits for the other.
    await bothRead.promise;
    assert.equal(writes, 0);
    reads[1].resolve(Response.json(issue));
    const secondResult = await second;
    assert.equal(writes, 1);
    reads[0].resolve(Response.json(issue));
    const firstResult = await first;
    assert.equal(writes, 2);
    assert.equal(firstResult.work?.id, 'work-1h');
    assert.equal(secondResult.work?.id, 'work-2h');
  },
);

test('time append network failure is unknown and never retried', async () => {
  let writes = 0;
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async (_input, options) => {
        if (options?.method === 'GET') return Response.json(issue);
        writes++;
        throw new Error('provider echo private-token');
      },
    },
  );
  await assert.rejects(client.addActual('YA-1', {time: '1h'}), {kind: 'unknown'});
  assert.equal(writes, 1);
});

test('typed adapter protects project and canonical workflow fields before network', async () => {
  let calls = 0;
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async () => {
        calls++;
        return Response.json(issue);
      },
    },
  );
  const adapter = createTrackerAdapter(client);
  await assert.rejects(adapter.updateIssue('OTHER-1', {summary: 'no'}), {kind: 'validation'});
  await assert.rejects(adapter.createIssue({summary: 'no', extraFields: {rOlE: 'Owner decides'}}), {
    kind: 'validation',
  });
  assert.equal(calls, 0);
});

test('iteration discovery distinguishes disabled sprints from failed lookup', async () => {
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/agiles'))
          return Response.json([
            {id: 'a', name: 'disabled', projects: [{shortName: 'YA'}]},
            {id: 'b', name: 'broken', projects: [{shortName: 'YA'}]},
          ]);
        if (path.endsWith('/a'))
          return Response.json({
            name: 'disabled',
            sprintsSettings: {disableSprints: true},
            currentSprint: null,
            sprints: [],
          });
        return new Response('unavailable', {status: 503});
      },
    },
  );
  const result = await createTrackerAdapter(client).discoverIterations('YA');
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.unavailable, ['broken: sprint discovery failed']);
});

test('sprints and field choices are read from paginated nested endpoints', async () => {
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async (input) => {
        const url = new URL(String(input));
        const path = url.pathname;
        const skip = Number(url.searchParams.get('$skip') ?? 0);
        if (path.endsWith('/agiles')) return Response.json([{id: 'a', name: 'Main', projects: [{shortName: 'YA'}]}]);
        if (path.endsWith('/agiles/a'))
          return Response.json({
            name: 'Main',
            sprintsSettings: {disableSprints: false},
            currentSprint: {name: 'Current'},
          });
        if (path.endsWith('/sprints'))
          return Response.json([{id: 's', name: 'Current', archived: false, start: null, finish: null}]);
        if (path.endsWith('/issues'))
          return Response.json(Array.from({length: skip ? 1 : 100}, (_, index) => ({id: String(skip + index)})));
        if (path.endsWith('/admin/projects')) return Response.json([{id: 'p', shortName: 'YA'}]);
        if (path.endsWith('/customFields'))
          return Response.json([
            {
              id: 'f',
              canBeEmpty: true,
              field: {name: 'State', fieldType: {id: 'state[1]'}},
              bundle: {id: 'b', values: []},
            },
          ]);
        if (path.endsWith('/values'))
          return Response.json(Array.from({length: skip ? 1 : 100}, (_, index) => ({name: `State ${skip + index}`})));
        throw new Error('unexpected endpoint');
      },
    },
  );
  assert.equal((await client.sprints('Main')).sprints[0].issues, 101);
  assert.equal((await client.field('State')).values.length, 101);
  assert.deepEqual(await client.fieldPayload('State', 'state 100'), {
    name: 'State',
    $type: 'StateIssueCustomField',
    value: {name: 'State 100'},
  });
});

test('provider field validation rejects a workflow before dispatch instead of reporting an unknown write', async () => {
  let writes = 0;
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async () => {
        writes++;
        throw new Error('No request should be dispatched after cached metadata validation');
      },
    },
  );
  client.getProjectId = async () => '0-1';
  client.fields = async () =>
    ['AI Model', 'AI Session ID', 'Role', 'Recommended model', 'Subsystem', 'State'].map((name) => ({
      id: name,
      name,
      type: name.startsWith('AI ') ? 'string' : 'enum[1]',
      canBeEmpty: false,
      values: name === 'Recommended model' ? ['known-model'] : ['Builder', 'Test', 'Submitted'],
    }));
  const result = await createIssue(
    {tracker: createTrackerAdapter(client), project: 'YA', owner: 'admin'},
    {
      summary: 'invalid model',
      workflow: {role: 'Builder', recommendedModel: 'typo-model', subsystem: 'Test'},
    },
  );
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.uncertain, []);
  assert.equal(writes, 0);
});

test('current iteration discovery never depends on historical sprint membership', async () => {
  const paths: string[] = [];
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === '/api/agiles') return Response.json([{id: 'a', name: 'Board', projects: [{shortName: 'YA'}]}]);
        if (path === '/api/agiles/a')
          return Response.json({
            sprintsSettings: {disableSprints: false},
            currentSprint: {id: 's', name: 'Current', archived: false},
          });
        return new Response('Historical membership unavailable', {status: 403});
      },
    },
  );
  assert.deepEqual(await createTrackerAdapter(client).discoverIterations('YA'), {
    targets: [{scopeId: 'a', scopeName: 'Board', iterationId: 's', iterationName: 'Current'}],
    unavailable: [],
    withoutCurrent: [],
  });
  assert.deepEqual(paths, ['/api/agiles', '/api/agiles/a']);
});

test('malformed issue collections and entries after an update remain unknown writes', async () => {
  for (const customFields of [{}, [null], [{value: 'missing name'}]]) {
    let writes = 0;
    const client = createClient(
      {model: 'test', session: 'test'},
      {
        config,
        fetch: async (_input, options) => {
          assert.equal(options?.method, 'POST');
          writes++;
          return Response.json({...issue, customFields});
        },
      },
    );
    await assert.rejects(client.updateIssue('YA-1', {summary: 'new'}), {kind: 'unknown'});
    assert.equal(writes, 1);
  }
});

test('R-D7b unknown --set field is a pre-write rejection, not an unknown write', async () => {
  let writes = 0;
  const client = createClient(id, {
    config,
    fetch: async () => {
      writes++;
      throw new Error('no dispatch expected');
    },
  });
  client.getProjectId = async () => '0-1';
  client.fields = async () =>
    ['AI Model', 'AI Session ID', 'Role', 'Recommended model', 'Subsystem', 'State'].map((name) => ({
      id: name,
      name,
      type: name.startsWith('AI ') ? 'string' : 'enum[1]',
      canBeEmpty: false,
      values: ['Builder', 'Test', 'Submitted', 'm'],
    }));
  const result = await createIssue(
    {tracker: createTrackerAdapter(client), project: 'YA', owner: 'admin'},
    {
      summary: 's',
      workflow: {role: 'Builder', recommendedModel: 'm', subsystem: 'Test'},
      extraFields: {Prority: 'High'},
    },
  );
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.uncertain, []);
  assert.equal(writes, 0);
});

test('R-C3/C4 write receipts without ids are unknown', async () => {
  const client = createClient(id, {config, fetch: async () => Response.json({})});
  await assert.rejects(client.addComment('YA-1', 'x'), {kind: 'unknown'});
  await assert.rejects(client.updateIssue('YA-1', {summary: 'x'}), {kind: 'unknown'});
});

test('a work item POST answered without an id is an unknown write, not a logged actual', async () => {
  for (const body of [{}, {id: 7}, null]) {
    let writes = 0;
    const client = createClient(id, {
      config,
      fetch: async (_input, options) => {
        if (options?.method === 'GET') return Response.json(issue);
        writes++;
        return body === null ? new Response('', {status: 200}) : Response.json(body);
      },
    });
    await assert.rejects(client.addActual('YA-1', {time: '1h'}), {kind: 'unknown'});
    assert.equal(writes, 1);
  }
});

test('the client counts dispatched, confirmed and refused writes; reads are not counted', async () => {
  const statuses = [200, 400, 503];
  const client = createClient(id, {
    config,
    fetch: async (_input, options) => {
      if (options?.method === 'GET') return Response.json(issue);
      return Response.json({id: 'x'}, {status: statuses.shift()});
    },
  });
  await client.request('GET', 'issues/YA-1');
  assert.deepEqual(client.writes, {dispatched: 0, confirmed: 0, refused: 0});
  await client.request('POST', 'issues/YA-1', {});
  await assert.rejects(client.request('POST', 'issues/YA-1', {}), {kind: 'validation'});
  await assert.rejects(client.request('POST', 'issues/YA-1', {}), {kind: 'unknown'});
  assert.deepEqual(client.writes, {dispatched: 3, confirmed: 1, refused: 1});
});

const BAD_IDS = [
  'YA-1/../../admin',
  '../admin/projects',
  'YA-1?fields=x',
  'YA 1',
  'YA-',
  '',
  'YA-1#x',
  '-1',
  'YA-1%2F',
];

test('B2 malformed issue ids are refused at the client boundary before any request', async () => {
  let calls = 0;
  const client = createClient(id, {
    config,
    fetch: async () => {
      calls++;
      return Response.json(issue);
    },
  });
  for (const bad of BAD_IDS) {
    for (const [name, call] of [
      ['getIssue', () => client.getIssue(bad)],
      ['updateIssue', () => client.updateIssue(bad, {summary: 'x'})],
      ['addComment', () => client.addComment(bad, 'x')],
      ['comments', () => client.comments(bad)],
      ['commentPage', () => client.commentPage(bad, 5)],
      ['logWork', () => client.logWork(bad, '1h')],
      ['workItems', () => client.workItems(bad)],
      ['addActual', () => client.addActual(bad, {time: '1h'})],
      ['command', () => client.command(['YA-1', bad], 'State Open')],
    ] as const) {
      await assert.rejects(call(), {kind: 'validation'}, `${name}(${JSON.stringify(bad)})`);
    }
  }
  assert.equal(calls, 0);
  // Both id forms are accepted.
  await client.getIssue('YA_2-17');
  await client.getIssue('2-7');
  assert.equal(calls, 2);
});

test('B2 server-provided ids are encoded as single path segments', async () => {
  const paths: string[] = [];
  const client = createClient(id, {
    config,
    fetch: async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/api/admin/projects') return Response.json([{id: '0/../../users', shortName: 'YA'}]);
      if (url.pathname.endsWith('/customFields'))
        return Response.json([
          {id: 'f', canBeEmpty: true, field: {name: 'State', fieldType: {id: 'state[1]'}}, bundle: {id: 'b?x'}},
        ]);
      if (url.pathname.endsWith('/values')) return Response.json([{name: 'Open'}]);
      if (url.pathname === '/api/agiles') return Response.json([{id: 'a/../b', name: 'Main'}]);
      if (url.pathname.endsWith('/sprints')) return Response.json([{id: 's#1', name: 'S', archived: false}]);
      if (url.pathname.endsWith('/issues')) return Response.json([]);
      return Response.json({name: 'Main', sprintsSettings: {disableSprints: false}, currentSprint: null});
    },
  });
  await client.fields();
  await client.sprints('Main');
  assert.deepEqual(paths, [
    '/api/admin/projects',
    '/api/admin/projects/0%2F..%2F..%2Fusers/customFields',
    '/api/admin/customFieldSettings/bundles/state/b%3Fx/values',
    '/api/agiles',
    '/api/agiles/a%2F..%2Fb',
    '/api/agiles/a%2F..%2Fb/sprints',
    '/api/agiles/a%2F..%2Fb/sprints/s%231/issues',
  ]);
});

// YA-25 Y4: encoding leaves `.` and `..` intact and URL parsing resolves them, so the client refuses such ids.
test('Y4 dot-segment and empty server ids are refused before the request that would use them', async (t) => {
  for (const hostile of ['..', '.', '']) {
    await t.test(JSON.stringify(hostile), async () => {
      const paths: string[] = [];
      const client = createClient(id, {
        config,
        fetch: async (input) => {
          const url = new URL(String(input));
          paths.push(url.pathname);
          if (url.pathname === '/api/admin/projects') return Response.json([{id: hostile, shortName: 'YA'}]);
          if (url.pathname === '/api/agiles') return Response.json([{id: hostile, name: 'Main'}]);
          return Response.json({name: 'Main', sprintsSettings: {disableSprints: true}, currentSprint: null});
        },
      });
      await assert.rejects(client.fields(), {kind: 'validation'});
      await assert.rejects(client.sprints('Main'), {kind: 'validation'});
      assert.deepEqual(paths, ['/api/admin/projects', '/api/agiles']);
    });
  }
});

test('B8 a write reply with missing or null customFields is unknown; a read stays lenient', async () => {
  for (const customFields of [undefined, null]) {
    const reply = {...issue, customFields};
    const client = createClient(id, {config, fetch: async () => Response.json(reply)});
    client.getProjectId = async () => '0-1';
    client.fields = async () =>
      ['AI Model', 'AI Session ID'].map((name) => ({id: name, name, type: 'string', canBeEmpty: true, values: []}));
    await assert.rejects(client.updateIssue('YA-1', {summary: 'new'}), {kind: 'unknown'});
    await assert.rejects(client.createIssue({summary: 'new'}), {kind: 'unknown'});
    assert.deepEqual((await client.getIssue('YA-1')).fields, {});
  }
});

test('B11 the client never serialises or inspects its credential, and still uses it', async () => {
  let authorization = '';
  const client = createClient(id, {
    config,
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return Response.json(issue);
    },
  });
  assert.doesNotMatch(JSON.stringify(client), /private-token/);
  assert.doesNotMatch(inspect(client, {depth: 10}), /private-token/);
  assert.doesNotMatch(JSON.stringify({...client}), /private-token/);
  assert.ok(!Object.keys(client).includes('config'));
  assert.equal(client.config.token, 'private-token');
  await client.getIssue('YA-1');
  assert.equal(authorization, 'Bearer private-token');
});

test('B1 client searches and comment pages report completeness from one extra item', async () => {
  const seen: {path: string; top: string | null; query: string | null}[] = [];
  const client = createClient(id, {
    config,
    fetch: async (input) => {
      const url = new URL(String(input));
      const top = Number(url.searchParams.get('$top'));
      seen.push({path: url.pathname, top: url.searchParams.get('$top'), query: url.searchParams.get('query')});
      if (url.pathname === '/api/issues')
        return Response.json(Array.from({length: Math.min(top, 3)}, (_, n) => ({...issue, idReadable: `YA-${n}`})));
      return Response.json(
        [
          {id: 'c1', author: {login: 'ann', fullName: 'Ann Lee'}, text: 'one', created: 1},
          {id: 'c2', author: {login: 'bob', fullName: ''}, text: 'two', created: 2},
          {id: 'c3', author: null, text: null, created: 3},
        ].slice(0, top),
      );
    },
  });
  assert.deepEqual(await client.searchIssues('State: Open', 2).then((r) => [r.issues.length, r.complete]), [2, false]);
  assert.deepEqual(await client.searchIssues('', 3).then((r) => [r.issues.length, r.complete]), [3, true]);
  assert.equal((await client.listIssues('', 2)).length, 2);
  assert.deepEqual(seen.slice(0, 2), [
    {path: '/api/issues', top: '3', query: 'project: YA State: Open'},
    {path: '/api/issues', top: '4', query: 'project: YA'},
  ]);
  assert.deepEqual(await client.commentPage('YA-1', 3), {
    comments: [
      {id: 'c1', author: 'ann', authorName: 'Ann Lee', text: 'one', created: 1},
      {id: 'c2', author: 'bob', authorName: 'bob', text: 'two', created: 2},
      {id: 'c3', author: null, authorName: null, text: '', created: 3},
    ],
    complete: true,
  });
  assert.equal((await client.commentPage('YA-1', 2)).complete, false);
});

// YA-25 F4: `created` feeds relative times in spoken listings, so a comment without a valid one is malformed.
test('F4 commentPage refuses a comment with a missing or invalid created timestamp', async () => {
  for (const created of [undefined, null, 'yesterday', Number.NaN, Infinity]) {
    const client = createClient(id, {
      config,
      fetch: async () =>
        Response.json([
          {id: 'c1', author: {login: 'ann'}, text: 'fine', created: 1},
          {id: 'c2', author: {login: 'bob'}, text: 'odd', ...(created === undefined ? {} : {created})},
        ]),
    });
    await assert.rejects(client.commentPage('YA-1', 5), {kind: 'unavailable', message: /created/}, String(created));
  }
});
