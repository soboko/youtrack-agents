import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {loadConfig} from '../../src/config.ts';
import {createClient} from '../../src/youtrack/client.ts';
import {createTrackerAdapter} from '../../src/youtrack/adapter.ts';
import {takeIssue} from '../../src/workflow/operations.ts';
import type {Issue} from '../../src/youtrack/types.ts';

const config = loadConfig(
  {baseUrl: 'https://tracker.example', project: 'YA', token: 'private-token'},
  {environment: {}, files: []},
);
const identity = {model: 'test', session: 'test'};
const issue = {id: '2-7', idReadable: 'YA-1', summary: 'Issue', customFields: [], created: 0, updated: 0};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Route = (method: string, url: URL) => Response | undefined;

/** A fake provider that records every request; unrouted requests fail loudly as 404s. */
function recordingClient(route: Route) {
  const calls: Call[] = [];
  const client = createClient(identity, {
    config,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined});
      return route(method, url) ?? new Response('unrouted', {status: 404});
    },
  });
  return {client, calls};
}

// Projects a JSON value the way YouTrack's `fields` parameter does: only requested attributes survive.
function project(value: unknown, spec: string): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, spec));
  if (value === null || typeof value !== 'object') return value;
  const parts: string[] = [];
  let depth = 0;
  let token = '';
  for (const character of spec) {
    if (character === ',' && depth === 0) {
      parts.push(token);
      token = '';
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') depth--;
    token += character;
  }
  if (token) parts.push(token);
  const projected: Record<string, unknown> = {};
  for (const part of parts) {
    const match = /^([^()]+)(?:\((.*)\))?$/.exec(part.trim());
    if (!match) throw new Error(`bad fields spec ${part}`);
    const [, key, nested] = match;
    if (key in value) {
      const field = (value as Record<string, unknown>)[key];
      projected[key] = nested ? project(field, nested) : field;
    }
  }
  return projected;
}

function agileClient(agile: Record<string, unknown>) {
  return recordingClient((_method, url) => {
    if (url.pathname === '/api/agiles') return Response.json([{id: 'a', name: 'Board', projects: [{shortName: 'YA'}]}]);
    if (url.pathname === '/api/agiles/a') return Response.json(project(agile, url.searchParams.get('fields') ?? 'id'));
    return undefined;
  }).client;
}

test('R-S2/S3/S4 discovery honours the fields projection; archived and missing current sprints are between sprints', async () => {
  const full = {
    id: 'a',
    sprintsSettings: {disableSprints: false},
    currentSprint: {id: 's', name: 'Current', archived: false},
  };
  assert.deepEqual(await createTrackerAdapter(agileClient(full)).discoverIterations('YA'), {
    targets: [{scopeId: 'a', scopeName: 'Board', iterationId: 's', iterationName: 'Current'}],
    unavailable: [],
    withoutCurrent: [],
  });
  const archived = {...full, currentSprint: {id: 's', name: 'Old', archived: true}};
  assert.deepEqual(await createTrackerAdapter(agileClient(archived)).discoverIterations('YA'), {
    targets: [],
    unavailable: [],
    withoutCurrent: ['Board'],
  });
  const none = {...full, currentSprint: null};
  assert.deepEqual(await createTrackerAdapter(agileClient(none)).discoverIterations('YA'), {
    targets: [],
    unavailable: [],
    withoutCurrent: ['Board'],
  });
});

test('R-S6 boards of other projects are not placement targets', async () => {
  const {client} = recordingClient((_method, url) => {
    if (url.pathname === '/api/agiles')
      return Response.json([
        {id: 'a', name: 'Mine', projects: [{shortName: 'YA'}]},
        {id: 'b', name: 'Theirs', projects: [{shortName: 'OTHER'}]},
      ]);
    return Response.json({
      sprintsSettings: {disableSprints: false},
      currentSprint: {id: 's', name: 'S', archived: false},
    });
  });
  assert.deepEqual(
    (await createTrackerAdapter(client).discoverIterations('YA')).targets.map((target) => target.scopeName),
    ['Mine'],
  );
});

