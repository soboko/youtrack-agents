import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {run} from '../../src/cli/run.ts';
import {createClient, loadConfig} from '../../client.ts';
import {AdminStepFailure} from '../../src/youtrack/admin.ts';

// Admin commands make several requests. These tests fake the transport, not the admin methods, so a failure
// between two requests is exercised the way it happens against the provider.
type Route = (method: string, url: URL) => Response;

const config = loadConfig(
  {},
  {
    environment: {
      YOUTRACK_URL: 'https://example.invalid',
      YOUTRACK_TOKEN: 'synthetic-test-token',
      YOUTRACK_PROJECT: 'PRJ',
      YOUTRACK_BOARD: 'Main',
      AI_MODEL: 'test-model',
      AI_SESSION_ID: 'test-session',
    },
    files: [],
  },
);

async function cli(argv: string[], route: Route, configuration = config) {
  const output: string[] = [];
  const errors: string[] = [];
  const requests: string[] = [];
  const code = await run(argv, {
    loadConfig: () => configuration,
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      errors.push(text);
    },
    createClient: (identity, options) =>
      createClient(identity, {
        ...options,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const method = init?.method ?? 'GET';
          const response = route(method, url);
          requests.push(`${method} ${url.pathname} ${response.status}`);
          return response;
        },
      }),
  });
  return {code, output: output.join(''), errors: errors.join(''), requests};
}

const noBoardConfig = loadConfig(
  {},
  {
    environment: {
      YOUTRACK_URL: 'https://example.invalid',
      YOUTRACK_TOKEN: 'synthetic-test-token',
      YOUTRACK_PROJECT: 'PRJ',
      AI_MODEL: 'test-model',
      AI_SESSION_ID: 'test-session',
    },
    files: [],
  },
);

const empty = (status: number) => new Response('', {status});

interface Board {
  id: string;
  name: string;
  projects?: {shortName: string}[];
  swimlaneSettings?: {values: {name: string}[]};
}

/** Subsystem admin: one Subsystem bundle, and the given boards. `swimlane` answers the swimlane POST. */
function subsystemRoute(options: {boards?: Board[] | number; swimlane?: number} = {}) {
  return (method: string, url: URL): Response => {
    const path = url.pathname;
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/admin/projects/0-1/customFields')) {
      return Response.json([
        {id: 'f1', canBeEmpty: true, field: {name: 'Subsystem', fieldType: {id: 'ownedField[1]'}}, bundle: {id: 'b1'}},
      ]);
    }
    if (path.endsWith('/bundles/ownedField/b1/values'))
      return method === 'GET' ? Response.json([]) : Response.json({id: 'v1'});
    const boards = options.boards ?? [{id: 'a1', name: 'Main', projects: [{shortName: 'PRJ'}]}];
    if (path.endsWith('/agiles')) return typeof boards === 'number' ? empty(boards) : Response.json(boards);
    if (/\/agiles\/[^/]+\/swimlaneSettings\/values$/.test(path)) {
      const status = options.swimlane ?? 200;
      return status === 200 ? Response.json({id: 'l1'}) : empty(status);
    }
    return empty(404);
  };
}

const posts = (requests: string[]) => requests.filter((request) => request.startsWith('POST'));

// YA-25 B15: the board is resolved before the bundle write, so a missing or unreadable board writes nothing.
test('subsystems add: a failed or missing board rejects before the bundle write', async () => {
  const missing: Board[] = [{id: 'a9', name: 'Other', projects: [{shortName: 'PRJ'}]}];
  for (const boards of [503, missing]) {
    const result = await cli(['subsystems', 'add', 'Radar', '--json'], subsystemRoute({boards}));
    assert.equal(result.code, 1);
    const envelope = JSON.parse(result.output);
    assert.equal(envelope.status, 'rejected', result.output);
    assert.equal(envelope.message, undefined);
    assert.deepEqual(posts(result.requests), []);
  }
});

