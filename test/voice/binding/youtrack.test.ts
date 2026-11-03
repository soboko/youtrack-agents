import assert from 'node:assert/strict';
import test from 'node:test';
import {inspect} from 'node:util';
import {loadConfig} from '../../../src/config.ts';
import {
  bindingSettings,
  createYouTrackBinding,
  DEFAULT_VOICE_PROJECT,
  redactorFor,
  type TrackerFactoryOptions,
} from '../../../src/voice/binding/youtrack.ts';
import {idTag} from '../../../src/voice/alexa/log.ts';
import {converse, DEFAULT_POLICY} from '../../../src/voice/core/converse.ts';
import {MemoryStateStore} from '../../../src/voice/core/fakes.ts';
import {createTrackerAdapter} from '../../../src/youtrack/adapter.ts';
import {createClient} from '../../../src/youtrack/client.ts';
import {captureLog, deferred} from '../alexa/helpers.ts';
import {createFakeYouTrack, FAKE_BASE_URL, type FakeAccount, type FakeIssue} from './fake-youtrack.ts';

const HOUSEHOLD_TOKEN = 'Atza|HOUSEHOLD-LINK-SECRET-a1b2c3d4e5';
const MEMBER_TOKEN = 'Atza|MEMBER-LINK-SECRET-f6g7h8i9j0';
const REVOKED_TOKEN = 'Atza|REVOKED-LINK-SECRET-k1l2m3n4o5';

const HOUSEHOLD: FakeAccount = {login: 'homeacct', fullName: 'Household'};
const MEMBER: FakeAccount = {login: 'sam', fullName: 'Sam'};

const ISSUES: FakeIssue[] = [
  {
    key: 'H-1',
    summary: 'Fix the kitchen tap',
    state: 'Open',
    assignee: 'homeacct',
    assigneeName: 'Household',
    updated: 5000,
  },
  {key: 'H-2', summary: 'Book the boiler service', state: 'In Progress', assignee: 'homeacct', updated: 4000},
  {key: 'H-3', summary: 'Renew the car tax', state: 'Open', assignee: 'sam', assigneeName: 'Sam Okafor', updated: 3000},
  {key: 'H-4', summary: 'Tap washers bought', state: 'Done', assignee: 'homeacct', resolved: 2500, updated: 2500},
  {key: 'YA-9', summary: 'Agent work: kitchen tap parser', state: 'Open', assignee: 'homeacct', updated: 9000},
  {
    key: 'H-5',
    summary: 'Clear the gutters',
    state: 'Open',
    assignee: null,
    updated: 1000,
    comments: [
      {author: 'owner', fullName: 'Chris', created: 1_757_000_000_000, text: 'Ladder is in the shed.'},
      {author: 'sam', fullName: 'Sam', created: 1_757_000_100_000, text: 'Done the front.'},
    ],
  },
];

function fixture(options: Partial<TrackerFactoryOptions> = {}) {
  const youtrack = createFakeYouTrack({
    accounts: new Map([
      [HOUSEHOLD_TOKEN, HOUSEHOLD],
      [MEMBER_TOKEN, MEMBER],
    ]),
    issues: ISSUES,
  });
  const logs = captureLog();
  const binding = createYouTrackBinding({
    settings: bindingSettings({YOUTRACK_URL: FAKE_BASE_URL}),
    log: logs.log,
    fetch: youtrack.fetch,
    now: () => 0,
    ...options,
  });
  return {youtrack, logs, trackerFor: binding.trackerFor, checkLink: binding.checkLink};
}

function voiceRequests(requests: ReturnType<typeof createFakeYouTrack>['requests']) {
  return requests.filter((request) => request.path !== '/api/users/me');
}

test('settings: YOUTRACK_URL is required and must be secure; the project defaults to H and must be a key', () => {
  assert.deepEqual(bindingSettings({YOUTRACK_URL: `${FAKE_BASE_URL}/`}), {baseUrl: FAKE_BASE_URL, project: 'H'});
  assert.equal(DEFAULT_VOICE_PROJECT, 'H');
  assert.deepEqual(bindingSettings({YOUTRACK_URL: FAKE_BASE_URL, YOUTRACK_PROJECT: 'HOME'}).project, 'HOME');
  assert.deepEqual(bindingSettings({YOUTRACK_URL: FAKE_BASE_URL, YOUTRACK_PROJECT: ' '}).project, 'H');
  assert.throws(() => bindingSettings({}), /YOUTRACK_URL is required/);
  for (const url of ['http://household.youtrack.example', 'https://user:pw@x.example', 'https://x.example/?q=1']) {
    assert.throws(
      () => bindingSettings({YOUTRACK_URL: url}),
      (error: unknown) => error instanceof Error && /must be https/.test(error.message) && !error.message.includes(url),
    );
  }
  for (const project of ['H issues', 'H,YA', '1H', 'H}']) {
    assert.throws(() => bindingSettings({YOUTRACK_URL: FAKE_BASE_URL, YOUTRACK_PROJECT: project}), /short name/);
  }
});