test('lookup failures stay unavailable; boards without sprints are skipped', async () => {
  const {client} = recordingClient((_method, url) => {
    if (url.pathname === '/api/agiles')
      return Response.json(
        ['disabled', 'nosettings', 'broken', 'between'].map((name) => ({
          id: name,
          name,
          projects: [{shortName: 'YA'}],
        })),
      );
    if (url.pathname === '/api/agiles/disabled')
      return Response.json({sprintsSettings: {disableSprints: true}, currentSprint: null});
    if (url.pathname === '/api/agiles/nosettings')
      return Response.json({currentSprint: {id: 's', name: 'S', archived: false}});
    if (url.pathname === '/api/agiles/broken') return new Response('down', {status: 503});
    if (url.pathname === '/api/agiles/between')
      return Response.json({sprintsSettings: {disableSprints: false}, currentSprint: null});
    return undefined;
  });
  assert.deepEqual(await createTrackerAdapter(client).discoverIterations('YA'), {
    targets: [],
    unavailable: ['nosettings: sprint discovery failed', 'broken: sprint discovery failed'],
    withoutCurrent: ['between'],
  });
});

function twoBoards(boardB: () => Response) {
  return recordingClient((method, url) => {
    if (method === 'POST' && url.pathname === '/api/agiles/a/sprints/s/issues') return Response.json({id: issue.id});
    if (method !== 'GET') return undefined;
    if (url.pathname === '/api/issues/YA-1') return Response.json(issue);
    if (url.pathname === '/api/users/me')
      return Response.json({id: '1-1', login: 'agent', fullName: 'Agent', email: null});
    if (url.pathname === '/api/agiles')
      return Response.json([
        {id: 'a', name: 'A', projects: [{shortName: 'YA'}]},
        {id: 'b', name: 'B', projects: [{shortName: 'YA'}]},
      ]);
    if (url.pathname === '/api/agiles/a')
      return Response.json({
        sprintsSettings: {disableSprints: false},
        currentSprint: {id: 's', name: 'Sprint 1', archived: false},
      });
    if (url.pathname === '/api/agiles/b') return boardB();
    return undefined;
  });
}

test('a board lookup that fails with 503 rejects take before any write', async () => {
  const {client, calls} = twoBoards(() => new Response('down', {status: 503}));
  const result = await takeIssue({tracker: createTrackerAdapter(client), owner: 'admin', project: 'YA'}, 'YA-1');
  assert.equal(result.status, 'rejected');
  assert.match(result.message ?? '', /B: sprint discovery failed/);
  assert.deepEqual(
    calls.filter((call) => call.method !== 'GET'),
    [],
  );
});

test('a board between sprints lets take apply its writes and owes that board a placement', async () => {
  const {client, calls} = twoBoards(() =>
    Response.json({sprintsSettings: {disableSprints: false}, currentSprint: null}),
  );
  // Field metadata is out of scope here; the update is recorded as a write so ordering stays visible.
  client.updateIssue = async (key) => {
    calls.push({method: 'POST', path: `/api/issues/${key}`, body: undefined});
    const updated: Issue = {
      id: issue.id,
      idReadable: issue.idReadable,
      summary: issue.summary,
      description: null,
      resolved: null,
      created: 0,
      updated: 1,
      reporter: null,
      fields: {State: 'In Progress'},
      url: '',
    };
    return updated;
  };
  const result = await takeIssue({tracker: createTrackerAdapter(client), owner: 'admin', project: 'YA'}, 'YA-1');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.applied, ['take issue', 'place in A: Sprint 1']);
  assert.deepEqual(result.pending, ['place in B: no current sprint']);
  assert.deepEqual(result.uncertain, []);
  assert.deepEqual(
    calls.filter((call) => call.method !== 'GET').map((call) => call.path),
    ['/api/issues/YA-1', '/api/agiles/a/sprints/s/issues'],
  );
});

