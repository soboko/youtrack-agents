import {createClient, formatTokens, loadConfig} from '../../client.ts';
import {configuredProject} from '../config.ts';
import {AdminStepFailure} from '../youtrack/admin.ts';
import type {Issue, YouTrackClient} from '../../client.ts';
import type {WriteCounts} from '../youtrack/transport.ts';
import {resolveIdentity} from '../../identity.ts';
import {createTrackerAdapter} from '../youtrack/adapter.ts';
import {TrackerFailure} from '../tracker.ts';
import type {TrackerPort, WorkflowFields} from '../tracker.ts';
import {createIssue, takeIssue, handoffIssue, finishIssue, placedIn} from '../workflow/operations.ts';
import type {WorkflowContext, WorkflowOutcome} from '../workflow/operations.ts';
import {parseArgs, str, pairs} from './args.ts';
import {longText, noteText, readText} from './input.ts';
import type {ReadText} from './input.ts';
import {fmtIssue, when} from './output.ts';
import {help} from './help.ts';

/** Unresolved issues `yt board` reads; it says so when more exist. */
const BOARD_CAP = 500;
/** Optional boundaries make CLI invocation reusable without replacing global I/O or network functions. */
export interface CliDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readText?: ReadText;
  loadConfig?: typeof loadConfig;
  createClient?: typeof createClient;
  tracker?: TrackerPort;
}

// A native mutation may have succeeded even though refreshing its display fails. Preserve the
// confirmed operation separately from the read failure so callers do not replay the write.
class RefreshFailure extends Error {
  readonly receipt: Record<string, unknown>;
  readonly applied: string;

