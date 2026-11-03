import assert from 'node:assert/strict';
import test from 'node:test';
import {TrackerFailure, type IssueFilter, type TrackerFailureKind, type TrackerIssue} from '../../../src/tracker.ts';
import {
  createVoiceTracker,
  DEFAULT_ASSIGNEE_SCAN_LIMIT,
  distinctAssignees,
  issueFilter,
  meaningfulText,
  voiceFailure,
  VoiceTrackerFailure,
  type VoiceTrackerPort,
} from '../../../src/voice/binding/voice-tracker.ts';
import type {VoiceIssueQuery} from '../../../src/voice/core/types.ts';
import {YouTrackError} from '../../../src/youtrack/transport.ts';

const ISSUE: TrackerIssue = {
  id: '2-1',
  key: 'H-1',
  summary: 'Fix the kitchen tap',
  description: 'It drips.',
  url: 'https://household.youtrack.example/issue/H-1',
  updated: 1_757_000_000_000,
  workflow: {state: 'Open', role: null, assignee: 'household', recommendedModel: null, subsystem: null},
};

interface PortCall {
  method: keyof VoiceTrackerPort;
  args: unknown[];
}

function recordingPort(overrides: Partial<VoiceTrackerPort> = {}): {port: VoiceTrackerPort; calls: PortCall[]} {
  const calls: PortCall[] = [];
  const port: VoiceTrackerPort = {
    listIssues: async (filter) => {
      calls.push({method: 'listIssues', args: [filter]});
      return overrides.listIssues ? overrides.listIssues(filter) : {issues: [ISSUE], complete: true};
    },
    getIssue: async (key) => {
      calls.push({method: 'getIssue', args: [key]});
      return overrides.getIssue ? overrides.getIssue(key) : ISSUE;
    },
    listComments: async (key, limit) => {
      calls.push({method: 'listComments', args: [key, limit]});
      return overrides.listComments ? overrides.listComments(key, limit) : {comments: [], complete: true};
    },
  };
  return {port, calls};
}

test('every query field maps onto the tracker filter, and text always matches any word', async () => {
  const cases: Array<[VoiceIssueQuery, IssueFilter]> = [
    [
      {assignee: 'me', unresolved: true, limit: 50},
      {assignee: 'me', unresolved: true, limit: 50},
    ],
    [
      {assignee: 'me', state: 'In Progress', limit: 50},
      {assignee: 'me', state: 'In Progress', limit: 50},
    ],
    [
      {unresolved: true, limit: 50},
      {unresolved: true, limit: 50},
    ],
    [{limit: 10}, {limit: 10}],
    [
      {text: 'kitchen tap drips', limit: 50},
      {text: 'kitchen tap drips', textMode: 'any', limit: 50},
    ],
    [
      {text: 'the Issue about the Boiler', limit: 50},
      {text: 'Boiler', textMode: 'any', limit: 50},
    ],
    [
      {unresolved: false, limit: 3},
      {unresolved: false, limit: 3},
    ],
    [
      {assignee: {login: 'chris.coulter'}, unresolved: true, limit: 50},
      {assignee: 'chris.coulter', unresolved: true, limit: 50},
    ],
  ];
  for (const [query, expected] of cases) {
    assert.deepEqual(issueFilter(query), expected);
    const {port, calls} = recordingPort();
    await createVoiceTracker(port).listIssues(query);
    assert.deepEqual(calls, [{method: 'listIssues', args: [expected]}]);
  }
});

test('issues and completeness pass straight through, including a capped list', async () => {
  for (const complete of [true, false]) {
    const {port} = recordingPort({listIssues: async () => ({issues: [ISSUE], complete})});
    const result = await createVoiceTracker(port).listIssues({limit: 1});
    assert.deepEqual(result, {issues: [ISSUE], complete});
  }
});