test('T14 placement posts the entity id to the sprint issues collection', async () => {
  const {client, calls} = recordingClient((method, url) => {
    if (method === 'GET' && url.pathname === '/api/issues/YA-1') return Response.json(issue);
    if (method === 'POST' && url.pathname === '/api/agiles/a/sprints/s/issues') return Response.json({id: '2-7'});
    return undefined;
  });
  await createTrackerAdapter(client).placeInIteration('YA-1', {
    scopeId: 'a',
    scopeName: 'Board',
    iterationId: 's',
    iterationName: 'Sprint 1',
  });
  assert.deepEqual(
    calls.filter((call) => call.method === 'POST'),
    [{method: 'POST', path: '/api/agiles/a/sprints/s/issues', body: {id: '2-7', $type: 'Issue'}}],
  );
});

test('T14 placement refuses a path-shaped iteration identifier before any request', async () => {
  const {client, calls} = recordingClient(() => Response.json(issue));
  const adapter = createTrackerAdapter(client);
  for (const target of [
    {scopeId: '../x', scopeName: 'Board', iterationId: 's', iterationName: 'Sprint 1'},
    {scopeId: 'a', scopeName: 'Board', iterationId: 's/../../x', iterationName: 'Sprint 1'},
  ]) {
    await assert.rejects(adapter.placeInIteration('YA-1', target), {kind: 'validation'});
  }
  assert.deepEqual(calls, []);
});

/** A client whose issue search answers `total` issues and records each query and page size. */
function searchClient(total: number) {
  const searches: {query: string | null; top: string | null}[] = [];
  const {client, calls} = recordingClient((_method, url) => {
    if (url.pathname !== '/api/issues') return undefined;
    searches.push({query: url.searchParams.get('query'), top: url.searchParams.get('$top')});
    const top = Number(url.searchParams.get('$top'));
    return Response.json(Array.from({length: Math.min(top, total)}, (_, n) => ({...issue, idReadable: `YA-${n + 1}`})));
  });
  return {client, calls, searches};
}

test('B1 listIssues filters by assignee, summary words and resolution, and reports a capped list', async () => {
  const {client, searches} = searchClient(3);
  const adapter = createTrackerAdapter(client);
  const capped = await adapter.listIssues({assignee: 'me', text: 'login crash', unresolved: true, limit: 2});
  assert.deepEqual(
    capped.issues.map((found) => found.key),
    ['YA-1', 'YA-2'],
  );
  assert.equal(capped.complete, false);
  const whole = await adapter.listIssues({state: 'In Progress', assignee: 'ann.lee', limit: 3});
  assert.equal(whole.issues.length, 3);
  assert.equal(whole.complete, true);
  assert.deepEqual(searches, [
    {
      query: 'project: YA for: me (summary: "login" and summary: "crash") #Unresolved sort by: updated desc',
      top: '3',
    },
    {query: 'project: YA State: {In Progress} for: {ann.lee} sort by: updated desc', top: '4'},
  ]);
});

test('B1 summary words are quoted one by one, so user text cannot add query syntax', async () => {
  const {client, searches} = searchClient(0);
  const adapter = createTrackerAdapter(client);
  await adapter.listIssues({text: 'a{b} c:d #Unresolved -e "f" g"} or project: OTHER {h\\'});
  assert.equal(
    searches[0].query,
    'project: YA (summary: "ab" and summary: "cd" and summary: "Unresolved" and summary: "-e" and ' +
      'summary: "f" and summary: "g" and summary: "or" and summary: "project" and ' +
      'summary: "OTHER" and summary: "h") sort by: updated desc',
  );
});

/** The query with every quoted word emptied: what remains is only the adapter's own syntax. */
const syntaxOf = (query: string | null) => (query ?? '').replace(/"[^"]*"/g, '""');

