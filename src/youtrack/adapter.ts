import {TrackerFailure} from '../tracker.ts';
import type {IssueChanges, IssueFilter, IterationTarget, TrackerIssue, TrackerPort} from '../tracker.ts';
import type {Issue} from './types.ts';
import type {YouTrackClient} from './client.ts';
import {segment} from './transport.ts';

const WORKFLOW_NAMES = {
  state: 'State',
  role: 'Role',
  assignee: 'Assignee',
  recommendedModel: 'Recommended model',
  subsystem: 'Subsystem',
} as const;

function issueView(issue: Issue): TrackerIssue {
  const value = (name: string): string | null => (typeof issue.fields[name] === 'string' ? issue.fields[name] : null);
  const assignee = issue.users?.[WORKFLOW_NAMES.assignee];
  return {
    id: issue.id,
    key: issue.idReadable,
    summary: issue.summary,
    description: issue.description,
    url: issue.url,
    updated: issue.updated,
    workflow: {
      state: value('State'),
      role: value('Role'),
      // The login, which queries use; a user value's plain field may be its display name instead.
      assignee: assignee?.login ?? value('Assignee'),
      recommendedModel: value('Recommended model'),
      subsystem: value('Subsystem'),
    },
    assigneeName: assignee?.fullName ?? null,
  };
}

function fieldsFor(changes: IssueChanges): Record<string, string | string[] | number | null> {
  const fields = {...changes.extraFields};
  for (const name of Object.values(WORKFLOW_NAMES)) {
    if (Object.keys(fields).some((key) => key.toLowerCase() === name.toLowerCase())) {
      throw new TrackerFailure('validation', `Use typed workflow properties to change ${name}`);
    }
  }
  for (const [property, fieldName] of Object.entries(WORKFLOW_NAMES)) {
    // Keys come from the closed workflow-name map above.
    const value = changes.workflow?.[property as keyof typeof WORKFLOW_NAMES];
    if (value !== undefined) fields[fieldName] = value;
  }
  return fields;
}

/**
 * Query syntax and quote characters, removed from inside each summary word: parentheses, colon, braces, hash,
 * backslash, and ASCII, typographic and full-width quotes. Only ASCII `"` is known to delimit a YouTrack phrase, but
 * nothing depends on the lexer ignoring the others (YA-25 Y3).
 */