test('getIssue asks for the same key and returns the issue unchanged', async () => {
  const {port, calls} = recordingPort();
  assert.deepEqual(await createVoiceTracker(port).getIssue('H-1'), ISSUE);
  assert.deepEqual(calls, [{method: 'getIssue', args: ['H-1']}]);
});

test('comments map field by field, oldest first, with completeness and the limit passed through', async () => {
  const {port, calls} = recordingPort({
    listComments: async () => ({
      comments: [
        {authorName: 'Owner', created: 3000, text: 'third'},
        {authorName: 'Household', created: 1000, text: 'first'},
        {authorName: 'Owner', created: 2000, text: 'second, a'},
        {authorName: 'Owner', created: 2000, text: 'second, b'},
      ],
      complete: false,
    }),
  });
  const result = await createVoiceTracker(port).listComments('H-1', 4);
  assert.deepEqual(calls, [{method: 'listComments', args: ['H-1', 4]}]);
  assert.deepEqual(result, {
    comments: [
      {authorName: 'Household', created: 1000, text: 'first'},
      {authorName: 'Owner', created: 2000, text: 'second, a'},
      {authorName: 'Owner', created: 2000, text: 'second, b'},
      {authorName: 'Owner', created: 3000, text: 'third'},
    ],
    complete: false,
  });
});

test('every failure kind keeps its kind, except validation on one issue, which is not-found', async () => {
  const kinds: TrackerFailureKind[] = [
    'validation',
    'not-found',
    'permission',
    'conflict',
    'unsupported',
    'unavailable',
    'unknown',
  ];
  for (const kind of kinds) {
    const fail = async (): Promise<never> => {
      throw new TrackerFailure(kind, `simulated ${kind}`);
    };
    const tracker = createVoiceTracker(recordingPort({listIssues: fail, getIssue: fail, listComments: fail}).port);
    const expectedForIssue = kind === 'validation' ? 'not-found' : kind;
    await assert.rejects(tracker.listIssues({limit: 1}), (error: unknown) => {
      assert.ok(error instanceof VoiceTrackerFailure);
      assert.equal(error.kind, kind);
      assert.equal(error.message, `simulated ${kind}`);
      return true;
    });
    await assert.rejects(tracker.getIssue('UM-2'), {kind: expectedForIssue});
    await assert.rejects(tracker.listComments('UM-2', 5), {kind: expectedForIssue});
  }
});

test('an HTTP failure keeps its status; anything that is not a TrackerFailure is unavailable, without its message', () => {
  const http = voiceFailure(new YouTrackError(401, '', 'YouTrack HTTP 401', 'permission'), false, (text) => text);
  assert.equal(http.kind, 'permission');
  assert.equal(http.status, 401);

  const odd = voiceFailure(new TypeError('Atza|SECRET in a URL'), true, (text) => text);
  assert.equal(odd.kind, 'unavailable');
  assert.equal(odd.message.includes('SECRET'), false);
  assert.equal(odd.status, undefined);

  const forged = new TrackerFailure('unknown', 'x');
  Object.defineProperty(forged, 'kind', {value: 'exploded'});
  assert.equal(voiceFailure(forged, false, (text) => text).kind, 'unavailable');
});

test('failure messages go through the redactor', async () => {
  const fail = async (): Promise<never> => {
    throw new TrackerFailure('unavailable', 'token Atza|SECRET echoed');
  };
  const tracker = createVoiceTracker(recordingPort({getIssue: fail}).port, {
    redact: (text) => text.replaceAll('Atza|SECRET', '[token]'),
  });
  await assert.rejects(tracker.getIssue('H-1'), {message: 'token [token] echoed'});
});