test('every list is scoped to project H, "me" is the credential, and text matches any word', async () => {
  const {youtrack, trackerFor} = fixture();
  const tracker = trackerFor(HOUSEHOLD_TOKEN);

  const mine = await tracker.listIssues({assignee: 'me', unresolved: true, limit: 50});
  assert.deepEqual(
    mine.issues.map((issue) => issue.key),
    ['H-1', 'H-2'],
  );
  assert.equal(mine.complete, true);

  const found = await tracker.listIssues({text: 'kitchen tap', limit: 50});
  assert.deepEqual(
    found.issues.map((issue) => issue.key),
    ['H-1', 'H-4'],
  );

  const queries = voiceRequests(youtrack.requests).map((request) => request.query.query);
  assert.deepEqual(queries, [
    'project: H for: me #Unresolved sort by: updated desc',
    'project: H (summary: "kitchen" or summary: "tap") sort by: updated desc',
  ]);
});

test('YA-35: another person is asked for by login, and the people come from unresolved H issues with full names', async () => {
  const {youtrack, trackerFor} = fixture();
  const tracker = trackerFor(HOUSEHOLD_TOKEN);

  const sams = await tracker.listIssues({assignee: {login: 'sam'}, unresolved: true, limit: 50});
  assert.deepEqual(
    sams.issues.map((issue) => [issue.key, issue.workflow.assignee, issue.assigneeName]),
    [['H-3', 'sam', 'Sam Okafor']],
  );

  // H-4 is resolved, H-5 unassigned and YA-9 in another project: none of them adds a person.
  assert.deepEqual(await tracker.listAssignees(10), {
    people: [
      {login: 'homeacct', name: 'Household'},
      {login: 'sam', name: 'Sam Okafor'},
    ],
    complete: true,
  });
  assert.deepEqual(await tracker.listAssignees(1), {people: [{login: 'homeacct', name: 'Household'}], complete: false});

  const searches = voiceRequests(youtrack.requests).map((request) => [request.query.query, request.query.$top]);
  assert.deepEqual(searches[0][0], 'project: H for: {sam} #Unresolved sort by: updated desc');
  assert.deepEqual(searches[1], ['project: H #Unresolved sort by: updated desc', searches[1][1]]);
  assert.match(voiceRequests(youtrack.requests)[1].query.fields ?? '', /value\([^)]*fullName/);
});

test('a capped list is reported incomplete through the real adapter', async () => {
  const {trackerFor} = fixture();
  const result = await trackerFor(HOUSEHOLD_TOKEN).listIssues({limit: 2});
  assert.deepEqual(
    result.issues.map((issue) => issue.key),
    ['H-1', 'H-2'],
  );
  assert.equal(result.complete, false);
});

test('issues and comments arrive in the voice shapes, comments oldest first with ms timestamps', async () => {
  const {trackerFor} = fixture();
  const tracker = trackerFor(HOUSEHOLD_TOKEN);
  const issue = await tracker.getIssue('H-2');
  assert.equal(issue.summary, 'Book the boiler service');
  assert.equal(issue.workflow.state, 'In Progress');
  assert.equal(issue.workflow.assignee, 'homeacct');
  assert.equal(issue.url, `${FAKE_BASE_URL}/issue/H-2`);

  assert.deepEqual(await tracker.listComments('H-5', 1), {
    comments: [{authorName: 'Chris', created: 1_757_000_000_000, text: 'Ladder is in the shed.'}],
    complete: false,
  });
});

test('an issue outside project H is not found, and no request asks for it', async () => {
  const {youtrack, trackerFor} = fixture();
  const tracker = trackerFor(HOUSEHOLD_TOKEN);
  await assert.rejects(tracker.getIssue('YA-9'), {kind: 'not-found'});
  await assert.rejects(tracker.getIssue('UM-2'), {kind: 'not-found'});
  await assert.rejects(tracker.listComments('YA-9', 5), {kind: 'not-found'});
  await assert.rejects(tracker.getIssue('H-99'), {kind: 'not-found', status: 404});
  assert.deepEqual(
    voiceRequests(youtrack.requests).map((request) => request.path),
    ['/api/issues/H-99'],
  );
});

