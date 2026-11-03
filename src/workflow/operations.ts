import {OWNER_PLACEHOLDER} from '../config.ts';
import {TrackerFailure} from '../tracker.ts';
import type {IssueChanges, NewIssue, TrackerPort, WorkflowResult, IterationTarget} from '../tracker.ts';
import {canonicalRole, isOwnerRole, ROLES, roleOf} from './policy.ts';

/** Running totals of mutating requests, such as `YouTrackClient.writes`. */
export interface DispatchCounts {
  /** Mutating requests handed to the network. */
  readonly dispatched: number;
  /** Mutating requests the provider answered with a status that says nothing was applied. */
  readonly refused: number;
}

/** Resolved application configuration; no workflow reads ambient process environment. */
export interface WorkflowContext {
  tracker: TrackerPort;
  owner: string;
  project: string;
  /**
   * Whether `owner` is a placeholder nobody configured; workflows then refuse to assign it (YA-25 B4). Pass
   * `config.ownerIsDefault`. When omitted, an empty owner or the `admin` placeholder counts as unconfigured, so a
   * caller that forgets the flag is refused rather than assigning `admin` (YA-25 Y6); an explicitly configured
   * `admin` needs `ownerIsDefault: false`.
   */
  ownerIsDefault?: boolean;
  /**
   * Counts for the writes `tracker` sends. With them, a failed step that dispatched nothing is not uncertain,
   * whatever it threw. Without them, only a classified failure other than `unknown` proves nothing was applied.
   */
  writes?: () => DispatchCounts;
}

/** A workflow result that also says which snapshot `issue` is. */
export interface WorkflowOutcome extends WorkflowResult {
  /**
   * `before`: read before any write, so it does not show this command's changes. `after`: returned by the
   * confirmed create or update. Absent when there is no issue (YA-25 B12).
   */
  issueSnapshot?: 'before' | 'after';
}

interface Step {
  name: string;
  apply: () => Promise<void>;
}

function rejected(error: unknown): WorkflowOutcome {
  return {status: 'rejected', applied: [], pending: [], uncertain: [], message: String(error)};
}

/** Current iterations to place on now, and scopes that owe a placement once they have a current iteration. */
interface Placement {
  targets: IterationTarget[];
  withoutCurrent: string[];
}

const NO_PLACEMENT: Placement = {targets: [], withoutCurrent: []};

const PLACE = 'place in ';

function unplaced(withoutCurrent: string[]): string[] {
  return withoutCurrent.map((scope) => `${PLACE}${scope}: no current sprint`);
}

/** The `<scope>: <iteration>` placements a result confirmed, for display. */
export function placedIn(result: WorkflowResult): string[] {
  return result.applied.filter((step) => step.startsWith(PLACE)).map((step) => step.slice(PLACE.length));
}

/**
 * Whether a failed step may have changed the provider. Counted writes answer that directly: a step whose every
 * dispatched write was refused, or that dispatched none (a lookup, a validation or a TypeError before the request),
 * applied nothing. Uncounted, anything but a classified refusal may have reached the provider (YA-25 B6).
 */
function mayHaveApplied(error: unknown, before?: DispatchCounts, after?: DispatchCounts): boolean {
  if (before && after) return after.dispatched - before.dispatched > after.refused - before.refused;
  return !(error instanceof TrackerFailure) || error.kind === 'unknown';
}

function ownerOf(context: WorkflowContext): string {
  const unconfigured = context.ownerIsDefault ?? (!context.owner?.trim() || context.owner === OWNER_PLACEHOLDER);
  if (unconfigured) {
    throw new Error(
      `no owner configured: set YOUTRACK_OWNER to the login that verifies and decides; ` +
        `refusing to assign the "${context.owner}" placeholder. Nothing was written.`,
    );
  }
  return context.owner;
}