test('after the signal fires no call reaches the port', async () => {
  const controller = new AbortController();
  const {port, calls} = recordingPort();
  const tracker = createVoiceTracker(port, {signal: controller.signal});
  await tracker.getIssue('H-1');
  controller.abort();
  await assert.rejects(tracker.listIssues({limit: 1}), {kind: 'unavailable'});
  await assert.rejects(tracker.getIssue('H-1'), {kind: 'unavailable'});
  await assert.rejects(tracker.listComments('H-1', 1), {kind: 'unavailable'});
  await assert.rejects(tracker.listAssignees(5), {kind: 'unavailable'});
  assert.deepEqual(
    calls.map((call) => call.method),
    ['getIssue'],
  );
});

test('search text keeps only the words the core ranks by, as spoken; with none left nothing is asked', async () => {
  assert.equal(meaningfulText('find issue about car tax'), 'find car tax');
  assert.equal(meaningfulText('the issue about the boiler'), 'boiler');
  assert.equal(meaningfulText('  Zoë’s   ISSUES called  café '), 'Zoë’s café');
  assert.equal(meaningfulText('the one called issue'), '');
  assert.equal(issueFilter({text: 'the issue', limit: 5}), null);

  const {port, calls} = recordingPort();
  assert.deepEqual(await createVoiceTracker(port).listIssues({text: 'an issue about the one', limit: 50}), {
    issues: [],
    complete: true,
  });
  assert.deepEqual(calls, [], 'a search with no meaningful word never becomes a search for everything');
});

test('a server 400 or 422 naming one issue is unavailable with its status; only a local refusal is not-found', async () => {
  for (const status of [400, 422]) {
    const fail = async (): Promise<never> => {
      throw new YouTrackError(status, '', `YouTrack HTTP ${status}`, 'validation');
    };
    const lines: unknown[] = [];
    const tracker = createVoiceTracker(recordingPort({getIssue: fail, listComments: fail, listIssues: fail}).port, {
      log: (level, event, fields) => lines.push({level, event, fields}),
      requestId: 'req-1',
    });
    await assert.rejects(tracker.getIssue('H-1'), {kind: 'unavailable', status});
    await assert.rejects(tracker.listComments('H-1', 5), {kind: 'unavailable', status});
    await assert.rejects(tracker.listIssues({limit: 5}), {kind: 'unavailable', status});
    assert.deepEqual(lines[0], {
      level: 'info',
      event: 'voice.binding.callFailed',
      fields: {requestId: 'req-1', method: 'getIssue', kind: 'unavailable', status},
    });
  }
  const local = async (): Promise<never> => {
    throw new TrackerFailure('validation', 'Issue must belong to configured project H');
  };
  await assert.rejects(createVoiceTracker(recordingPort({getIssue: local}).port).getIssue('YA-1'), {
    kind: 'not-found',
    status: undefined,
  });
});

test('an issue that resolves outside the project is not found, and a key in the project passes', async () => {
  const moved: TrackerIssue = {...ISSUE, id: '2-99', key: 'YA-99', summary: 'Moved out of H'};
  const lookalikes = ['YA-99', 'HH-1', 'H-1a', 'H-', 'h-1'];
  for (const key of lookalikes) {
    const tracker = createVoiceTracker(recordingPort({getIssue: async () => ({...moved, key})}).port, {project: 'H'});
    await assert.rejects(tracker.getIssue('H-9'), {kind: 'not-found'}, key);
  }
  const tracker = createVoiceTracker(recordingPort().port, {project: 'H'});
  assert.equal((await tracker.getIssue('H-1')).key, 'H-1');
});

test('a link check that refuses stops the call before the port, keeping its kind', async () => {
  const {port, calls} = recordingPort();
  const tracker = createVoiceTracker(port, {
    beforeCall: async () => {
      throw new TrackerFailure('permission', 'not the household account');
    },
  });
  await assert.rejects(tracker.listIssues({limit: 1}), {kind: 'permission'});
  await assert.rejects(tracker.getIssue('H-1'), {kind: 'permission'});
  assert.deepEqual(calls, []);
});