test('an old H key that YouTrack resolves to an issue now in another project is not found (review K2)', async () => {
  const youtrack = createFakeYouTrack({
    accounts: new Map([[HOUSEHOLD_TOKEN, HOUSEHOLD]]),
    issues: ISSUES,
    override: (request) =>
      request.path === '/api/issues/H-9'
        ? Response.json({
            id: '2-99',
            idReadable: 'YA-99',
            summary: 'Moved out of H',
            description: 'secret',
            created: 1,
            updated: 2,
            customFields: [],
            $type: 'Issue',
          })
        : undefined,
  });
  const {trackerFor} = createYouTrackBinding({
    settings: bindingSettings({YOUTRACK_URL: FAKE_BASE_URL}),
    log: captureLog().log,
    fetch: youtrack.fetch,
  });
  await assert.rejects(trackerFor(HOUSEHOLD_TOKEN, {linkedVia: 'person'}).getIssue('H-9'), {kind: 'not-found'});
});

test('each token gets its own tracker: requests carry only that token, before and after another is made', async () => {
  const {youtrack, trackerFor} = fixture();
  const household = trackerFor(HOUSEHOLD_TOKEN);
  const member = trackerFor(MEMBER_TOKEN);
  assert.notEqual(household, member);
  assert.notEqual(trackerFor(HOUSEHOLD_TOKEN), household, 'no memoisation even for the same token');

  const memberMine = await member.listIssues({assignee: 'me', limit: 50});
  const householdMine = await household.listIssues({assignee: 'me', unresolved: true, limit: 50});
  assert.deepEqual(
    memberMine.issues.map((issue) => issue.key),
    ['H-3'],
  );
  assert.deepEqual(
    householdMine.issues.map((issue) => issue.key),
    ['H-1', 'H-2'],
  );

  const byPath = voiceRequests(youtrack.requests).map((request) => request.authorization);
  assert.deepEqual(byPath, [`Bearer ${MEMBER_TOKEN}`, `Bearer ${HOUSEHOLD_TOKEN}`]);
  assert.equal(JSON.stringify(household).includes('SECRET'), false);
  assert.equal(inspect(household, {showHidden: true, depth: 5}).includes('SECRET'), false);
});

