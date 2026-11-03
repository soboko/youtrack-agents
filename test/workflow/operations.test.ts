import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {TrackerFailure} from '../../src/tracker.ts';
import {fixture} from './fake.ts';
import {createIssue, takeIssue, handoffIssue, finishIssue} from '../../src/workflow/operations.ts';

test('create validates canonical fields, including role passed outside CLI', async () => {
  const {context, writes} = fixture();
  for (const workflow of [
    {},
    {role: 'invented', recommendedModel: 'gpt-6', subsystem: 'Test'},
    {role: 'Builder', recommendedModel: 'gpt-6'},
  ]) {
    const result = await createIssue(context, {summary: 'Task', workflow});
    assert.equal(result.status, 'rejected');
  }
  assert.deepEqual(writes, []);
});

test('create defaults to backlog and owner role uses configured owner', async () => {
  const {context, issue, writes} = fixture();
  const result = await createIssue(context, {
    summary: 'Decision',
    workflow: {role: 'owner decides', recommendedModel: 'owner (no model)', subsystem: 'Test'},
  });
  assert.equal(result.status, 'completed');
  assert.equal(issue.workflow.state, 'Submitted');
  assert.equal(issue.workflow.assignee, 'configured-owner');
  assert.deepEqual(writes, ['create']);
});

test('iteration preflight failure prevents taking or creating an active issue', async () => {
  const {context, tracker, writes} = fixture();
  tracker.discoverIterations = async () => ({targets: [], unavailable: ['Board is inaccessible'], withoutCurrent: []});
  assert.equal((await takeIssue(context, 'PRJ-1')).status, 'rejected');
  assert.equal(
    (
      await createIssue(context, {
        summary: 'Task',
        workflow: {state: 'Open', role: 'Builder', subsystem: 'Test', recommendedModel: 'gpt-6'},
      })
    ).status,
    'rejected',
  );
  assert.deepEqual(writes, []);
});

test('placement rejection after taking returns partial with the pending step', async () => {
  const {context, tracker, writes} = fixture();
  tracker.placeInIteration = async () => {
    throw new TrackerFailure('permission', 'denied');
  };
  const result = await takeIssue(context, 'PRJ-1');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.applied, ['take issue']);
  assert.deepEqual(result.pending, ['place in Board: Sprint 1']);
  assert.deepEqual(writes, ['update']);
});

test('unknown mutation is never retried or reported rejected', async () => {
  const {context, tracker, writes} = fixture();
  tracker.updateIssue = async () => {
    writes.push('update');
    throw new TrackerFailure('unknown', 'connection lost');
  };
  const result = await takeIssue(context, 'PRJ-1');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.uncertain, ['take issue']);
  assert.deepEqual(result.pending, ['place in Board: Sprint 1']);
  assert.deepEqual(writes, ['update']);
});

test('handoff updates before its note, note rejection reports partial', async () => {
  const {context, tracker, writes} = fixture();
  tracker.addComment = async () => {
    writes.push('comment');
    throw new TrackerFailure('permission', 'denied');
  };
  const result = await handoffIssue(context, 'PRJ-1', {role: 'Reviewer: testing', note: 'Inspect tests'});
  assert.equal(result.status, 'partial');
  assert.deepEqual(writes, ['update', 'comment']);
  assert.deepEqual(result.pending, ['post handoff note']);
});

test('failed field update never posts a successful handoff comment', async () => {
  const {context, tracker, writes} = fixture();
  tracker.updateIssue = async () => {
    throw new TrackerFailure('conflict', 'changed');
  };
  assert.equal((await handoffIssue(context, 'PRJ-1', {role: 'Builder', note: 'Continue'})).status, 'rejected');
  assert.deepEqual(writes, []);
});

test('Fixed assigns owner and verification role even without a checklist', async () => {
  const {context, issue} = fixture();
  assert.equal((await finishIssue(context, 'PRJ-1', {state: 'Fixed'})).status, 'completed');
  assert.equal(issue.workflow.assignee, 'configured-owner');
  assert.equal(issue.workflow.role, 'Owner verifies');
});

test('take refuses owner work unless explicitly overridden', async () => {
  const {context, issue, writes} = fixture();
  issue.workflow.role = 'Owner decides';
  assert.equal((await takeIssue(context, 'PRJ-1')).status, 'rejected');
  assert.deepEqual(writes, []);
  assert.equal((await takeIssue(context, 'PRJ-1', true)).status, 'completed');
});