// YA-25 B15: each admin write is a named step, so the envelope says which one landed and which one may have.
test('subsystems add: a confirmed bundle write, then a failed swimlane write, names both steps', async () => {
  const lost = await cli(['subsystems', 'add', 'Radar', '--json'], subsystemRoute({swimlane: 503}));
  assert.equal(lost.code, 1);
  assert.deepEqual(JSON.parse(lost.output), {
    version: 1,
    status: 'unknown',
    applied: ['add bundle value "Radar"'],
    pending: [],
    uncertain: ['add swimlane "Radar" on Main'],
    error: 'YouTrack HTTP 503',
    message: '1 write(s) confirmed, 1 write(s) without a confirmed outcome before failure; reconcile before retrying',
  });

  const refused = await cli(['subsystems', 'add', 'Radar', '--json'], subsystemRoute({swimlane: 403}));
  const envelope = JSON.parse(refused.output);
  assert.equal(envelope.status, 'partial');
  assert.deepEqual(envelope.applied, ['add bundle value "Radar"']);
  assert.deepEqual(envelope.pending, ['add swimlane "Radar" on Main']);
  assert.deepEqual(envelope.uncertain, []);
  assert.equal(envelope.message, '1 write(s) confirmed before failure; reconcile before retrying');
});

test('subsystems add in human mode prints the steps and the confirmed-write count on stderr', async () => {
  const result = await cli(['subsystems', 'add', 'Radar', '--quiet'], subsystemRoute({swimlane: 403}));
  assert.equal(result.code, 1);
  assert.equal(result.output, '');
  assert.equal(
    result.errors,
    '[yt] YouTrack HTTP 403\n' +
      '  applied: add bundle value "Radar"\n' +
      '  pending: add swimlane "Radar" on Main\n' +
      '[yt] 1 write(s) confirmed before failure; reconcile before retrying\n',
  );
});

// YA-8 NF4: --board picks the board; with none configured, the first board that includes the project is used.
test("subsystems add honours --board, and falls back to the project's first board", async () => {
  const boards: Board[] = [
    {id: 'x1', name: 'Elsewhere', projects: [{shortName: 'OTHER'}]},
    {id: 'a1', name: 'Main', projects: [{shortName: 'PRJ'}]},
    {id: 'a2', name: 'Second', projects: [{shortName: 'PRJ'}]},
  ];
  const named = await cli(['subsystems', 'add', 'Radar', '--board', 'Second', '--json'], subsystemRoute({boards}));
  assert.ok(
    posts(named.requests).includes('POST /api/agiles/a2/swimlaneSettings/values 200'),
    named.requests.join('\n'),
  );
  const unnamed = await cli(['subsystems', 'add', 'Radar', '--json'], subsystemRoute({boards}), noBoardConfig);
  assert.ok(
    posts(unnamed.requests).includes('POST /api/agiles/a1/swimlaneSettings/values 200'),
    unnamed.requests.join('\n'),
  );
});

test('sprint backlog: a saved query written, then a refused board attach, is partial', async () => {
  const result = await cli(['sprint', 'backlog', '#Unresolved', '--board', 'Main', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/admin/projects/0-1')) return Response.json({name: 'Proj', team: {name: 'Proj Team'}});
    if (path.endsWith('/groups')) return Response.json([{id: 'g1', name: 'Proj Team'}]);
    if (path.endsWith('/savedQueries') && method === 'GET') return Response.json([]);
    if (path.endsWith('/savedQueries') && method === 'POST') return Response.json({id: 'q1', name: 'Main backlog'});
    if (path.endsWith('/agiles/a1') && method === 'POST') return empty(400);
    return empty(404);
  });
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.status, 'partial');
  assert.match(envelope.message, /^1 write\(s\) confirmed before failure/);
  assert.deepEqual(
    result.requests.filter((request) => request.startsWith('POST')),
    ['POST /api/savedQueries 200', 'POST /api/agiles/a1 400'],
  );
});