// Each confirmed step is recorded before the next write. We cannot roll remote writes back atomically,
// and retrying a comment after a timeout could duplicate it, so reconciliation belongs to the caller.
// Placements owed to scopes with no current iteration are never attempted, so they always stay pending.
async function execute(
  context: WorkflowContext,
  steps: Step[],
  result: WorkflowOutcome,
  withoutCurrent: string[] = [],
): Promise<WorkflowOutcome> {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const before = context.writes?.();
    try {
      await step.apply();
      result.applied.push(step.name);
    } catch (error) {
      const uncertain = mayHaveApplied(error, before, context.writes?.());
      result.status = uncertain ? 'unknown' : result.applied.length ? 'partial' : 'rejected';
      result.uncertain = uncertain ? [step.name] : [];
      result.pending = [
        ...steps.slice(uncertain ? index + 1 : index).map((pending) => pending.name),
        ...unplaced(withoutCurrent),
      ];
      result.message = `${step.name}: ${String(error)}`;
      return result;
    }
  }
  if (withoutCurrent.length) {
    result.status = 'partial';
    result.pending = unplaced(withoutCurrent);
    result.message =
      `no current sprint on ${withoutCurrent.join(', ')}: every other step was applied and nothing needs ` +
      'reconciliation. Do not re-run this command; placement is owed once the owner opens a sprint.';
  }
  return result;
}

function initial(): WorkflowOutcome {
  return {status: 'completed', applied: [], pending: [], uncertain: []};
}

// A failed lookup rejects before any write; a scope between iterations is a board state, reported as pending.
async function iterations(context: WorkflowContext, key: string): Promise<Placement> {
  if (!context.tracker.capabilities.iterations) {
    throw new Error('tracker does not support required iteration placement');
  }
  const discovery = await context.tracker.discoverIterations(key);
  if (discovery.unavailable.length) {
    throw new Error(`cannot discover required iterations: ${discovery.unavailable.join('; ')}`);
  }
  return {targets: discovery.targets, withoutCurrent: discovery.withoutCurrent};
}

/** Places by entity id when the issue is already known, which saves the adapter a read per board. */
function placementSteps(
  context: WorkflowContext,
  issue: () => {key: string; id?: string},
  targets: IterationTarget[],
): Step[] {
  return targets.map((target) => ({
    name: `${PLACE}${target.scopeName}: ${target.iterationName}`,
    apply: () => {
      const {key, id} = issue();
      return context.tracker.placeInIteration(key, target, id);
    },
  }));
}

/** Validate creation once for every application entry point, then report any partial placement. */
export async function createIssue(context: WorkflowContext, input: NewIssue): Promise<WorkflowOutcome> {
  try {
    if (
      Object.keys(input.extraFields ?? {}).some((name) =>
        ['state', 'role', 'assignee', 'recommended model', 'subsystem'].includes(name.trim().toLowerCase()),
      )
    )
      throw new Error('use typed workflow fields instead of reserved extraFields');
    if (!input.summary.trim()) throw new Error('create needs --summary');
    if (!input.workflow?.role) throw new Error('create needs --role');
    if (!input.workflow.recommendedModel?.trim()) throw new Error('create needs --recommend');
    if (!input.workflow.subsystem?.trim()) throw new Error('create needs --subsystem');
    const role = roleOf(input.workflow.role);
    const requestedState = input.workflow.state?.trim() ?? 'Submitted';
    if (!requestedState) throw new Error('state must not be empty');
    const state = requestedState.toLowerCase() === 'submitted' ? 'Submitted' : requestedState;
    const changes: NewIssue = {...input, workflow: {...input.workflow, role, state}};
    if (isOwnerRole(role) && !changes.workflow?.assignee) {
      changes.workflow = {...changes.workflow, assignee: ownerOf(context)};
    }
    const placement = state === 'Submitted' ? NO_PLACEMENT : await iterations(context, context.project);
    const result = initial();
    return execute(
      context,
      [
        {
          name: 'create issue',
          apply: async () => {
            result.issue = await context.tracker.createIssue(changes);
            result.issueSnapshot = 'after';
          },
        },
        ...placementSteps(
          context,
          () => {
            if (!result.issue) throw new Error('create returned no issue');
            return result.issue;
          },
          placement.targets,
        ),
      ],
      result,
      placement.withoutCurrent,
    );
  } catch (error) {
    return rejected(error);
  }
}

/**
 * Take preflights identity and all boards before changing assignment or state. A Role outside the canonical list
 * might be a person's, so it is refused like an Owner role; `--force` takes the issue and keeps that Role as it is.
 */