test('reserved provider fields cannot override canonical creation policy', async () => {
  const {context, writes} = fixture();
  const result = await createIssue(context, {
    summary: 'Task',
    workflow: {role: 'Builder', recommendedModel: 'gpt-6', subsystem: 'Test'},
    extraFields: {rOlE: 'Owner decides'},
  });
  assert.equal(result.status, 'rejected');
  assert.deepEqual(writes, []);
});

test('submitted spelling does not require sprint discovery', async () => {
  const {context, tracker, issue} = fixture();
  tracker.discoverIterations = async () => {
    throw new Error('must not discover backlog placement');
  };
  assert.equal(
    (
      await createIssue(context, {
        summary: 'Task',
        workflow: {
          role: 'Builder',
          recommendedModel: 'gpt-6',
          subsystem: 'Test',
          state: 'submitted',
        },
      })
    ).status,
    'completed',
  );
  assert.equal(issue.workflow.state, 'Submitted');
});

test('uncertain comment records confirmed fields separately and never duplicates note', async () => {
  const {context, tracker, writes} = fixture();
  tracker.addComment = async () => {
    writes.push('comment');
    throw new TrackerFailure('unknown', 'reply lost');
  };
  const result = await handoffIssue(context, 'PRJ-1', {role: 'Builder', note: 'Continue'});
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.applied, ['update issue']);
  assert.deepEqual(result.uncertain, ['post handoff note']);
  assert.deepEqual(writes, ['update', 'comment']);
});

// The between-sprints contract (YA-8 A1): a board that runs sprints but has no current one is a board state.
// Every write still happens, the owed placement stays pending, and nothing needs reconciliation.
const BETWEEN_SPRINTS = 'place in Board B: no current sprint';

test('a board between sprints leaves every write applied and its placement pending', async (t) => {
  const cases = [
    {
      name: 'take',
      run: (f: ReturnType<typeof fixture>) => takeIssue(f.context, 'PRJ-1'),
      writes: ['update', 'place'],
      applied: ['take issue', 'place in Board: Sprint 1'],
    },
    {
      name: 'state Fixed --check',
      run: (f: ReturnType<typeof fixture>) => finishIssue(f.context, 'PRJ-1', {state: 'Fixed', check: 'x'}),
      writes: ['update', 'comment:**Things to check**\n\nx', 'place'],
      applied: ['update issue', 'post handoff note', 'place in Board: Sprint 1'],
    },
    {
      name: 'handoff --state To be discussed',
      run: (f: ReturnType<typeof fixture>) =>
        handoffIssue(f.context, 'PRJ-1', {role: 'Owner decides', note: 'q?', state: 'To be discussed'}),
      writes: ['update', 'comment:**Hand-off to Owner decides**\n\nq?', 'place'],
      applied: ['update issue', 'post handoff note', 'place in Board: Sprint 1'],
    },
    {
      name: 'create --state Open',
      run: (f: ReturnType<typeof fixture>) =>
        createIssue(f.context, {
          summary: 'Task',
          workflow: {role: 'Builder', recommendedModel: 'gpt-6', subsystem: 'Test', state: 'Open'},
        }),
      writes: ['create', 'place'],
      applied: ['create issue', 'place in Board: Sprint 1'],
    },
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
      const f = fixture({withoutCurrent: ['Board B']});
      const result = await example.run(f);
      assert.equal(result.status, 'partial');
      assert.deepEqual(f.writes, example.writes);
      assert.deepEqual(result.applied, example.applied);
      assert.deepEqual(result.pending, [BETWEEN_SPRINTS]);
      assert.deepEqual(result.uncertain, []);
      assert.match(result.message ?? '', /nothing needs reconciliation/);
      assert.match(result.message ?? '', /Do not re-run/);
      assert.match(result.message ?? '', /once the owner opens a sprint/);
    });
  }
});

test('a failed board lookup still rejects every workflow before any write', async (t) => {
  const runs = {
    take: (f: ReturnType<typeof fixture>) => takeIssue(f.context, 'PRJ-1'),
    state: (f: ReturnType<typeof fixture>) => finishIssue(f.context, 'PRJ-1', {state: 'Fixed', check: 'x'}),
    handoff: (f: ReturnType<typeof fixture>) =>
      handoffIssue(f.context, 'PRJ-1', {role: 'Owner decides', note: 'q?', state: 'To be discussed'}),
    create: (f: ReturnType<typeof fixture>) =>
      createIssue(f.context, {
        summary: 'Task',
        workflow: {role: 'Builder', recommendedModel: 'gpt-6', subsystem: 'Test', state: 'Open'},
      }),
  };
  for (const [name, run] of Object.entries(runs)) {
    await t.test(name, async () => {
      const f = fixture();
      f.tracker.discoverIterations = async () => ({
        targets: [],
        unavailable: ['Board B: sprint discovery failed'],
        withoutCurrent: ['Board C'],
      });
      const result = await run(f);
      assert.equal(result.status, 'rejected');
      assert.deepEqual(f.writes, []);
      assert.deepEqual(result.applied, []);
    });
  }
});