test('a revoked token: the failure is permission with status 401, and neither it nor the logs hold the token', async () => {
  const {youtrack, logs, trackerFor} = fixture();
  const tracker = trackerFor(REVOKED_TOKEN);
  let caught: unknown;
  try {
    await tracker.listIssues({assignee: 'me', limit: 50});
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal((caught as {kind?: unknown}).kind, 'permission');
  assert.equal((caught as {status?: unknown}).status, 401);
  // The fake echoed the token in its error body; nothing the binding hands on may carry it.
  assert.ok(youtrack.requests.length > 0);
  for (const text of [
    caught.message,
    String(caught.stack),
    JSON.stringify(caught),
    inspect(caught, {showHidden: true, depth: 10}),
    JSON.stringify(logs.records),
  ]) {
    assert.equal(text.includes('REVOKED-LINK-SECRET'), false, text);
  }
  // The login lookup runs beside the call for a link the household check does not apply to.
  const unconfirmed = await logs.waitFor('voice.binding.linkUnconfirmed');
  assert.deepEqual(unconfirmed, {
    level: 'warn',
    event: 'voice.binding.linkUnconfirmed',
    fields: {requestId: undefined, linkedVia: undefined, project: 'H', kind: 'permission'},
  });
  assert.equal(JSON.stringify(logs.records).includes('REVOKED-LINK-SECRET'), false);
});

test('the redactor strips the token as sent, in other cases, encoded, and any bearer credential', () => {
  const redact = redactorFor(HOUSEHOLD_TOKEN);
  const forms = [
    HOUSEHOLD_TOKEN,
    HOUSEHOLD_TOKEN.toLowerCase(),
    encodeURIComponent(HOUSEHOLD_TOKEN),
    Buffer.from(HOUSEHOLD_TOKEN).toString('base64'),
    'Bearer some-other-credential',
  ];
  for (const form of forms) {
    const out = redact(`before ${form} after`);
    assert.equal(out.includes(form), false, form);
    assert.match(out, /^before .*\[token\].* after$/);
  }
});

test('a token the library refuses is a permission failure with no request and no token in the log', async () => {
  const {youtrack, logs, trackerFor} = fixture();
  for (const token of ['Atza|BAD SECRET', 'Atza|BAD\r\nX-Injected: SECRET', '']) {
    const tracker = trackerFor(token);
    await assert.rejects(tracker.listIssues({limit: 1}), (error: unknown) => {
      assert.equal((error as {kind?: unknown}).kind, 'permission');
      assert.equal(String((error as Error).message).includes('SECRET'), false);
      return true;
    });
  }
  assert.equal(youtrack.requests.length, 0);
  assert.equal(JSON.stringify(logs.records).includes('SECRET'), false);
  assert.equal(logs.records.filter((record) => record.event === 'voice.binding.credentialRefused').length, 3);
});

test('the linked login is logged once per token at info, as a tag, with the request and the link', async () => {
  const {youtrack, logs, trackerFor} = fixture();
  const first = trackerFor(HOUSEHOLD_TOKEN, {requestId: 'r1', linkedVia: 'account'});
  await first.listIssues({limit: 1});
  await first.getIssue('H-1');
  await logs.waitFor('voice.binding.linked');
  await trackerFor(HOUSEHOLD_TOKEN, {requestId: 'r2', linkedVia: 'account'}).getIssue('H-2');
  await trackerFor(MEMBER_TOKEN, {requestId: 'r3', linkedVia: 'person'}).getIssue('H-3');

  const linked = await logs.waitForCount('voice.binding.linked', 2);
  const fields = {project: 'H', householdLogin: 'n/a', ms: 0};
  assert.deepEqual(linked, [
    {
      level: 'info',
      event: 'voice.binding.linked',
      fields: {requestId: 'r1', linkedVia: 'account', loginTag: idTag('homeacct'), ...fields},
    },
    {
      level: 'info',
      event: 'voice.binding.linked',
      fields: {requestId: 'r3', linkedVia: 'person', loginTag: idTag('sam'), ...fields},
    },
  ]);
  assert.equal(youtrack.requests.filter((request) => request.path === '/api/users/me').length, 2);
  // The raw login appears only at debug.
  for (const record of logs.records.filter((candidate) => candidate.level !== 'debug')) {
    assert.equal(JSON.stringify(record.fields).includes('homeacct'), false, record.event);
  }
});

test('a failed login check is tried again by the next tracker for that token, and never fails the call', async () => {
  let failMe = true;
  const youtrack = createFakeYouTrack({
    accounts: new Map([[HOUSEHOLD_TOKEN, HOUSEHOLD]]),
    issues: ISSUES,
    override: (request) => (request.path === '/api/users/me' && failMe ? new Response('{}', {status: 503}) : undefined),
  });
  const logs = captureLog();
  const {trackerFor} = createYouTrackBinding({
    settings: bindingSettings({YOUTRACK_URL: FAKE_BASE_URL}),
    log: logs.log,
    fetch: youtrack.fetch,
    now: () => 0,
  });
  const tracker = trackerFor(HOUSEHOLD_TOKEN, {linkedVia: 'person'});
  assert.equal((await tracker.getIssue('H-1')).key, 'H-1');
  await tracker.getIssue('H-2');
  await logs.waitFor('voice.binding.linkUnconfirmed');
  assert.equal(youtrack.requests.filter((request) => request.path === '/api/users/me').length, 1);
  failMe = false;
  await trackerFor(HOUSEHOLD_TOKEN, {linkedVia: 'person'}).getIssue('H-1');
  await logs.waitFor('voice.binding.linked');
  assert.deepEqual(
    logs.records
      .filter((record) => record.level !== 'debug' && record.event.startsWith('voice.binding.link'))
      .map((record) => record.event),
    ['voice.binding.linkUnconfirmed', 'voice.binding.linked'],
  );
});

test('with a signal: nothing starts after it fires, and a request in flight is aborted', async () => {
  const inFlight = deferred<void>();
  const requests: string[] = [];
  const hangingFetch: typeof fetch = (input, init) => {
    requests.push(String(input));
    if (String(input).includes('/api/issues/')) inFlight.resolve();
    return new Promise((_resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (init?.signal?.aborted) abort();
      init?.signal?.addEventListener('abort', abort);
    });
  };
  const logs = captureLog();
  const {trackerFor} = createYouTrackBinding({
    settings: bindingSettings({YOUTRACK_URL: FAKE_BASE_URL}),
    log: logs.log,
    fetch: hangingFetch,
  });

  const controller = new AbortController();
  const tracker = trackerFor(HOUSEHOLD_TOKEN, {signal: controller.signal});
  const pending = tracker.getIssue('H-1');
  await inFlight.promise;
  controller.abort();
  await assert.rejects(pending, {kind: 'unavailable'});

  const before = requests.length;
  await assert.rejects(tracker.listIssues({limit: 1}), {kind: 'unavailable'});
  await assert.rejects(trackerFor(HOUSEHOLD_TOKEN, {signal: controller.signal}).getIssue('H-1'), {
    kind: 'unavailable',
  });
  assert.equal(requests.length, before, 'no request after the signal fired');
});

test('the fake serves the B14 live shapes the library accepts, and the voice path never touches them', async () => {
  const {youtrack, trackerFor} = fixture();
  // Fidelity: the library's own adapter reads the agile, current sprint and placement echo from this fake.
  const client = createClient(
    {model: 'test', session: 'test'},
    {
      config: loadConfig({baseUrl: FAKE_BASE_URL, project: 'H', token: HOUSEHOLD_TOKEN}, {environment: {}, files: []}),
      fetch: youtrack.fetch,
    },
  );
  const adapter = createTrackerAdapter(client);
  const discovery = await adapter.discoverIterations('H');
  assert.deepEqual(discovery, {
    targets: [{scopeId: '108-4', scopeName: 'Household', iterationId: '109-7', iterationName: 'Week 37'}],
    unavailable: [],
    withoutCurrent: [],
  });
  await adapter.placeInIteration('H-1', discovery.targets[0], '2-1');
  const libraryRequests = youtrack.requests.length;

  const tracker = trackerFor(HOUSEHOLD_TOKEN);
  await tracker.listIssues({assignee: 'me', unresolved: true, limit: 50});
  await tracker.listIssues({text: 'boiler', limit: 50});
  await tracker.getIssue('H-5');
  await tracker.listComments('H-5', 50);
  const voice = youtrack.requests.slice(libraryRequests);
  assert.deepEqual(voice.map((request) => `${request.method} ${request.path}`).sort(), [
    'GET /api/issues',
    'GET /api/issues',
    'GET /api/issues/H-5',
    'GET /api/issues/H-5/comments',
    'GET /api/users/me',
  ]);
});

test('YA-35 F1/F3/F5: through the real adapter, no login or email is spoken, and nobody is "nobody" unchecked', async () => {
  const issues: FakeIssue[] = [
    {key: 'H-1', summary: 'Kettle', state: 'Open', assignee: 'homeacct', assigneeName: 'Household', updated: 9000},
    // No full name set: the fake, like YouTrack, answers fullName = login.
    {key: 'H-2', summary: 'Gate', state: 'Open', assignee: 'ccoulter', updated: 8000},
    {
      key: 'H-3',
      summary: 'Car',
      state: 'Open',
      assignee: 'jo.bloggs',
      assigneeName: 'jo.bloggs@example.com',
      updated: 7000,
    },
    {key: 'H-4', summary: 'Path', state: 'Open', assignee: 'sam', assigneeName: ' ', updated: 6000},
    {key: 'H-5', summary: 'Shed', state: 'Open', assignee: 'mary smith', assigneeName: 'Mary Price', updated: 5000},
    {
      key: 'H-6',
      summary: 'Hall',
      state: 'Open',
      assignee: 'CCOULTER2',
      assigneeName: 'ccoulter2',
      updated: 4000,
      // Recheck R2: an author with no full name set is not read by login.
      comments: [{author: 'ccoulter', fullName: '', created: 1_757_000_000_000, text: 'Hinges oiled.'}],
    },
    // Recheck R1: full names shaped like a login or an email, but not the login itself.
    {key: 'H-7', summary: 'Oven', state: 'Open', assignee: 'jbl', assigneeName: 'jo.bloggs', updated: 3900},
    {key: 'H-8', summary: 'Fence', state: 'Open', assignee: 'pnair', assigneeName: 'pnair Priya', updated: 3800},
    {key: 'H-9', summary: 'Radiators', state: 'Open', assignee: 'jsm', assigneeName: 'j_smith', updated: 3700},
    {key: 'H-10', summary: 'Hinges', state: 'Open', assignee: 'chrisx', assigneeName: 'chris2', updated: 3600},
    {
      key: 'H-11',
      summary: 'Loft',
      state: 'Open',
      assignee: 'klee',
      assigneeName: 'Kim Lee kim.lee@example.com',
      updated: 3500,
    },
  ];
  const youtrack = createFakeYouTrack({accounts: new Map([[HOUSEHOLD_TOKEN, HOUSEHOLD]]), issues});
  const logs = captureLog();
  const binding = createYouTrackBinding({
    settings: bindingSettings({YOUTRACK_URL: FAKE_BASE_URL}),
    log: logs.log,
    fetch: youtrack.fetch,
    now: () => 0,
  });
  const tracker = binding.trackerFor(HOUSEHOLD_TOKEN);
  // The binding hands the core every assignee with the tracker's own name; the core decides what may be said.
  assert.deepEqual(await tracker.listAssignees(50), {
    people: [
      {login: 'homeacct', name: 'Household'},
      {login: 'ccoulter', name: 'ccoulter'},
      {login: 'jo.bloggs', name: 'jo.bloggs@example.com'},
      {login: 'sam', name: ''},
      {login: 'mary smith', name: 'Mary Price'},
      {login: 'CCOULTER2', name: 'ccoulter2'},
      {login: 'jbl', name: 'jo.bloggs'},
      {login: 'pnair', name: 'pnair Priya'},
      {login: 'jsm', name: 'j_smith'},
      {login: 'chrisx', name: 'chris2'},
      {login: 'klee', name: 'Kim Lee kim.lee@example.com'},
    ],
    complete: true,
  });
  const store = new MemoryStateStore();
  const spoken: string[] = [];
  let turn = 0;
  const say = async (text: string): Promise<string[]> => {
    const response = await converse(
      {
        input: {kind: 'utterance', text},
        speaker: {userId: 'u1', evidence: ['person']},
        locale: 'en-GB',
        capabilities: {ssml: false, earcons: true, display: false, followUp: true, maxSpeechChars: 1000},
        requestId: `r${++turn}`,
      },
      {
        tracker: binding.trackerFor(HOUSEHOLD_TOKEN),
        store,
        policy: {...DEFAULT_POLICY},
        now: () => Date.parse('2026-09-12T09:00:00Z'),
        log: logs.log,
      },
    );
    const lines = [...response.segments, ...(response.reprompt ?? [])].map((segment) => segment.text);
    spoken.push(...lines);
    return lines;
  };

  assert.deepEqual((await say('issues for mary'))[0], 'Mary Price has 1 issue.');
  assert.deepEqual(
    (await say('issues for sam'))[0],
    "I couldn't find anyone by that name, but I can't name everyone in this project.",
  );
  assert.deepEqual(
    (await say('issues for ccoulter'))[0],
    "I couldn't find anyone by that name, but I can't name everyone in this project.",
  );
  await say('open issues');
  for (const position of ['two', 'three', 'four', 'six']) {
    await say(`open ${position}`);
    assert.ok((await say('fields')).includes('Assigned to someone without a name in the tracker.'), position);
  }
  await say('open five');
  assert.ok((await say('fields')).includes('Assigned to Mary Price.'));
  await say('more');
  for (const position of ['seven', 'eight', 'nine', 'ten', 'eleven']) {
    await say(`open ${position}`);
    assert.ok((await say('fields')).includes('Assigned to someone without a name in the tracker.'), position);
  }
  for (const name of ['jo bloggs', 'priya', 'chris', 'kim lee']) {
    assert.match((await say(`issues for ${name}`))[0] ?? '', /^I couldn't find anyone/, name);
  }
  await say('open issues');
  await say('open six');
  assert.deepEqual((await say('comments')).slice(0, 3), [
    '1 comment.',
    'From someone without a name in the tracker, on 4 September 2025.',
    'Hinges oiled.',
  ]);

  const text = spoken.join('\n').toLowerCase();
  for (const secret of [
    'ccoulter',
    'jo.bloggs',
    'example.com',
    '@',
    'homeacct',
    'mary smith',
    'sam',
    'pnair',
    'j_smith',
    'chris2',
    'kim.lee',
    'klee',
    'jbl',
    'chrisx',
  ]) {
    assert.ok(!text.includes(secret), `"${secret}" was spoken`);
  }
  const queries = youtrack.requests.map((request) => request.query.query).filter((query) => query !== undefined);
  assert.ok(queries.includes('project: H for: {mary smith} #Unresolved sort by: updated desc'), queries.join('\n'));
});