export async function takeIssue(context: WorkflowContext, key: string, force = false): Promise<WorkflowOutcome> {
  try {
    const before = await context.tracker.getIssue(key);
    const current = before.workflow.role;
    const canonical = current ? canonicalRole(current) : 'Builder';
    if (!canonical && !force) {
      throw new Error(
        `${key} has Role "${current}", which is not one of: ${ROLES.join(' | ')}; --force takes it anyway`,
      );
    }
    if (canonical && isOwnerRole(canonical) && !force) {
      throw new Error(`${key} is with "${canonical}"; --force takes it anyway`);
    }
    const actor = await context.tracker.currentActor();
    const placement = await iterations(context, key);
    const result = initial();
    result.issue = before;
    result.issueSnapshot = 'before';
    return execute(
      context,
      [
        {
          name: 'take issue',
          apply: async () => {
            result.issue = await context.tracker.updateIssue(key, {
              // An unrecognised Role is left out of the update, so the provider keeps it.
              workflow: {state: 'In Progress', assignee: actor.id, ...(canonical ? {role: canonical} : {})},
            });
            result.issueSnapshot = 'after';
          },
        },
        ...placementSteps(context, () => ({key, id: result.issue?.id ?? before.id}), placement.targets),
      ],
      result,
      placement.withoutCurrent,
    );
  } catch (error) {
    return rejected(error);
  }
}

/** Handoff comments follow the field update so a failed update never gets a success-looking note. */
export async function handoffIssue(
  context: WorkflowContext,
  key: string,
  input: {role: string; note: string; state?: string},
): Promise<WorkflowOutcome> {
  try {
    const role = roleOf(input.role);
    if (!input.note.trim()) throw new Error('handoff needs the pick-up note');
    if (role === 'Owner verifies' && !input.state) {
      throw new Error('Owner verifies requires yt state ISSUE Fixed --check TEXT, or an explicit --state');
    }
    return updateWithNote(
      context,
      key,
      {
        workflow: {
          role,
          assignee: isOwnerRole(role) ? ownerOf(context) : null,
          ...(input.state ? {state: input.state} : {}),
        },
      },
      `**Hand-off to ${role}**\n\n${input.note.trim()}`,
    );
  } catch (error) {
    return rejected(error);
  }
}

/** Fixed is the agent's handoff, with owner assignment even when automated tests replace the checklist. */
export async function finishIssue(
  context: WorkflowContext,
  key: string,
  input: {state: string; check?: string; assign?: string; noAssign?: boolean},
): Promise<WorkflowOutcome> {
  const state = input.state.trim();
  if (!state) return rejected('state must not be empty');
  const fixed = state.toLowerCase() === 'fixed';
  const discussed = state.toLowerCase() === 'to be discussed';
  const workflow: NonNullable<IssueChanges['workflow']> = {
    state: fixed ? 'Fixed' : discussed ? 'To be discussed' : state,
  };
  if (fixed || discussed) workflow.role = fixed ? 'Owner verifies' : 'Owner decides';
  if (input.assign !== undefined) {
    workflow.assignee = input.assign === 'none' ? null : input.assign;
  } else if ((fixed || discussed) && !input.noAssign) {
    try {
      workflow.assignee = ownerOf(context);
    } catch (error) {
      return rejected(error);
    }
  }
  return updateWithNote(
    context,
    key,
    {workflow},
    input.check?.trim() ? `**Things to check**\n\n${input.check.trim()}` : undefined,
  );
}

async function updateWithNote(
  context: WorkflowContext,
  key: string,
  changes: IssueChanges,
  note?: string,
): Promise<WorkflowOutcome> {
  try {
    const before = await context.tracker.getIssue(key);
    const state = changes.workflow?.state;
    // Every state but Submitted is placed, the terminal ones included, so a sprint shows what was closed during it.
    // The owner chose this (YA-25 B5).
    const placement = state && state.toLowerCase() !== 'submitted' ? await iterations(context, key) : NO_PLACEMENT;
    const result = initial();
    result.issue = before;
    result.issueSnapshot = 'before';
    const steps: Step[] = [
      {
        name: 'update issue',
        apply: async () => {
          result.issue = await context.tracker.updateIssue(key, changes);
          result.issueSnapshot = 'after';
        },
      },
    ];
    // The note goes before placement, so a board problem can never cost the handoff its comment.
    if (note)
      steps.push({
        name: 'post handoff note',
        apply: async () => {
          await context.tracker.addComment(key, note);
        },
      });
    steps.push(...placementSteps(context, () => ({key, id: result.issue?.id ?? before.id}), placement.targets));
    return execute(context, steps, result, placement.withoutCurrent);
  } catch (error) {
    return rejected(error);
  }
}