test('a placement rejection after the Fixed note keeps the note and owes both placements', async () => {
  const {context, tracker, writes} = fixture({withoutCurrent: ['Board B']});
  tracker.placeInIteration = async () => {
    throw new TrackerFailure('permission', 'denied');
  };
  const result = await finishIssue(context, 'PRJ-1', {state: 'Fixed', check: 'x'});
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.applied, ['update issue', 'post handoff note']);
  assert.deepEqual(result.pending, ['place in Board: Sprint 1', BETWEEN_SPRINTS]);
  assert.deepEqual(result.uncertain, []);
  assert.deepEqual(writes, ['update', 'comment:**Things to check**\n\nx']);
});

test('an uncertain write between sprints still reports the owed placement as pending', async () => {
  const {context, tracker, writes} = fixture({withoutCurrent: ['Board B']});
  tracker.updateIssue = async () => {
    writes.push('update');
    throw new TrackerFailure('unknown', 'connection lost');
  };
  const result = await takeIssue(context, 'PRJ-1');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.uncertain, ['take issue']);
  assert.deepEqual(result.pending, ['place in Board: Sprint 1', BETWEEN_SPRINTS]);
  assert.deepEqual(writes, ['update']);
});

test('backlog work never owes a placement, even when a board is between sprints', async () => {
  const f = fixture({withoutCurrent: ['Board B']});
  const result = await finishIssue(f.context, 'PRJ-1', {state: 'Submitted'});
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.pending, []);
  assert.deepEqual(f.writes, ['update']);
});

// Candidate tests from the YA-8 testing review, adopted by the Judge (A6).
test('R-W2/W3/W11 finish policy: --no-assign, --assign none, To be discussed', async () => {
  let f = fixture();
  await finishIssue(f.context, 'PRJ-1', {state: 'Fixed', noAssign: true});
  assert.equal(f.issue.workflow.assignee, null);
  f = fixture();
  f.issue.workflow.assignee = 'someone';
  await finishIssue(f.context, 'PRJ-1', {state: 'In Progress', assign: 'none'});
  assert.equal(f.issue.workflow.assignee, null);
  f = fixture();
  await finishIssue(f.context, 'PRJ-1', {state: 'to be discussed'});
  assert.equal(f.issue.workflow.assignee, 'configured-owner');
  assert.equal(f.issue.workflow.role, 'Owner decides');
});

test('R-W4/W5 handoff policy: Owner verifies refused, agent roles unassigned', async () => {
  let f = fixture();
  assert.equal((await handoffIssue(f.context, 'PRJ-1', {role: 'Owner verifies', note: 'n'})).status, 'rejected');
  assert.deepEqual(f.writes, []);
  f = fixture();
  f.issue.workflow.assignee = 'agent';
  await handoffIssue(f.context, 'PRJ-1', {role: 'Builder', note: 'n'});
  assert.equal(f.issue.workflow.assignee, null);
});

test('R-W6/W7 active states are placed on the current sprint', async () => {
  let f = fixture();
  const r = await createIssue(f.context, {
    summary: 's',
    workflow: {role: 'Builder', recommendedModel: 'm', subsystem: 'Test', state: 'Open'},
  });
  assert.deepEqual(r.applied, ['create issue', 'place in Board: Sprint 1']);
  f = fixture();
  await finishIssue(f.context, 'PRJ-1', {state: 'In Progress'});
  assert.deepEqual(f.writes, ['update', 'place']);
});

// YA-25 B5: the owner decided that closing an issue also files it on the current sprint, so the sprint records it.
test('terminal states are placed on the current sprint like every other non-Submitted state', async (t) => {
  for (const state of ["Won't fix", 'Duplicate', 'Obsolete', 'Verified']) {
    await t.test(state, async () => {
      const f = fixture();
      const result = await finishIssue(f.context, 'PRJ-1', {state});
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.applied, ['update issue', 'place in Board: Sprint 1']);
      assert.deepEqual(f.writes, ['update', 'place']);
      assert.equal(f.issue.workflow.state, state);
    });
  }
});

