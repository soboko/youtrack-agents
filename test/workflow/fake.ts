import type {TrackerPort, TrackerIssue, IterationTarget, IssueChanges, NewIssue} from '../../src/tracker.ts';
import type {WorkflowContext} from '../../src/workflow/operations.ts';
const TARGET: IterationTarget = {
  scopeId: 'board',
  scopeName: 'Board',
  iterationId: 'sprint',
  iterationName: 'Sprint 1',
};

/**
 * Stateful fake records side effects; exceptions can model a server applying a write then losing its reply.
 * `withoutCurrent` lists boards that run sprints but are between them, next to the one board with a current sprint.
 */
export function fixture(options: {withoutCurrent?: string[]} = {}) {
  const writes: string[] = [];
  const issue: TrackerIssue = {
    id: '1',
    key: 'PRJ-1',
    summary: 'Task',
    description: null,
    url: 'https://example.invalid/issue/PRJ-1',
    updated: 1,
    workflow: {state: 'Open', role: 'Builder', assignee: null, recommendedModel: 'gpt-6', subsystem: 'Test'},
  };
  const tracker: TrackerPort = {
    capabilities: {iterations: true, conditionalUpdates: false, atomicAccounting: false},
    getIssue: async () => issue,
    listIssues: async () => ({issues: [issue], complete: true}),
    listComments: async () => ({comments: [], complete: true}),
    createIssue: async (input: NewIssue) => {
      writes.push('create');
      issue.summary = input.summary;
      Object.assign(issue.workflow, input.workflow);
      return issue;
    },
    updateIssue: async (_key: string, changes: IssueChanges) => {
      writes.push('update');
      Object.assign(issue.workflow, changes.workflow);
      return issue;
    },
    addComment: async (_key: string, text: string) => {
      writes.push(`comment:${text}`);
      return {id: 'comment'};
    },
    currentActor: async () => ({id: 'agent', name: 'Agent'}),
    discoverIterations: async () => ({
      targets: [TARGET],
      unavailable: [],
      withoutCurrent: [...(options.withoutCurrent ?? [])],
    }),
    placeInIteration: async () => {
      writes.push('place');
    },
  };
  const context: WorkflowContext = {tracker, owner: 'configured-owner', project: 'PRJ'};
  return {tracker, issue, writes, context};
}