// YA-25 F1/Y3: spoken search needs any-word matching, and neither mode may let a word escape the project scope.
test('F1 textMode any joins words with or inside one group that stays and-ed with the project and filters', async () => {
  const {client, searches} = searchClient(0);
  const adapter = createTrackerAdapter(client);
  await adapter.listIssues({text: 'login project:OTHER #Unresolved or', textMode: 'any', state: 'Open'});
  assert.equal(
    searches[0].query,
    'project: YA State: {Open} (summary: "login" or summary: "projectOTHER" or summary: "Unresolved" or ' +
      'summary: "or") sort by: updated desc',
  );
  assert.equal(
    syntaxOf(searches[0].query),
    'project: YA State: {Open} (summary: "" or summary: "" or summary: "" or summary: "") sort by: updated desc',
  );
  await adapter.listIssues({text: 'login crash'});
  assert.equal(searches[1].query, 'project: YA (summary: "login" and summary: "crash") sort by: updated desc');
  await adapter.listIssues({text: 'login crash', textMode: 'all'});
  assert.equal(searches[2].query, searches[1].query);
});

test('F1/Y3 words lose parentheses, colons, braces, hashes, backslashes and every kind of quote', async () => {
  const {client, searches} = searchClient(0);
  const adapter = createTrackerAdapter(client);
  const cases: [string, string][] = [
    ['map', 'project: YA (summary: "map") sort by: updated desc'],
    ['x\u201d)or(project:OTHER)or(\u201cy', 'project: YA (summary: "xorprojectOTHERory") sort by: updated desc'],
    [
      '\u2018don\u2019t\u2019 \u00abfix\u00bb \uff02a\uff02 \u300cb\u300d',
      'project: YA (summary: "dont" or summary: "fix" or summary: "a" or summary: "b") sort by: updated desc',
    ],
    [
      "don't - fix #1 {x} \u2014 ...",
      'project: YA (summary: "don\'t" or summary: "fix" or summary: "1" or summary: "x") sort by: updated desc',
    ],
    [
      'one two three four five six seven eight',
      `project: YA (${'one two three four five six seven eight'
        .split(' ')
        .map((w) => `summary: "${w}"`)
        .join(' or ')}) sort by: updated desc`,
    ],
  ];
  for (const [text, query] of cases) {
    await adapter.listIssues({text, textMode: 'any'});
    assert.equal(searches.at(-1)?.query, query, text);
    // One group of quoted words and nothing else between the project and the sort.
    assert.match(
      syntaxOf(searches.at(-1)!.query).replace(/summary: ""/g, 'W'),
      /^project: YA \(W( or W)*\) sort by: updated desc$/,
    );
  }
  // Text with no word left is no text condition at all, in either mode.
  for (const text of ['', '  "" \\ ', '- ... #', '\u201c\u201d ()', '{}:#']) {
    for (const textMode of ['all', 'any'] as const) {
      await adapter.listIssues({text, textMode, unresolved: true});
      assert.equal(searches.at(-1)?.query, 'project: YA #Unresolved sort by: updated desc', JSON.stringify(text));
    }
  }
});

test('B1 filter values that could escape the query are refused before any request', async () => {
  const {client, calls} = searchClient(1);
  const adapter = createTrackerAdapter(client);
  for (const filter of [
    {assignee: 'me} or {x'},
    {assignee: 'ann  lee'},
    {assignee: 'ann '},
    {assignee: ' ann'},
    {assignee: 'ann lee: or'},
    {assignee: '-me'},
    {assignee: ''},
    {state: 'Open} or {x'},
  ]) {
    await assert.rejects(adapter.listIssues(filter), {kind: 'validation'}, JSON.stringify(filter));
  }
  assert.deepEqual(calls, []);
});