// YA-25 B7 (YA-8 C9): a Role the project added is kept by a forced take, and still refused without --force.
test('take refuses a non-canonical Role without --force and keeps it with --force', async () => {
  const f = fixture();
  f.issue.workflow.role = 'Tester';
  const refused = await takeIssue(f.context, 'PRJ-1');
  assert.equal(refused.status, 'rejected');
  assert.match(refused.message ?? '', /Role "Tester".*--force/);
  assert.deepEqual(f.writes, []);

  let sent: unknown;
  const update = f.tracker.updateIssue;
  f.tracker.updateIssue = async (key, changes) => {
    sent = changes.workflow;
    return update(key, changes);
  };
  const forced = await takeIssue(f.context, 'PRJ-1', true);
  assert.equal(forced.status, 'completed', forced.message);
  assert.deepEqual(sent, {state: 'In Progress', assignee: 'agent'});
  assert.equal(f.issue.workflow.role, 'Tester');
});

test('take still normalises a canonical Role and defaults a missing one to Builder', async () => {
  const cased = fixture();
  cased.issue.workflow.role = 'reviewer: TESTING';
  await takeIssue(cased.context, 'PRJ-1');
  assert.equal(cased.issue.workflow.role, 'Reviewer: testing');
  const unset = fixture();
  unset.issue.workflow.role = null;
  await takeIssue(unset.context, 'PRJ-1');
  assert.equal(unset.issue.workflow.role, 'Builder');
});

// YA-25 B4 (YA-8 C5, S11): the `admin` placeholder is never written as the owner of anything.
test('owner-assigning workflows refuse the unconfigured owner placeholder before any write', async (t) => {
  const refusals = {
    'create with an Owner role': (f: ReturnType<typeof fixture>) =>
      createIssue(f.context, {
        summary: 'Decision',
        workflow: {role: 'Owner decides', recommendedModel: 'owner (no model)', subsystem: 'Test'},
      }),
    'handoff to an Owner role': (f: ReturnType<typeof fixture>) =>
      handoffIssue(f.context, 'PRJ-1', {role: 'Owner decides', note: 'q?'}),
    'state Fixed': (f: ReturnType<typeof fixture>) => finishIssue(f.context, 'PRJ-1', {state: 'Fixed', check: 'x'}),
    'state To be discussed': (f: ReturnType<typeof fixture>) =>
      finishIssue(f.context, 'PRJ-1', {state: 'To be discussed'}),
  };
  for (const [name, operation] of Object.entries(refusals)) {
    await t.test(name, async () => {
      const f = fixture();
      const result = await operation({...f, context: {...f.context, owner: 'admin', ownerIsDefault: true}});
      assert.equal(result.status, 'rejected');
      assert.match(result.message ?? '', /YOUTRACK_OWNER/);
      assert.deepEqual(f.writes, []);
    });
  }
  await t.test('an explicit assignee, --no-assign, agent work and take do not need the owner', async () => {
    const f = fixture();
    const context = {...f.context, owner: 'admin', ownerIsDefault: true};
    assert.equal((await finishIssue(context, 'PRJ-1', {state: 'Fixed', assign: 'someone'})).status, 'completed');
    assert.equal(f.issue.workflow.assignee, 'someone');
    assert.equal((await finishIssue(context, 'PRJ-1', {state: 'Fixed', noAssign: true})).status, 'completed');
    assert.equal((await handoffIssue(context, 'PRJ-1', {role: 'Builder', note: 'n'})).status, 'completed');
    assert.equal((await takeIssue(context, 'PRJ-1')).status, 'completed');
    assert.equal(
      (
        await createIssue(context, {
          summary: 'Decision',
          workflow: {role: 'Owner decides', recommendedModel: 'm', subsystem: 'Test', assignee: 'person'},
        })
      ).status,
      'completed',
    );
  });
});