test('sprint create and rename: a 200 without an id and name is an unknown write', async () => {
  const create = await cli(['sprint', 'create', 'Sprint 9', '--board', 'Main', '--json'], (method, url) => {
    if (url.pathname.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (url.pathname.endsWith('/agiles/a1/sprints') && method === 'POST') return empty(200);
    return empty(404);
  });
  assert.equal(create.code, 1);
  const created = JSON.parse(create.output);
  assert.equal(created.status, 'unknown');
  assert.match(created.error, /Missing sprint receipt/);

  const rename = await cli(['sprint', 'rename', 'Old', 'New', '--board', 'Main', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/agiles')) return Response.json([{id: 'a1', name: 'Main'}]);
    if (path.endsWith('/agiles/a1') && method === 'GET') {
      return Response.json({name: 'Main', sprintsSettings: {disableSprints: false}, currentSprint: null});
    }
    if (path.endsWith('/agiles/a1/sprints') && method === 'GET') {
      return Response.json([{id: 's1', name: 'Old', archived: false, start: null, finish: null}]);
    }
    if (path.endsWith('/agiles/a1/sprints/s1/issues')) return Response.json([]);
    if (path.endsWith('/agiles/a1/sprints/s1') && method === 'POST') return Response.json({id: 's1'});
    return empty(404);
  });
  assert.equal(rename.code, 1);
  assert.equal(JSON.parse(rename.output).status, 'unknown');
});

test('a plain Error before any write, or a write the provider refused, is still rejected', async () => {
  const noField = await cli(['subsystems', 'add', 'Radar', '--json'], (_method, url) => {
    if (url.pathname.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (url.pathname.endsWith('/customFields')) return Response.json([]);
    return empty(404);
  });
  assert.equal(noField.code, 1);
  assert.deepEqual(JSON.parse(noField.output), {
    version: 1,
    status: 'rejected',
    error: 'no Subsystem field on the project',
  });
  assert.ok(noField.requests.every((request) => request.startsWith('GET')));

  const refused = await cli(['sprint', 'enable', '--board', 'Main', '--json'], (method, url) => {
    if (url.pathname.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (url.pathname.endsWith('/agiles/a1') && method === 'POST') return empty(403);
    return empty(404);
  });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.output), {version: 1, status: 'rejected', error: 'YouTrack HTTP 403'});
});

test('a write answered without a body, then a plain Error, is unknown rather than rejected', async () => {
  const result = await cli(['sprint', 'backlog', '#Unresolved', '--board', 'Main', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/admin/projects/0-1')) return Response.json({name: 'Proj', team: {name: 'Proj Team'}});
    if (path.endsWith('/groups')) return Response.json([{id: 'g1', name: 'Proj Team'}]);
    if (path.endsWith('/savedQueries') && method === 'GET') return Response.json([]);
    // The saved query may exist now, but the reply has no id, so reading it throws a TypeError.
    if (path.endsWith('/savedQueries') && method === 'POST') return empty(200);
    return empty(404);
  });
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.status, 'unknown');
  assert.equal(envelope.message, '1 write(s) without a confirmed outcome before failure; reconcile before retrying');
});

