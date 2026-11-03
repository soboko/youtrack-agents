/**
 * The account-level link is bound to HOUSEHOLD_LOGIN (YA-15 review K1): a token for any other YouTrack account reads
 * nothing, the verdict is remembered per token only, and a recognised person's own link is not checked against it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {bindingSettings, createYouTrackBinding, LinkMismatchError} from '../../../src/voice/binding/youtrack.ts';
import {idTag} from '../../../src/voice/alexa/log.ts';
import {captureLog} from '../alexa/helpers.ts';
import {createFakeYouTrack, FAKE_BASE_URL, type FakeIssue} from './fake-youtrack.ts';

const HOUSEHOLD_TOKEN = 'Atza|HOUSEHOLD-LINK-SECRET-1111111111';
const OWNER_TOKEN = 'Atza|OWNER-LINK-SECRET-2222222222';

const ISSUES: FakeIssue[] = [
  {key: 'H-1', summary: 'Fix the kitchen tap', state: 'Open', assignee: 'homeacct', updated: 5000},
  {key: 'H-2', summary: 'Owner-only budget', state: 'Open', assignee: 'chris', updated: 4000},
];

function fixture(householdLogin = 'homeacct', override?: Parameters<typeof createFakeYouTrack>[0]['override']) {
  const youtrack = createFakeYouTrack({
    accounts: new Map([
      [HOUSEHOLD_TOKEN, {login: 'homeacct', fullName: 'Household'}],
      [OWNER_TOKEN, {login: 'chris', fullName: 'Chris Owner'}],
    ]),
    issues: ISSUES,
    override,
  });
  const logs = captureLog();
  const binding = createYouTrackBinding({
    settings: bindingSettings({YOUTRACK_URL: FAKE_BASE_URL, HOUSEHOLD_LOGIN: householdLogin}),
    log: logs.log,
    fetch: youtrack.fetch,
    now: () => 0,
  });
  const count = (path: string) => youtrack.requests.filter((request) => request.path === path).length;
  return {youtrack, logs, binding, count};
}

test('HOUSEHOLD_LOGIN must look like a login, and is optional in the settings', () => {
  assert.equal(bindingSettings({YOUTRACK_URL: FAKE_BASE_URL}).householdLogin, undefined);
  assert.equal(
    bindingSettings({YOUTRACK_URL: FAKE_BASE_URL, HOUSEHOLD_LOGIN: ' homeacct '}).householdLogin,
    'homeacct',
  );
  for (const bad of ['home acct', 'for: me', '{x}', '-x']) {
    assert.throws(
      () => bindingSettings({YOUTRACK_URL: FAKE_BASE_URL, HOUSEHOLD_LOGIN: bad}),
      (error: unknown) =>
        error instanceof Error && /HOUSEHOLD_LOGIN/.test(error.message) && !error.message.includes(bad),
    );
  }
});

test('the household account passes, is looked up once per token, and the tag line names the request and link', async () => {
  const {binding, logs, count} = fixture();
  const turn = {requestId: 'req-A', linkedVia: 'account' as const};
  await binding.checkLink(HOUSEHOLD_TOKEN, turn);
  const tracker = binding.trackerFor(HOUSEHOLD_TOKEN, turn);
  assert.deepEqual(
    (await tracker.listIssues({assignee: 'me', limit: 50})).issues.map((issue) => issue.key),
    ['H-1'],
  );
  await binding.checkLink(HOUSEHOLD_TOKEN, {requestId: 'req-B', linkedVia: 'account'});
  await binding.trackerFor(HOUSEHOLD_TOKEN, {requestId: 'req-B', linkedVia: 'account'}).getIssue('H-1');
  assert.equal(count('/api/users/me'), 1, 'remembered for the token');
  assert.deepEqual(
    logs.records.filter((record) => record.event === 'voice.binding.linked'),
    [
      {
        level: 'info',
        event: 'voice.binding.linked',
        fields: {
          requestId: 'req-A',
          linkedVia: 'account',
          project: 'H',
          loginTag: idTag('homeacct'),
          householdLogin: 'match',
          ms: 0,
        },
      },
    ],
  );
});

test('another account on the account-level link reads nothing: the check rejects and every call is refused', async () => {
  const {binding, logs, count} = fixture();
  const turn = {requestId: 'req-X', linkedVia: 'account' as const};
  await assert.rejects(binding.checkLink(OWNER_TOKEN, turn), LinkMismatchError);
  const tracker = binding.trackerFor(OWNER_TOKEN, turn);
  await assert.rejects(tracker.listIssues({limit: 50}), {kind: 'permission'});
  await assert.rejects(tracker.getIssue('H-2'), {kind: 'permission'});
  await assert.rejects(tracker.listComments('H-2', 5), {kind: 'permission'});
  // Unknown origin is treated as account-level.
  await assert.rejects(binding.trackerFor(OWNER_TOKEN).listIssues({limit: 50}), {kind: 'permission'});

  assert.equal(count('/api/issues'), 0);
  assert.equal(count('/api/issues/H-2'), 0);
  assert.equal(count('/api/users/me'), 1, 'the mismatch is remembered for the token');
  const mismatch = logs.records.find((record) => record.event === 'voice.binding.loginMismatch');
  assert.deepEqual(mismatch, {
    level: 'warn',
    event: 'voice.binding.loginMismatch',
    fields: {
      requestId: 'req-X',
      linkedVia: 'account',
      project: 'H',
      loginTag: idTag('chris'),
      expectedTag: idTag('homeacct'),
    },
  });
  for (const record of logs.records.filter((candidate) => candidate.level !== 'debug')) {
    const text = JSON.stringify(record.fields);
    assert.equal(text.includes('chris') || text.includes('homeacct'), false, record.event);
  }
});

test('a matching token never vouches for another token, in either order', async () => {
  const {binding, count} = fixture();
  await binding.checkLink(HOUSEHOLD_TOKEN, {linkedVia: 'account'});
  await assert.rejects(binding.checkLink(OWNER_TOKEN, {linkedVia: 'account'}), LinkMismatchError);
  await binding.checkLink(HOUSEHOLD_TOKEN, {linkedVia: 'account'});
  await assert.rejects(binding.trackerFor(OWNER_TOKEN, {linkedVia: 'account'}).listIssues({limit: 1}), {
    kind: 'permission',
  });
  assert.equal(count('/api/users/me'), 2);
});

test('the login comparison ignores case', async () => {
  const {binding} = fixture('HomeAcct');
  await binding.checkLink(HOUSEHOLD_TOKEN, {linkedVia: 'account'});
});

test("a recognised person's own link is not held to the household login", async () => {
  const {binding, logs} = fixture();
  await binding.checkLink(OWNER_TOKEN, {linkedVia: 'person'});
  const tracker = binding.trackerFor(OWNER_TOKEN, {linkedVia: 'person'});
  assert.deepEqual(
    (await tracker.listIssues({assignee: 'me', limit: 5})).issues.map((issue) => issue.key),
    ['H-2'],
  );
  const linked = await logs.waitFor('voice.binding.linked');
  assert.equal(linked.fields.householdLogin, 'n/a');
  assert.equal(
    logs.records.some((record) => record.event === 'voice.binding.loginMismatch'),
    false,
  );
});

test('a failed login lookup on the account link refuses the turn with its kind and status, and is not remembered', async () => {
  let status = 503;
  const {binding, count} = fixture('homeacct', (request) =>
    request.path === '/api/users/me' && status !== 200 ? Response.json({}, {status}) : undefined,
  );
  await assert.rejects(binding.checkLink(HOUSEHOLD_TOKEN, {linkedVia: 'account'}), {
    kind: 'unavailable',
    status: 503,
  });
  status = 401;
  await assert.rejects(binding.trackerFor(HOUSEHOLD_TOKEN, {linkedVia: 'account'}).listIssues({limit: 1}), {
    kind: 'permission',
    status: 401,
  });
  assert.equal(count('/api/issues'), 0);
  status = 200;
  await binding.checkLink(HOUSEHOLD_TOKEN, {linkedVia: 'account'});
  assert.equal(count('/api/users/me'), 3);
});