// YA-25 B12 (YA-8 C8.6): an envelope's issue is labelled, so a pre-write snapshot is never read as the result.
test('the outcome says whether its issue is the snapshot from before or after the write', async () => {
  const taken = fixture();
  assert.equal((await takeIssue(taken.context, 'PRJ-1')).issueSnapshot, 'after');
  const untaken = fixture();
  untaken.tracker.updateIssue = async () => {
    throw new TrackerFailure('unknown', 'connection lost');
  };
  assert.equal((await takeIssue(untaken.context, 'PRJ-1')).issueSnapshot, 'before');

  const lost = fixture();
  lost.tracker.updateIssue = async () => {
    throw new TrackerFailure('unknown', 'connection lost');
  };
  const uncertain = await finishIssue(lost.context, 'PRJ-1', {state: 'In Progress'});
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.issueSnapshot, 'before');
  assert.equal(uncertain.issue?.workflow.state, 'Open');

  const created = fixture();
  const result = await createIssue(created.context, {
    summary: 'Task',
    workflow: {role: 'Builder', recommendedModel: 'gpt-6', subsystem: 'Test'},
  });
  assert.equal(result.issueSnapshot, 'after');
  const handed = await handoffIssue(created.context, 'PRJ-1', {role: 'Builder', note: 'n'});
  assert.equal(handed.issueSnapshot, 'after');
  assert.equal((await handoffIssue(created.context, 'PRJ-1', {role: 'nope', note: 'n'})).issueSnapshot, undefined);
});

// YA-25 B6: the workflow already holds the issue, so placement gets its entity id and the adapter skips a read.
test('placement is given the issue entity id by take, state, handoff and create', async (t) => {
  const runs = {
    take: (f: ReturnType<typeof fixture>) => takeIssue(f.context, 'PRJ-1'),
    state: (f: ReturnType<typeof fixture>) => finishIssue(f.context, 'PRJ-1', {state: 'In Progress'}),
    handoff: (f: ReturnType<typeof fixture>) =>
      handoffIssue(f.context, 'PRJ-1', {role: 'Builder', note: 'n', state: 'Open'}),
    create: (f: ReturnType<typeof fixture>) =>
      createIssue(f.context, {
        summary: 'Task',
        workflow: {role: 'Builder', recommendedModel: 'gpt-6', subsystem: 'Test', state: 'Open'},
      }),
  };
  for (const [name, operation] of Object.entries(runs)) {
    await t.test(name, async () => {
      const f = fixture();
      f.issue.id = '2-17';
      const calls: unknown[][] = [];
      // Declared with the optional third parameter so the recorded arguments are checked, not just counted.
      const record = async (key: string, target: unknown, issueId?: string) => {
        calls.push([key, target, issueId]);
      };
      f.tracker.placeInIteration = record;
      const result = await operation(f);
      assert.equal(result.status, 'completed', result.message);
      assert.deepEqual(calls, [
        ['PRJ-1', {scopeId: 'board', scopeName: 'Board', iterationId: 'sprint', iterationName: 'Sprint 1'}, '2-17'],
      ]);
    });
  }
});

// YA-25 Y6: a library caller that builds its context without ownerIsDefault gets the safe reading, not `admin`.
test('without ownerIsDefault, an empty or placeholder owner is refused; an explicit flag or a real login proceeds', async (t) => {
  for (const owner of ['admin', '', '  ']) {
    await t.test(`owner ${JSON.stringify(owner)} with no flag`, async () => {
      const f = fixture();
      const result = await finishIssue({tracker: f.tracker, owner, project: 'PRJ'}, 'PRJ-1', {
        state: 'Fixed',
        check: 'x',
      });
      assert.equal(result.status, 'rejected');
      assert.match(result.message ?? '', /YOUTRACK_OWNER/);
      assert.deepEqual(f.writes, []);
    });
  }
  await t.test('explicitly configured admin, and a real login without the flag', async () => {
    const admin = fixture();
    const explicit = {tracker: admin.tracker, owner: 'admin', ownerIsDefault: false, project: 'PRJ'};
    assert.equal((await finishIssue(explicit, 'PRJ-1', {state: 'Fixed'})).status, 'completed');
    assert.equal(admin.issue.workflow.assignee, 'admin');
    const login = fixture();
    const unflagged = {tracker: login.tracker, owner: 'chris', project: 'PRJ'};
    assert.equal((await handoffIssue(unflagged, 'PRJ-1', {role: 'Owner decides', note: 'q?'})).status, 'completed');
    assert.equal(login.issue.workflow.assignee, 'chris');
  });
});

// YA-25 F5: the fake has one listing shape, the port's, so a regression to a bare array cannot hide behind it.
test('the fake tracker lists issues only as {issues, complete}', async () => {
  const listed = await fixture().tracker.listIssues({});
  assert.ok(!Array.isArray(listed));
  assert.deepEqual(Object.keys(listed).sort(), ['complete', 'issues']);
});