test('B1 listComments returns author names, oldest first, and says when more comments exist', async () => {
  const tops: string[] = [];
  const {client, calls} = recordingClient((_method, url) => {
    if (url.pathname !== '/api/issues/YA-1/comments') return undefined;
    tops.push(url.searchParams.get('$top') ?? '');
    const top = Number(url.searchParams.get('$top'));
    return Response.json(
      [
        {id: 'c1', author: {login: 'ann', fullName: 'Ann Lee'}, text: 'first', created: 10},
        {id: 'c2', author: {login: 'bob', fullName: ''}, text: 'second', created: 20},
        {id: 'c3', author: null, text: 'third', created: 30},
      ].slice(0, top),
    );
  });
  const adapter = createTrackerAdapter(client);
  assert.deepEqual(await adapter.listComments('YA-1', 3), {
    comments: [
      {authorName: 'Ann Lee', authorLogin: 'ann', created: 10, text: 'first'},
      {authorName: 'bob', authorLogin: 'bob', created: 20, text: 'second'},
      {authorName: 'Unknown', authorLogin: null, created: 30, text: 'third'},
    ],
    complete: true,
  });
  assert.deepEqual(await adapter.listComments('YA-1', 2), {
    comments: [
      {authorName: 'Ann Lee', authorLogin: 'ann', created: 10, text: 'first'},
      {authorName: 'bob', authorLogin: 'bob', created: 20, text: 'second'},
    ],
    complete: false,
  });
  assert.deepEqual(tops, ['4', '3']);
  const before = calls.length;
  await assert.rejects(adapter.listComments('OTHER-1', 2), {kind: 'validation'});
  assert.equal(calls.length, before);
});

const TARGET = {scopeId: 'a', scopeName: 'Board', iterationId: 's', iterationName: 'Sprint 1'};

test('B6 placement with a known entity id needs no issue read and accepts the confirmed receipt', async () => {
  const {client, calls} = recordingClient((method, url) => {
    if (method === 'POST' && url.pathname === '/api/agiles/a/sprints/s/issues')
      return Response.json({id: '2-7', idReadable: 'YA-1', $type: 'Issue'});
    return undefined;
  });
  await createTrackerAdapter(client).placeInIteration('YA-1', TARGET, '2-7');
  assert.deepEqual(calls, [
    {method: 'POST', path: '/api/agiles/a/sprints/s/issues', body: {id: '2-7', $type: 'Issue'}},
  ]);
});

test('B6 placement without a matching receipt id is unknown; a malformed entity id is refused first', async () => {
  for (const reply of [
    () => new Response('', {status: 200}),
    () => Response.json({}),
    () => Response.json({id: '2-8'}),
  ]) {
    const {client, calls} = recordingClient((method) => (method === 'POST' ? reply() : undefined));
    await assert.rejects(createTrackerAdapter(client).placeInIteration('YA-1', TARGET, '2-7'), {kind: 'unknown'});
    assert.equal(calls.length, 1);
  }
  const {client, calls} = recordingClient(() => Response.json({id: '2-7'}));
  for (const bad of ['', 'YA-1', '2-7/../x']) {
    await assert.rejects(createTrackerAdapter(client).placeInIteration('YA-1', TARGET, bad), {kind: 'validation'});
  }
  assert.deepEqual(calls, []);
});