// YA-25 B15: setBacklog and addEnumField report their writes as steps too.
test('sprint backlog and field add name the step that failed and the steps not attempted', async () => {
  const backlog = await cli(['sprint', 'backlog', '#Unresolved', '--board', 'Main', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/admin/projects/0-1')) return Response.json({name: 'Proj', team: {name: 'Proj Team'}});
    if (path.endsWith('/groups')) return Response.json([{id: 'g1', name: 'Proj Team'}]);
    if (path.endsWith('/savedQueries') && method === 'GET') return Response.json([]);
    if (path.endsWith('/savedQueries') && method === 'POST') return Response.json({id: 'q1', name: 'Main backlog'});
    if (path.endsWith('/agiles/a1') && method === 'POST') return empty(400);
    return empty(404);
  });
  const refused = JSON.parse(backlog.output);
  assert.equal(refused.status, 'partial');
  assert.deepEqual(refused.applied, ['create saved search "Main backlog"']);
  assert.deepEqual(refused.pending, ['attach backlog to "Main"']);
  assert.deepEqual(refused.uncertain, []);

  const field = await cli(['field', 'add', 'Tier', '--values', 'a,b', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/bundles/enum') && method === 'GET') return Response.json([]);
    if (path.endsWith('/customFields') && method === 'GET') return Response.json([]);
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/bundles/enum') && method === 'POST') return Response.json({id: 'e1', name: 'Tier'});
    if (path.endsWith('/customFieldSettings/customFields') && method === 'POST') return empty(502);
    return empty(404);
  });
  assert.equal(field.code, 1);
  const lost = JSON.parse(field.output);
  assert.equal(lost.status, 'unknown');
  assert.deepEqual(lost.applied, ['create enum bundle "Tier"']);
  assert.deepEqual(lost.uncertain, ['create field "Tier"']);
  assert.deepEqual(lost.pending, ['attach field "Tier" to PRJ']);
  // Every lookup came first, so the failure point is the second write, not a read between writes.
  assert.deepEqual(posts(field.requests), [
    'POST /api/admin/customFieldSettings/bundles/enum 200',
    'POST /api/admin/customFieldSettings/customFields 502',
  ]);
});

// YA-8 NF2: a receipt that fails its check is not a confirmed write, even though the transport parsed a body.
test('a missing or malformed receipt is never counted as a confirmed write', async () => {
  const create = await cli(['sprint', 'create', 'Sprint 9', '--board', 'Main', '--json'], (method, url) => {
    if (url.pathname.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (url.pathname.endsWith('/agiles/a1/sprints') && method === 'POST') return Response.json({});
    return empty(404);
  });
  const sprint = JSON.parse(create.output);
  assert.equal(sprint.status, 'unknown');
  assert.equal(sprint.message, '1 write(s) without a confirmed outcome before failure; reconcile before retrying');

  const set = await cli(['set', 'PRJ-1', 'Priority=Major', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/admin/projects/0-1/customFields')) {
      return Response.json([
        {id: 'p', canBeEmpty: true, field: {name: 'Priority', fieldType: {id: 'enum[1]'}}, bundle: {id: 'bp'}},
      ]);
    }
    if (path.endsWith('/bundles/enum/bp/values')) return Response.json([{name: 'Major', ordinal: 0}]);
    if (path.endsWith('/issues/PRJ-1') && method === 'POST') return Response.json({summary: 'no id'});
    return empty(404);
  });
  const malformed = JSON.parse(set.output);
  assert.equal(malformed.status, 'unknown');
  assert.doesNotMatch(malformed.message, /confirmed before/);
  assert.match(malformed.message, /^1 write\(s\) without a confirmed outcome/);
});