const WORD_PUNCTUATION =
  /[():{}#\\"\u00ab\u00bb\u2018-\u201f\u2039\u203a\u2e42\u300c-\u300f\u301d-\u301f\uff02\uff07]/g;

/** Summary words: split on whitespace and control characters, stripped of query syntax, letters or digits required. */
function summaryWords(text: string): string[] {
  return text
    .split(/[\s\u0000-\u001f\u007f]+/u)
    .map((word) => word.replace(WORD_PUNCTUATION, ''))
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

/**
 * Characters allowed in a login used as a query value; nothing that can close a value or start another term. Single
 * spaces inside are allowed: the value is braced, and braces are how YouTrack takes a value with spaces (YA-35 F5).
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9._@+-]| (?=[A-Za-z0-9._@+-]))*$/;

/**
 * Builds a structured YouTrack query. Every user-supplied value is either braced (after refusing braces), matched
 * against a login pattern, or double-quoted word by word (after removing quotes), so none can add query syntax.
 */
function queryFor(filter: IssueFilter): string {
  const terms = Object.entries(WORKFLOW_NAMES).flatMap(([property, name]) => {
    if (property === 'assignee') return [];
    const value = filter[property as Exclude<keyof typeof WORKFLOW_NAMES, 'assignee'>];
    if (value === undefined) return [];
    // Braces/backslashes cannot escape a structured filter into native query syntax.
    if (/[{}\\\r\n]/.test(value)) throw new TrackerFailure('validation', `Unsupported query characters in ${property}`);
    return [`${name}: {${value}}`];
  });
  if (filter.assignee !== undefined) {
    if (filter.assignee === 'me') {
      terms.push('for: me');
    } else if (LOGIN.test(filter.assignee)) {
      terms.push(`for: {${filter.assignee}}`);
    } else {
      throw new TrackerFailure('validation', 'Unsupported characters in assignee login');
    }
  }
  if (filter.text !== undefined) {
    const words = summaryWords(filter.text);
    // Parenthesised, so an `or` between words can never widen the project scope or the other filters.
    const joiner = filter.textMode === 'any' ? ' or ' : ' and ';
    if (words.length) terms.push(`(${words.map((word) => `summary: "${word}"`).join(joiner)})`);
  }
  if (filter.unresolved) terms.push('#Unresolved');
  // A stable order makes a capped list the most recently updated issues rather than an arbitrary subset.
  terms.push('sort by: updated desc');
  return terms.join(' ');
}

/** A sprint lookup is usable only with a boolean sprint setting and, when sprints run, an explicit current sprint. */
function parseSprintLookup(board: {id: string; name: string}, raw: unknown): IterationTarget | 'disabled' | 'between' {
  const malformed = (): never => {
    throw new TrackerFailure('unavailable', 'Malformed sprint lookup');
  };
  if (raw === null || typeof raw !== 'object') return malformed();
  const record = raw as Record<string, unknown>;
  const settings = record.sprintsSettings as Record<string, unknown> | null | undefined;
  if (settings === null || typeof settings !== 'object' || typeof settings.disableSprints !== 'boolean') {
    return malformed();
  }
  if (settings.disableSprints) return 'disabled';
  // A projection carries a requested attribute as null when unset, so only null means "no current sprint"; a
  // missing (undefined) attribute falls through to the malformed check below.
  const current = record.currentSprint as Record<string, unknown> | null | undefined;
  if (current === null) return 'between';
  if (
    current === undefined ||
    typeof current !== 'object' ||
    typeof current.id !== 'string' ||
    typeof current.name !== 'string' ||
    typeof current.archived !== 'boolean'
  ) {
    return malformed();
  }
  // An archived sprint is never a target; the owner resolves it like being between sprints.
  if (current.archived || !current.id || !current.name) return 'between';
  return {scopeId: board.id, scopeName: board.name, iterationId: current.id, iterationName: current.name};
}

/** Project-scoped provider adapter. Administrative and native command APIs are deliberately absent. */
export function createTrackerAdapter(client: YouTrackClient): TrackerPort {
  const checkKey = (key: string): void => {
    if (!key.startsWith(`${client.project}-`) || !/^\d+$/.test(key.slice(client.project.length + 1))) {
      throw new TrackerFailure('validation', `Issue must belong to configured project ${client.project}`);
    }
  };
  return {
    capabilities: Object.freeze({iterations: true, conditionalUpdates: false, atomicAccounting: false}),
    async getIssue(key) {
      checkKey(key);
      return issueView(await client.getIssue(key));
    },
    async listIssues(filter) {
      const result = await client.searchIssues(queryFor(filter), filter.limit ?? 50);
      return {issues: result.issues.map(issueView), complete: result.complete};
    },
    async listComments(key, limit) {
      checkKey(key);
      const result = await client.commentPage(key, limit);
      return {
        comments: result.comments.map((comment) => ({
          authorName: comment.authorName ?? 'Unknown',
          authorLogin: comment.author,
          created: comment.created,
          text: comment.text,
        })),
        complete: result.complete,
      };
    },
    async createIssue(input) {
      const fields = fieldsFor(input);
      return issueView(await client.createIssue({summary: input.summary, description: input.description, fields}));
    },
    async updateIssue(key, changes) {
      checkKey(key);
      const fields = fieldsFor(changes);
      return issueView(
        await client.updateIssue(key, {summary: changes.summary, description: changes.description, fields}),
      );
    },
    async addComment(key, text) {
      checkKey(key);
      return client.addComment(key, text);
    },
    async currentActor() {
      const actor = await client.whoami();
      return {id: actor.login, name: actor.fullName || actor.login};
    },
    async discoverIterations(key) {
      if (key !== client.project) checkKey(key);
      const boards = await client.boards();
      const targets = [];
      const unavailable = [];
      const withoutCurrent = [];
      for (const board of boards) {
        try {
          // Placement needs only current-sprint metadata, never historical membership or display counts.
          const lookup = await client.request<unknown>('GET', `agiles/${segment(board.id)}`, undefined, {
            fields: 'sprintsSettings(disableSprints),currentSprint(id,name,archived)',
          });
          const parsed = parseSprintLookup(board, lookup);
          if (parsed === 'between') {
            // Between sprints is a normal board state the owner resolves.
            withoutCurrent.push(board.name);
          } else if (parsed !== 'disabled') {
            targets.push(parsed);
          }
        } catch {
          unavailable.push(`${board.name}: sprint discovery failed`);
        }
      }
      return {targets, unavailable, withoutCurrent};
    },
    async placeInIteration(key, target, issueId) {
      checkKey(key);
      // Use stable IDs rather than interpolating arbitrary board/sprint names into a command.
      if (!/^[\w-]+$/.test(target.scopeId) || !/^[\w-]+$/.test(target.iterationId)) {
        throw new TrackerFailure('validation', 'Invalid iteration identifier');
      }
      if (issueId !== undefined && !/^\d+-\d+$/.test(issueId)) {
        throw new TrackerFailure('validation', 'Invalid issue entity id');
      }
      const id = issueId ?? (await client.getIssue(key)).id;
      const path = `agiles/${segment(target.scopeId)}/sprints/${segment(target.iterationId)}/issues`;
      // YouTrack answers {id, idReadable, $type} (checked live under YA-25 B14); the echoed id is the receipt.
      const receipt = await client.request<unknown>('POST', path, {id, $type: 'Issue'});
      if (receipt === null || typeof receipt !== 'object' || (receipt as {id?: unknown}).id !== id) {
        throw new TrackerFailure('unknown', 'Missing placement receipt; reconcile before retrying');
      }
    },
  };
}