test('NF1 a sprint lookup missing currentSprint or a boolean disableSprints is a failed lookup', async () => {
  const boards: Record<string, unknown> = {
    missing: {sprintsSettings: {disableSprints: false}},
    stringly: {sprintsSettings: {disableSprints: 'false'}, currentSprint: {id: 's', name: 'S', archived: false}},
    nullsettings: {sprintsSettings: null, currentSprint: null},
    malformed: {sprintsSettings: {disableSprints: false}, currentSprint: {id: 7, name: 'S', archived: false}},
    unarchived: {sprintsSettings: {disableSprints: false}, currentSprint: {id: 's', name: 'S'}},
    disabled: {sprintsSettings: {disableSprints: true}},
    between: {sprintsSettings: {disableSprints: false}, currentSprint: null},
    running: {sprintsSettings: {disableSprints: false}, currentSprint: {id: 's', name: 'S', archived: false}},
  };
  const {client} = recordingClient((_method, url) => {
    if (url.pathname === '/api/agiles')
      return Response.json(Object.keys(boards).map((name) => ({id: name, name, projects: [{shortName: 'YA'}]})));
    const name = url.pathname.split('/').pop()!;
    return name in boards ? Response.json(boards[name]) : undefined;
  });
  assert.deepEqual(await createTrackerAdapter(client).discoverIterations('YA'), {
    targets: [{scopeId: 'running', scopeName: 'running', iterationId: 's', iterationName: 'S'}],
    unavailable: ['missing', 'stringly', 'nullsettings', 'malformed', 'unarchived'].map(
      (name) => `${name}: sprint discovery failed`,
    ),
    withoutCurrent: ['between'],
  });
});

// YA-25 Y4: a board id of `..` would read `/api/` itself; the adapter's shared segment() refuses it as a failed lookup.
test('Y4 a dot-segment board id is a failed sprint lookup, never a request to a collapsed path', async () => {
  const {client, calls} = recordingClient((_method, url) => {
    if (url.pathname === '/api/agiles') return Response.json([{id: '..', name: 'Dots', projects: [{shortName: 'YA'}]}]);
    return Response.json({
      sprintsSettings: {disableSprints: false},
      currentSprint: {id: '1-1', name: 'S', archived: false},
    });
  });
  const discovery = await createTrackerAdapter(client).discoverIterations('YA');
  assert.deepEqual(discovery, {targets: [], unavailable: ['Dots: sprint discovery failed'], withoutCurrent: []});
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/agiles'],
  );
});

test('YA-35 an assignee is its login, with the full name alongside; the client asks for the full name', async () => {
  let fields: string | null = null;
  const user = (login: string, fullName?: string) => ({
    login,
    ...(fullName === undefined ? {} : {fullName}),
    $type: 'User',
  });
  const {client} = recordingClient((_method, url) => {
    if (!url.pathname.startsWith('/api/issues/')) return undefined;
    fields = url.searchParams.get('fields');
    const key = decodeURIComponent(url.pathname.slice('/api/issues/'.length));
    const assignee = {
      'YA-1': user('chris.coulter', 'Chris Coulter'),
      // A display name in `name` must never replace the login that queries need.
      'YA-2': {...user('zoe7', 'Zoë Ångström'), name: 'Zoë Ångström'},
      'YA-3': user('nameless', ''),
      'YA-4': null,
    }[key];
    return Response.json({...issue, idReadable: key, customFields: [{name: 'Assignee', value: assignee}]});
  });
  const adapter = createTrackerAdapter(client);
  const seen = [];
  for (const key of ['YA-1', 'YA-2', 'YA-3', 'YA-4']) {
    const found = await adapter.getIssue(key);
    seen.push([found.workflow.assignee, found.assigneeName]);
  }
  assert.deepEqual(seen, [
    ['chris.coulter', 'Chris Coulter'],
    ['zoe7', 'Zoë Ångström'],
    ['nameless', null],
    [null, null],
  ]);
  assert.match(fields ?? '', /customFields\(name,value\([^)]*\blogin\b[^)]*\bfullName\b/);
  // The CLI's plain field values are unchanged.
  assert.equal((await client.getIssue('YA-1')).fields.Assignee, 'chris.coulter');
});

test('YA-35 F5 a login with single spaces inside is braced whole, as YouTrack takes a value with spaces', async () => {
  const {client, searches} = searchClient(1);
  const adapter = createTrackerAdapter(client);
  const found = await adapter.listIssues({assignee: 'mary smith', unresolved: true, limit: 5});
  assert.equal(found.issues.length, 1);
  assert.deepEqual(searches, [{query: 'project: YA for: {mary smith} #Unresolved sort by: updated desc', top: '6'}]);
});