// YA-25 B15: the steps an admin command reports decide its status, so the envelope never contradicts its own arrays.
test('an admin step failure is rendered with its steps, and its status follows them', async () => {
  const output: string[] = [];
  const code = await run(['subsystems', 'add', 'Radar', '--json'], {
    loadConfig: () => config,
    stdout: (text) => {
      output.push(text);
    },
    createClient: (identity, options) => {
      const client = createClient(identity, options);
      client.addSubsystem = async () => {
        throw new AdminStepFailure(new Error('receipt unreadable'), {
          applied: ['add bundle value "Radar"'],
          pending: [],
          uncertain: ['add swimlane "Radar" on Main'],
        });
      };
      return client;
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output.join('')), {
    version: 1,
    status: 'unknown',
    applied: ['add bundle value "Radar"'],
    pending: [],
    uncertain: ['add swimlane "Radar" on Main'],
    error: 'receipt unreadable',
  });
});

// YA-25 B15: an admin write whose reply has no id may still have created the entity; its outcome is unknown.
test('field add: a bundle created without a receipt is uncertain, and nothing is attached with a missing id', async () => {
  const result = await cli(['field', 'add', 'Tier', '--values', 'a,b', '--json'], (method, url) => {
    const path = url.pathname;
    if (method === 'GET' && path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (method === 'GET') return Response.json([]);
    if (path.endsWith('/bundles/enum')) return Response.json({name: 'Tier'});
    return Response.json({id: 'x'});
  });
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.status, 'unknown');
  assert.deepEqual(envelope.applied, []);
  assert.deepEqual(envelope.uncertain, ['create enum bundle "Tier"']);
  assert.deepEqual(envelope.pending, ['create field "Tier"', 'attach field "Tier" to PRJ']);
  // YA-25 F2: the receipt-less bundle write is not described as confirmed anywhere in the envelope.
  assert.equal(envelope.message, '1 write(s) without a confirmed outcome before failure; reconcile before retrying');
  assert.deepEqual(posts(result.requests), ['POST /api/admin/customFieldSettings/bundles/enum 200']);
});

// YA-25 B2: ids in admin paths come from the server; each stays one encoded segment, and dot segments are refused.
test('admin paths encode provider ids, so a hostile id cannot reach another resource', async (t) => {
  const hostile = '../../admin/users/me?$top=1#';
  const raw: string[] = [];
  const route =
    (ids: {board?: string; bundle?: string; project?: string; query?: string}) => (method: string, url: URL) => {
      if (method !== 'GET') raw.push(`${method} ${url.pathname}${url.search.replace(/[?&]fields=[^&]*/, '')}`);
      const path = url.pathname;
      const board = {id: ids.board ?? 'a1', name: 'Main', projects: [{shortName: 'PRJ'}]};
      if (path.endsWith('/admin/projects')) return Response.json([{id: ids.project ?? '0-1', shortName: 'PRJ'}]);
      if (method === 'GET' && path.endsWith('/customFields') && path.includes('/admin/projects/')) {
        return Response.json([
          {
            id: 'f1',
            canBeEmpty: true,
            field: {name: 'Subsystem', fieldType: {id: 'ownedField[1]'}},
            bundle: {id: ids.bundle ?? 'b1'},
          },
        ]);
      }
      if (path.endsWith('/agiles')) return Response.json([board]);
      if (method === 'GET' && path.endsWith('/savedQueries'))
        return Response.json([{id: ids.query ?? 'q1', name: 'Main backlog'}]);
      if (method === 'GET' && path.endsWith('/admin/customFieldSettings/bundles/enum')) {
        return Response.json([{id: ids.bundle ?? 'e1', name: 'Tier', values: []}]);
      }
      if (method === 'GET')
        return Response.json(path.includes('/admin/projects/') && !path.endsWith('/customFields') ? {name: 'P'} : []);
      return Response.json({id: 'r1', name: 'Sprint 9'});
    };
  const cases = [
    {name: 'board id', args: ['sprint', 'create', 'Sprint 9', '--board', 'Main'], ids: {board: hostile}},
    {name: 'board id (enable)', args: ['sprint', 'enable', '--board', 'Main'], ids: {board: hostile}},
    {name: 'bundle id', args: ['subsystems', 'add', 'Radar'], ids: {bundle: hostile}},
    {name: 'project id', args: ['field', 'add', 'Tier', '--values', 'a'], ids: {project: hostile, bundle: hostile}},
    {name: 'saved search id', args: ['sprint', 'backlog', 'q', '--board', 'Main'], ids: {query: hostile}},
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
      raw.length = 0;
      await cli([...example.args, '--json'], route(example.ids));
      assert.ok(raw.length > 0, 'no write was attempted');
      for (const request of raw) assert.doesNotMatch(request, /\/users\/|\?\$top|#/, request);
      const encoded = raw.filter((request) => request.includes('..%2F..%2Fadmin%2Fusers%2Fme%3F%24top%3D1%23'));
      assert.ok(encoded.length > 0, raw.join('\n'));
    });
  }
  await t.test('a dot-segment id is refused before any write', async () => {
    raw.length = 0;
    const result = await cli(['sprint', 'create', 'Sprint 9', '--board', 'Main', '--json'], route({board: '..'}));
    const envelope = JSON.parse(result.output);
    assert.equal(envelope.status, 'rejected');
    assert.match(envelope.error, /Invalid path segment/);
    assert.deepEqual(raw, []);
  });
});