function assigned(key: string, login: string | null, name?: string | null): TrackerIssue {
  const issue: TrackerIssue = {...ISSUE, key, workflow: {...ISSUE.workflow, assignee: login}};
  return name === undefined ? issue : {...issue, assigneeName: name};
}

test('YA-35: listAssignees reads unresolved issues once and returns each assignee once, first seen first', async () => {
  const issues = [
    assigned('H-1', 'ccoulter', 'Chris Coulter'),
    assigned('H-2', null),
    assigned('H-3', 'zoe7', 'Zoë Ångström'),
    assigned('H-4', 'ccoulter', 'Chris Coulter'),
    assigned('H-5', 'household', 'The Household'),
  ];
  const {port, calls} = recordingPort({listIssues: async () => ({issues, complete: true})});
  const logs: Array<{event: string; fields: unknown}> = [];
  const tracker = createVoiceTracker(port, {log: (_level, event, fields) => logs.push({event, fields})});
  assert.deepEqual(await tracker.listAssignees(10), {
    people: [
      {login: 'ccoulter', name: 'Chris Coulter'},
      {login: 'zoe7', name: 'Zoë Ångström'},
      {login: 'household', name: 'The Household'},
    ],
    complete: true,
  });
  assert.deepEqual(calls, [{method: 'listIssues', args: [{unresolved: true, limit: DEFAULT_ASSIGNEE_SCAN_LIMIT}]}]);
  // The log line counts people; it never names them.
  const line = JSON.stringify(logs);
  for (const secret of ['ccoulter', 'Chris', 'zoe7', 'household']) assert.ok(!line.includes(secret), secret);
});

test('YA-35: listAssignees is capped at its limit, and incomplete when capped or when the issues were', async () => {
  const issues = [assigned('H-1', 'a1', 'Ann'), assigned('H-2', 'b1', 'Bea'), assigned('H-3', 'c1', 'Cal')];
  const capped = createVoiceTracker(recordingPort({listIssues: async () => ({issues, complete: true})}).port);
  assert.deepEqual(await capped.listAssignees(2), {
    people: [
      {login: 'a1', name: 'Ann'},
      {login: 'b1', name: 'Bea'},
    ],
    complete: false,
  });
  assert.equal((await capped.listAssignees(3)).complete, true);

  const {port, calls} = recordingPort({listIssues: async () => ({issues, complete: false})});
  const partial = createVoiceTracker(port, {assigneeScanLimit: 3});
  assert.deepEqual(await partial.listAssignees(10), {
    people: [
      {login: 'a1', name: 'Ann'},
      {login: 'b1', name: 'Bea'},
      {login: 'c1', name: 'Cal'},
    ],
    complete: false,
  });
  assert.deepEqual(calls[0].args, [{unresolved: true, limit: 3}]);
});

test("YA-35 F1: every assignee is returned with the tracker's name as it is, unsayable ones counted for the core", () => {
  const found = distinctAssignees(
    [
      assigned('H-1', 'nameless'),
      assigned('H-2', 'blank', '  '),
      assigned('H-3', 'mailer', 'someone@example.com'),
      assigned('H-4', 'ok', ' Robin Hale '),
      assigned('H-5', 'nameless', 'Late Name'),
      assigned('H-6', 'CCoulter', 'ccoulter'),
    ],
    10,
  );
  assert.deepEqual(found, {
    people: [
      {login: 'nameless', name: ''},
      {login: 'blank', name: ''},
      {login: 'mailer', name: 'someone@example.com'},
      {login: 'ok', name: 'Robin Hale'},
      {login: 'CCoulter', name: 'ccoulter'},
    ],
    overLimit: false,
    unnamed: 4,
  });
});

test('YA-35: a listAssignees failure keeps its kind', async () => {
  const {port} = recordingPort({
    listIssues: async () => {
      throw new TrackerFailure('permission', 'no access');
    },
  });
  await assert.rejects(createVoiceTracker(port).listAssignees(5), {kind: 'permission'});
});