  constructor(applied: string, receipt: Record<string, unknown>, error: unknown) {
    super(`${applied} succeeded, but refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    this.receipt = receipt;
    this.applied = applied;
  }
}

async function refreshAfterWrite<T>(
  applied: string,
  receipt: Record<string, unknown>,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new RefreshFailure(applied, receipt, error);
  }
}

// What this invocation's client has sent, so a failure is classified by what reached the provider.
interface Invocation {
  client?: YouTrackClient;
  writesBefore?: WriteCounts;
}

function writesSince(invocation: Invocation): WriteCounts {
  const {client, writesBefore} = invocation;
  if (!client || !writesBefore) return {dispatched: 0, confirmed: 0, refused: 0};
  const now = client.writes;
  return {
    dispatched: now.dispatched - writesBefore.dispatched,
    confirmed: now.confirmed - writesBefore.confirmed,
    refused: now.refused - writesBefore.refused,
  };
}

// The error's type cannot decide the status. A plain Error after a confirmed write is not "rejected", and
// a plain Error before any dispatch is not "unknown" (202a12a). Counting writes answers both.
function classifyFailure(
  error: unknown,
  writes: WriteCounts,
): {status: 'partial' | 'unknown' | 'rejected'; message?: string} {
  if (error instanceof RefreshFailure) return {status: 'partial'};
  const receiptFailure = error instanceof TrackerFailure && error.kind === 'unknown';
  let confirmed = writes.confirmed;
  // Refused writes were answered with a status that says nothing was applied; the rest may have landed.
  let unresolved = writes.dispatched - writes.confirmed - writes.refused;
  // An unknown outcome with every write answered means a receipt failed its check after the transport counted it,
  // so the last "confirmed" write is not confirmed at all (YA-8 NF2).
  // The same holds for an admin step left uncertain after its write was answered: a receipt check inside the step
  // (YA-25 F2), or a backlog attach whose read-back contradicts it (Y5). An answered write is not a confirmed outcome.
  const unconfirmedStep = error instanceof AdminStepFailure && error.uncertain.length > 0;
  if ((receiptFailure || unconfirmedStep) && unresolved === 0 && confirmed > 0) {
    confirmed--;
    unresolved++;
  }
  const counts = [
    ...(confirmed > 0 ? [`${confirmed} write(s) confirmed`] : []),
    ...(unresolved > 0 ? [`${unresolved} write(s) without a confirmed outcome`] : []),
  ];
  const message = counts.length ? `${counts.join(', ')} before failure; reconcile before retrying` : undefined;
  // Admin sequences know which step failed, which is finer than the invocation's totals (YA-25 B15).
  if (error instanceof AdminStepFailure) {
    const status = error.uncertain.length ? 'unknown' : error.applied.length ? 'partial' : 'rejected';
    return {status, message: status === 'rejected' ? undefined : message};
  }
  if (receiptFailure) return {status: 'unknown', message};
  if (unresolved > 0) return {status: 'unknown', message};
  if (confirmed > 0) return {status: 'partial', message};
  return {status: 'rejected'};
}

function stepLines(steps: {applied: string[]; pending: string[]; uncertain: string[]}): string[] {
  return [
    ...steps.applied.map((step) => `  applied: ${step}`),
    ...steps.pending.map((step) => `  pending: ${step}`),
    ...steps.uncertain.map((step) => `  uncertain: ${step}`),
  ];
}

/** Run one invocation. Failures are returned as exit codes; this function never terminates the process. */
export async function run(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const invocation: Invocation = {};
  try {
    return await execute(argv, dependencies, invocation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = classifyFailure(error, writesSince(invocation));
    if (argv.includes('--json')) {
      (
        dependencies.stdout ??
        ((text) => {
          process.stdout.write(text);
        })
      )(
        JSON.stringify({
          version: 1,
          status: outcome.status,
          ...(error instanceof RefreshFailure
            ? {applied: [error.applied], pending: ['refresh display'], uncertain: [], receipt: error.receipt}
            : {}),
          ...(error instanceof AdminStepFailure
            ? {applied: error.applied, pending: error.pending, uncertain: error.uncertain}
            : {}),
          error: message,
          ...(outcome.message ? {message: outcome.message} : {}),
        }) + '\n',
      );
    } else {
      (
        dependencies.stderr ??
        ((text) => {
          process.stderr.write(text);
        })
      )(
        [
          `[yt] ${message}`,
          ...(error instanceof AdminStepFailure ? stepLines(error) : []),
          ...(outcome.message ? [`[yt] ${outcome.message}`] : []),
        ]
          .map((line) => `${line}\n`)
          .join(''),
      );
    }
    return 1;
  }
}

async function execute(argv: string[], dependencies: CliDependencies, invocation: Invocation): Promise<number> {
  const stdout =
    dependencies.stdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const stderr =
    dependencies.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const read = dependencies.readText ?? readText;
  const {_: pos, opts} = parseArgs(argv);
  const cmd = pos[0] ?? 'help';
  // Help never loads credentials, but its examples still use the configured project key (YA-25 B12).
  const usage = () => help(str(opts.project) ?? configuredProject());
  if (cmd === 'help' || opts.help) {
    stdout(usage());
    return 0;
  }

  const config = (dependencies.loadConfig ?? loadConfig)({project: str(opts.project), baseUrl: str(opts.url)});
  const P = config.project;
  const identity = resolveIdentity({model: str(opts.model), session: str(opts.session)}, config.environment);
  const quiet = !!opts.quiet;
  const json = !!opts.json;
  const yt = (dependencies.createClient ?? createClient)(identity, {
    config,
    log:
      quiet || json
        ? () => {}
        : (message) => {
            stderr(`[yt] ${message}\n`);
          },
  });
  invocation.client = yt;
  invocation.writesBefore = yt.writes;
  const context: WorkflowContext = {
    tracker: dependencies.tracker ?? createTrackerAdapter(yt),
    owner: config.owner,
    ownerIsDefault: config.ownerIsDefault,
    project: config.project,
    // Only this client's writes can be counted; an injected tracker sends its own.
    ...(dependencies.tracker ? {} : {writes: () => yt.writes}),
  };
  const emit = (data: unknown, text: string) => {
    stdout(json ? JSON.stringify(data, null, 2) + '\n' : text + '\n');
  };
  const need = (n: number, what: string) => {
    if (pos.length < n + 1) throw new Error(`usage: yt ${cmd} ${what}`);
  };

  const emitWorkflow = (result: WorkflowOutcome): number => {
    const issue = result.issue;
    const lines: string[] = [];
    if (issue) {
      lines.push(`${issue.key}  [${issue.workflow.state ?? '-'}]  ${issue.summary}`);
      if (cmd === 'create') lines.push(`  ${issue.url}`);
      if (cmd === 'take') {
        // The before-snapshot still shows the old assignee, so only the confirmed update is described (YA-25 B12).
        if (result.issueSnapshot === 'after') {
          const placed = placedIn(result);
          lines.push(
            `-> ${issue.workflow.state ?? '-'}, assigned ${issue.workflow.assignee ?? '(nobody)'}` +
              (placed.length ? `, on ${placed.join(' and ')}` : ''),
          );
        }
        lines.push(
          `-> Role: ${issue.workflow.role}. Adopt that persona: read its role file (host AGENTS.md "Role") before touching anything.`,
        );
      }
    }
    emit(
      {version: 1, ...result},
      [...lines, `workflow: ${result.status}`, ...stepLines(result), result.message].filter(Boolean).join('\n'),
    );
    return result.status === 'completed' ? 0 : 1;
  };

  switch (cmd) {
    case 'whoami': {
      const me = await yt.whoami();
      emit(
        {
          ...me,
          identity,
          baseUrl: yt.baseUrl,
          project: yt.project,
          owner: config.owner,
          ownerIsDefault: !!config.ownerIsDefault,
          config: yt.configSource,
        },
        `${me.login} (${me.fullName}, ${me.email ?? 'no email'}) on ${yt.baseUrl} project ${yt.project}\nidentity: model=${identity.model} session=${identity.session}\nowner: ${config.owner}${config.ownerIsDefault ? ' (default)' : ''}\nconfig: ${yt.configSource}`,
      );
      return 0;
    }
    case 'field': {
      // yt field add 'Recommended model' --values a,b,c [--empty '?']   a global single-value enum field, attached to the project
      if (pos[1] !== 'add') throw new Error("usage: yt field add 'Name' --values a,b,c [--empty text]");
      need(2, "add 'Name' --values a,b,c");
      const vals = String(opts.values ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (!vals.length) throw new Error('--values is required');
      const r = await yt.addEnumField(pos[2], vals, {
        emptyText: str(opts.empty),
      });
      emit(r, `field "${pos[2]}" ready: ${vals.join(' | ')}`);
      return 0;
    }
    case 'fields': {
      const fs = await yt.fields();
      emit(
        fs,
        fs
          .map(
            (f) =>
              `${f.name.padEnd(18)} ${f.type.padEnd(14)} ${f.canBeEmpty ? 'optional' : 'required'}  ${f.values.join(' | ')}`,
          )
          .join('\n'),
      );
      return 0;
    }
    case 'board': {
      const {field, columns} = await yt.boardColumns(str(opts.board));
      // Resolved issues would crowd out the working columns under the cap (YA-8 B1).
      const {issues, complete} = await yt.searchIssues('#Unresolved sort by: updated desc', BOARD_CAP);
      if (!complete) stderr(`[yt] (showing ${issues.length} unresolved issues; more exist)\n`);
      const colOf = (i: Issue) =>
        columns.find((c) => c.values.includes(String(i.fields[field] ?? '')))?.name ??
        `(no column: ${i.fields[field]})`;
      const by = new Map<string, Issue[]>(columns.map((c) => [c.name, []]));
      for (const i of issues) {
        const c = colOf(i);
        (by.get(c) ?? by.set(c, []).get(c)!).push(i);
      }
      emit(
        Object.fromEntries(
          [...by].map(([c, l]) => [
            c,
            l.map((i) => ({
              id: i.idReadable,
              summary: i.summary,
              subsystem: i.fields.Subsystem ?? null,
            })),
          ]),
        ),
        [...by]
          .map(([c, l]) => `## ${c} (${l.length})\n${l.map((i) => '  ' + fmtIssue(i)).join('\n') || '  (none)'}`)
          .join('\n\n'),
      );
      return 0;
    }
    case 'list': {
      const top = Number(str(opts.top) ?? 50);
      if (!Number.isSafeInteger(top) || top < 1) throw new Error('--top must be a positive integer');
      const {issues, complete} = await yt.searchIssues(pos.slice(1).join(' '), top);
      // stderr keeps --json output a plain array; a duplicate check must know it did not see everything (YA-8 B1).
      if (!complete) stderr(`[yt] (showing ${issues.length}; more exist: raise --top)\n`);
      emit(issues, issues.length ? issues.map((i) => fmtIssue(i)).join('\n') : '(no issues)');
      return 0;
    }
    case 'show': {
      need(1, `${P}-1`);
      const issue = await yt.getIssue(pos[1]);
      const comments = await yt.comments(pos[1]);
      emit(
        {issue, comments},
        fmtIssue(issue, true) +
          (comments.length
            ? '\n\n' + comments.map((c) => `--- ${c.author ?? '?'} ${when(c.created)}\n${c.text}`).join('\n\n')
            : ''),
      );
      return 0;
    }
    case 'create': {
      const extraFields = pairs(Array.isArray(opts.set) ? opts.set : []);
      for (const [flag, name] of [
        ['type', 'Type'],
        ['priority', 'Priority'],
      ] as const) {
        const value = str(opts[flag]);
        if (value !== undefined) extraFields[name] = value;
      }
      const workflow: Partial<WorkflowFields> = {};
      for (const [flag, field, name] of [
        ['state', 'state', 'State'],
        ['role', 'role', 'Role'],
        ['assignee', 'assignee', 'Assignee'],
        ['recommend', 'recommendedModel', 'Recommended model'],
        ['subsystem', 'subsystem', 'Subsystem'],
      ] as const) {
        const value = str(opts[flag]) ?? extraFields[name];
        if (value !== undefined) workflow[field] = value;
        delete extraFields[name];
      }
      return emitWorkflow(
        await createIssue(context, {
          summary: str(opts.summary) ?? '',
          description: longText(opts, 'description', read),
          workflow,
          extraFields,
        }),
      );
    }
    case 'subsystem': {
      need(2, `${P}-1 'Map Client'`);
      emit(await yt.setSubsystem(pos[1], pos.slice(2).join(' ')), `${pos[1]} -> Subsystem ${pos.slice(2).join(' ')}`);
      return 0;
    }
    case 'state': {
      need(2, `${P}-1 'In Progress'`);
      const target = pos.slice(2).join(' ');
      const check = longText(opts, 'check', read);
      if (target.trim().toLowerCase() === 'fixed' && !check?.trim() && !quiet && !json) {
        stderr(
          `[yt] reminder: Fixed without --check. If a person must verify this (any UI change, or anything the tests do not cover), post a "Things to check" comment (AGENTS.md).\n`,
        );
      }
      return emitWorkflow(
        await finishIssue(context, pos[1], {
          state: target,
          check,
          assign: str(opts.assign),
          noAssign: !!opts['no-assign'],
        }),
      );
    }
    case 'take': {
      need(1, `${P}-1`);
      return emitWorkflow(await takeIssue(context, pos[1], !!opts.force));
    }
    case 'handoff': {
      need(2, `${P}-1 'Owner decides' 'note' | --file F`);
      return emitWorkflow(
        await handoffIssue(context, pos[1], {
          role: pos[2],
          note: noteText(pos.slice(3), str(opts.file), read),
          state: str(opts.state),
        }),
      );
    }
    case 'assign': {
      need(2, `${P}-1 login|none`);
      const who = pos[2] === 'none' ? null : pos[2];
      emit(await yt.assign(pos[1], who), `${pos[1]} -> Assignee ${who ?? '(unassigned)'}`);
      return 0;
    }
    case 'subsystems': {
      if (pos[1] === 'add') {
        need(2, "add 'Name' --description '...'");
        await yt.addSubsystem(pos[2], str(opts.description) ?? '', str(opts.board));
      }
      const readSubsystems = async () => ({
        values: (await yt.field('Subsystem')).values,
        lanes: await yt.swimlanes(str(opts.board)),
      });
      const {values, lanes} =
        pos[1] === 'add'
          ? await refreshAfterWrite('add subsystem', {subsystem: pos[2]}, readSubsystems)
          : await readSubsystems();
      const rows = values.map((v) => ({
        subsystem: v,
        swimlane: lanes.includes(v),
      }));
      emit(rows, rows.map((r) => `${r.swimlane ? 'lane ' : 'NO LANE'}  ${r.subsystem}`).join('\n'));
      return 0;
    }
    case 'set': {
      need(2, `${P}-1 'Field=Value'`);
      const fields = pairs(pos.slice(2));
      const issue = await yt.setFields(pos[1], fields);
      emit(issue, fmtIssue(issue, true));
      return 0;
    }
    case 'edit': {
      need(1, `${P}-1 --summary S`);
      const issue = await yt.updateIssue(pos[1], {
        summary: str(opts.summary),
        description: longText(opts, 'description', read),
      });
      emit(issue, fmtIssue(issue, true));
      return 0;
    }
    case 'comment': {
      need(1, `${P}-1 'text'`);
      const text = noteText(pos.slice(2), str(opts.file), read);
      if (!text.trim()) throw new Error('empty comment');
      const c = await yt.addComment(pos[1], text);
      emit(c, `commented on ${pos[1]} (${c.id})\n${c.text}`);
      return 0;
    }
    case 'estimate': {
      need(1, `${P}-1 --time '2d 4h' --tokens N`);
      const time = str(opts.time),
        tokens = str(opts.tokens);
      if (!time && !tokens) throw new Error('estimate needs --time and/or --tokens');
      const issue = await yt.setEstimate(pos[1], {time, tokens});
      emit(
        issue,
        `${pos[1]} -> Estimation ${issue.fields.Estimation ?? '-'}  Token Estimate ${formatTokens(issue.fields['Token Estimate'])}`,
      );
      return 0;
    }
    case 'actual': {
      need(1, `${P}-1 --time 1h`);
      const time = str(opts.time),
        tokens = str(opts.tokens);
      if (!time && !tokens) throw new Error('actual needs --time');
      const {issue, work} = await yt.addActual(pos[1], {
        time,
        tokens,
        text: str(opts.note),
        type: str(opts.type),
      });
      emit(
        {issue, work},
        // `issue` is read before the work item is logged, so its Spent time is the old total.
        `${pos[1]} -> ${work ? `logged ${work.presentation}${work.type ? ' ' + work.type : ''}` : 'nothing logged'}  Spent time (before) ${issue.fields['Spent time'] ?? '-'}`,
      );
      return 0;
    }
    case 'work': {
      need(1, `${P}-1`);
      const items = await yt.workItems(pos[1]);
      emit(
        items,
        items.length
          ? items
              .map(
                (w) =>
                  `${when(w.date).slice(0, 10)}  ${w.presentation.padEnd(8)} ${(w.type ?? '-').padEnd(14)} ${w.author ?? '?'}  ${(w.text ?? '').split('\n')[0]}`,
              )
              .join('\n')
          : '(no work logged)',
      );
      return 0;
    }
    case 'sprints': {
      const r = await yt.sprints(str(opts.board) ?? yt.sprintBoard);
      emit(
        r,
        `${r.board}: sprints ${r.enabled ? 'enabled' : 'DISABLED'}, current: ${r.current ?? '-'}\n` +
          r.sprints
            .map(
              (s) =>
                `  ${s.name}${s.archived ? ' (archived)' : ''}  ${s.issues} issue(s)${s.start ? `  ${new Date(s.start).toISOString().slice(0, 10)}` : ''}${s.finish ? ` -> ${new Date(s.finish).toISOString().slice(0, 10)}` : ''}`,
            )
            .join('\n'),
      );
      return 0;
    }
    case 'sprint': {
      const board = str(opts.board) ?? yt.sprintBoard;
      const sub = pos[1];
      if (sub === 'add') {
        need(3, `add ${P}-1[,${P}-2] 'Sprint 1'`);
        const ids = pos[2]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        await yt.addToSprint(ids, board, pos.slice(3).join(' '));
        const after = await refreshAfterWrite(
          'add to sprint',
          {issueKeys: ids, board, sprint: pos.slice(3).join(' ')},
          () => Promise.all(ids.map((id) => yt.getIssue(id))),
        );
        emit(after, after.map((i) => fmtIssue(i)).join('\n') + `\n-> on "${pos.slice(3).join(' ')}" (${board})`);
        return 0;
      }
      if (sub === 'create') {
        need(2, "create 'Sprint 2'");
        const s = await yt.createSprint(board, pos.slice(2).join(' '));
        emit(s, `${board}: created "${s.name}"`);
        return 0;
      }
      if (sub === 'rename') {
        need(3, "rename 'old' 'new'");
        const s = await yt.renameSprint(board, pos[2], pos.slice(3).join(' '));
        emit(s, `${board}: renamed to "${s.name}"`);
        return 0;
      }
      if (sub === 'enable' || sub === 'disable') {
        await yt.setSprintsEnabled(board, sub === 'enable');
        const r = await refreshAfterWrite('set sprints enabled', {board, enabled: sub === 'enable'}, () =>
          yt.sprints(board),
        );
        emit(r, `${board}: sprints ${r.enabled ? 'enabled' : 'disabled'}`);
        return 0;
      }
      if (sub === 'backlog') {
        need(2, "backlog 'query'");
        await yt.setBacklog(board, `${board} backlog`, pos.slice(2).join(' '));
        emit({board, query: pos.slice(2).join(' ')}, `${board}: backlog query set`);
        return 0;
      }
      throw new Error('usage: yt sprint add|create|rename|enable|disable|backlog ...');
    }
    case 'cmd': {
      need(2, `${P}-1 'State Fixed'`);
      const ids = pos[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await yt.command(ids, pos.slice(2).join(' '), str(opts.comment));
      const after = await refreshAfterWrite('execute native command', {issueKeys: ids}, () =>
        Promise.all(ids.map((id) => yt.getIssue(id))),
      );
      emit(after, after.map((i) => fmtIssue(i)).join('\n'));
      return 0;
    }
    default:
      if (json) emit({version: 1, status: 'rejected', error: `unknown command "${cmd}"`}, '');
      else stderr(`unknown command "${cmd}"\n\n${help(P)}`);
      return 2;
  }
}