// YA-25 Y5: an empty 2xx carries no receipt, so an admin write answered that way is uncertain, never applied.
test('admin writes answered 2xx with an empty body are uncertain, and the command fails', async () => {
  const subsystems = await cli(['subsystems', 'add', 'Radar', '--json'], (method, url) => {
    if (method === 'POST') return empty(200);
    return subsystemRoute()(method, url);
  });
  assert.equal(subsystems.code, 1);
  const lost = JSON.parse(subsystems.output);
  assert.equal(lost.status, 'unknown');
  assert.deepEqual(lost.applied, []);
  assert.deepEqual(lost.uncertain, ['add bundle value "Radar"']);
  assert.deepEqual(lost.pending, ['add swimlane "Radar" on Main']);
  assert.deepEqual(posts(subsystems.requests), [
    'POST /api/admin/customFieldSettings/bundles/ownedField/b1/values 200',
  ]);

  // The swimlane write needs its own receipt too, after a bundle value that had one.
  const lane = await cli(['subsystems', 'add', 'Radar', '--json'], (method, url) => {
    if (method === 'POST' && url.pathname.includes('/swimlaneSettings/')) return empty(200);
    return subsystemRoute()(method, url);
  });
  const laneEnvelope = JSON.parse(lane.output);
  assert.equal(laneEnvelope.status, 'unknown');
  assert.deepEqual(laneEnvelope.applied, ['add bundle value "Radar"']);
  assert.deepEqual(laneEnvelope.uncertain, ['add swimlane "Radar" on Main']);

  const enable = await cli(['sprint', 'enable', '--board', 'Main', '--json'], (method, url) => {
    if (url.pathname.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (method === 'POST') return empty(200);
    return empty(404);
  });
  assert.equal(enable.code, 1);
  assert.equal(JSON.parse(enable.output).status, 'unknown');
});

// YA-25 Y5: a backlog attach whose read-back shows another backlog was not applied, and nothing is left "pending".
test('sprint backlog: an attach the read-back contradicts is uncertain, not applied', async () => {
  const result = await cli(['sprint', 'backlog', '#Unresolved', '--board', 'Main', '--json'], (method, url) => {
    const path = url.pathname;
    if (path.endsWith('/agiles') && method === 'GET') return Response.json([{id: 'a1', name: 'Main'}]);
    if (path.endsWith('/admin/projects')) return Response.json([{id: '0-1', shortName: 'PRJ'}]);
    if (path.endsWith('/admin/projects/0-1')) return Response.json({name: 'Proj', team: {name: 'Proj Team'}});
    if (path.endsWith('/groups')) return Response.json([{id: 'g1', name: 'Proj Team'}]);
    if (path.endsWith('/savedQueries') && method === 'GET') return Response.json([]);
    if (path.endsWith('/savedQueries') && method === 'POST') return Response.json({id: 'q1', name: 'Main backlog'});
    if (path.endsWith('/agiles/a1') && method === 'POST') return Response.json({id: 'a1'});
    if (path.endsWith('/agiles/a1') && method === 'GET') return Response.json({backlog: null});
    return empty(404);
  });
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.status, 'unknown');
  assert.deepEqual(envelope.applied, ['create saved search "Main backlog"']);
  assert.deepEqual(envelope.uncertain, ['attach backlog to "Main"']);
  assert.deepEqual(envelope.pending, []);
  assert.match(envelope.error, /backlog did not attach/);
  assert.equal(
    envelope.message,
    '1 write(s) confirmed, 1 write(s) without a confirmed outcome before failure; reconcile before retrying',
  );
});
