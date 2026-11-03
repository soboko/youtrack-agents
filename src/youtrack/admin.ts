import type {YouTrackClient} from './client.ts';
import {TrackerFailure} from '../tracker.ts';
import {segment} from './transport.ts';

/** A sprint write whose reply lacks an id and name may still have created or renamed the sprint. */
function sprintReceipt(raw: unknown): {id: string; name: string} {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'id' in raw &&
    typeof raw.id === 'string' &&
    'name' in raw &&
    typeof raw.name === 'string'
  ) {
    return {id: raw.id, name: raw.name};
  }
  throw new TrackerFailure('unknown', 'Missing sprint receipt; reconcile before retrying');
}

/**
 * The id in a write's reply. Every admin write asks for `fields=id`, so a reply without one, an empty 2xx included,
 * may still have landed: its outcome is unknown, never applied (YA-25 Y5).
 */
function receiptId(raw: unknown, what: string): string {
  if (raw !== null && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string') return raw.id;
  throw new TrackerFailure('unknown', `Missing ${what} receipt; reconcile before retrying`);
}

/**
 * An administrative sequence that stopped part-way (YA-25 B15). Steps mean what they mean in a workflow result:
 * `applied` were confirmed, `pending` were not attempted or were refused, and `uncertain` may have landed.
 */
export class AdminStepFailure extends Error {
  readonly applied: string[];
  readonly pending: string[];
  readonly uncertain: string[];

  constructor(cause: unknown, steps: {applied: string[]; pending: string[]; uncertain: string[]}) {
    super(cause instanceof Error ? cause.message : String(cause), {cause});
    this.name = 'AdminStepFailure';
    this.applied = steps.applied;
    this.pending = steps.pending;
    this.uncertain = steps.uncertain;
  }
}

interface AdminStep {
  name: string;
  apply: () => Promise<void>;
}

/**
 * Runs writes in order, recording each confirmed one before the next. A failed step is uncertain when it dispatched a
 * write the provider did not refuse, whatever it threw; otherwise it is pending with every step after it.
 */
async function runSteps(client: YouTrackClient, steps: AdminStep[]): Promise<void> {
  const applied: string[] = [];
  for (let index = 0; index < steps.length; index++) {
    const before = client.writes;
    try {
      await steps[index].apply();
      applied.push(steps[index].name);
    } catch (error) {
      const after = client.writes;
      const uncertain = after.dispatched - before.dispatched > after.refused - before.refused;
      throw new AdminStepFailure(error, {
        applied,
        pending: steps.slice(uncertain ? index + 1 : index).map((step) => step.name),
        uncertain: uncertain ? [steps[index].name] : [],
      });
    }
  }
}

/** Provider-specific setup is separate from the agent workflow port. */
export class YouTrackAdmin {
  private readonly client: YouTrackClient;

  constructor(client: YouTrackClient) {
    this.client = client;
  }

  /** Every read happens before the first write, so a failed lookup never leaves a half-made field behind. */
  async addEnumField(
    name: string,
    values: string[],
    opts: {description?: string; canBeEmpty?: boolean; emptyText?: string} = {},
  ): Promise<{field: string; bundle: string; values: string[]}> {
    type B = {id: string; name: string; values?: {name: string}[]};
    const bundles = await this.client.collect<B>('admin/customFieldSettings/bundles/enum', {
      fields: 'id,name,values(name)',
    });
    const fields = await this.client.collect<{id: string; name: string}>('admin/customFieldSettings/customFields', {
      fields: 'id,name',
    });
    const projects = await this.client.collect<{id: string; shortName: string}>('admin/projects', {
      fields: 'id,shortName',
    });
    const proj = projects.find((p) => p.shortName === this.client.project);
    if (!proj) throw new Error(`project ${this.client.project} not found`);
    const attached = await this.client.collect<{field: {name: string}}>(
      `admin/projects/${segment(proj.id)}/customFields`,
      {
        fields: 'field(name)',
      },
    );

    const bundle = bundles.find((b) => b.name === name);
    let bundleId = bundle?.id ?? '';
    const field = fields.find((f) => f.name === name);
    let fieldId = field?.id ?? '';
    const steps: AdminStep[] = [];
    if (!bundle) {
      steps.push({
        name: `create enum bundle "${name}"`,
        apply: async () => {
          const created = await this.client.request<unknown>(
            'POST',
            'admin/customFieldSettings/bundles/enum',
            {
              name,
              $type: 'EnumBundle',
              values: values.map((v, i) => ({
                name: v,
                ordinal: i,
                $type: 'EnumBundleElement',
              })),
            },
            {fields: 'id,name,values(name)'},
          );
          bundleId = receiptId(created, 'bundle');
        },
      });
    } else {
      for (const v of values.filter((value) => !bundle.values?.some((x) => x.name === value))) {
        steps.push({
          name: `add value "${v}" to bundle "${name}"`,
          apply: async () => {
            const added = await this.client.request<unknown>(
              'POST',
              `admin/customFieldSettings/bundles/enum/${segment(bundle.id)}/values`,
              {name: v, $type: 'EnumBundleElement'},
              {fields: 'id'},
            );
            receiptId(added, 'bundle value');
          },
        });
      }
    }
    if (!field) {
      steps.push({
        name: `create field "${name}"`,
        apply: async () => {
          const created = await this.client.request<unknown>(
            'POST',
            'admin/customFieldSettings/customFields',
            {
              name,
              fieldType: {id: 'enum[1]', $type: 'FieldType'},
              isAutoAttached: false,
              isDisplayedInIssueList: true,
              $type: 'CustomField',
            },
            {fields: 'id,name'},
          );
          fieldId = receiptId(created, 'field');
        },
      });
    }
    if (!attached.some((a) => a.field.name === name)) {
      steps.push({
        name: `attach field "${name}" to ${this.client.project}`,
        apply: async () => {
          const attachedField = await this.client.request<unknown>(
            'POST',
            `admin/projects/${segment(proj.id)}/customFields`,
            {
              field: {id: fieldId, $type: 'CustomField'},
              bundle: {id: bundleId, $type: 'EnumBundle'},
              canBeEmpty: opts.canBeEmpty ?? true,
              emptyFieldText: opts.emptyText ?? '?',
              $type: 'EnumProjectCustomField',
            },
            {fields: 'id'},
          );
          receiptId(attachedField, 'project field');
        },
      });
    }
    await runSteps(this.client, steps);
    this.client.log(`field "${name}" (enum) attached to ${this.client.project} with ${values.length} value(s)`);
    return {field: fieldId, bundle: bundleId, values};
  }

  async setSprintsEnabled(boardName: string, enabled: boolean): Promise<void> {
    const b = await this.client.agile(boardName);
    // isExplicit: cards are put on sprints by hand (the command), not synced from a custom field. Without it
    // the board reports "The setting that links sprints to a custom field is undefined" and refuses every command.
    const updated = await this.client.request<unknown>(
      'POST',
      `agiles/${segment(b.id)}`,
      {
        sprintsSettings: {
          disableSprints: !enabled,
          isExplicit: true,
          $type: 'SprintsSettings',
        },
      },
      {fields: 'id'},
    );
    receiptId(updated, 'board');
    this.client.log(`board "${b.name}": sprints ${enabled ? 'enabled' : 'disabled'}`);
  }
  async createSprint(boardName: string, name: string): Promise<{id: string; name: string}> {
    const b = await this.client.agile(boardName);
    const s = sprintReceipt(
      await this.client.request<unknown>(
        'POST',
        `agiles/${segment(b.id)}/sprints`,
        {name, $type: 'Sprint'},
        {fields: 'id,name'},
      ),
    );
    this.client.log(`board "${b.name}": sprint "${s.name}" created`);
    return s;
  }
  async renameSprint(boardName: string, from: string, to: string): Promise<{id: string; name: string}> {
    const {sprints} = await this.client.sprints(boardName);
    const s = sprints.find((x) => x.name === from);
    if (!s) throw new Error(`no sprint "${from}" on "${boardName}" (have: ${sprints.map((x) => x.name).join(', ')})`);
    const b = await this.client.agile(boardName);
    const r = sprintReceipt(
      await this.client.request<unknown>(
        'POST',
        `agiles/${segment(b.id)}/sprints/${segment(s.id)}`,
        {name: to},
        {fields: 'id,name'},
      ),
    );
    this.client.log(`board "${b.name}": sprint "${from}" renamed "${to}"`);
    return r;
  }
  async setBacklog(boardName: string, savedQueryName: string, query: string): Promise<void> {
    const b = await this.client.agile(boardName);
    const teamName = await this.client.teamGroupName();
    const team = (await this.client.collect<{id: string; name: string}>('groups', {fields: 'id,name'})).find(
      (g) => g.name === teamName,
    );
    const sharing = team
      ? {
          permittedGroups: [{id: team.id, $type: 'UserGroup'}],
          $type: 'WatchFolderSharingSettings',
        }
      : undefined;
    const existing = await this.client.collect<{id: string; name: string}>('savedQueries', {
      fields: 'id,name',
    });
    const found = existing.find((x) => x.name === savedQueryName);
    let queryId = found?.id ?? '';
    const body: Record<string, unknown> = {
      query,
      ...(sharing ? {readSharingSettings: sharing, updateSharingSettings: sharing} : {}),
    };
    await runSteps(this.client, [
      {
        name: `${found ? 'update' : 'create'} saved search "${savedQueryName}"`,
        apply: async () => {
          if (found) {
            receiptId(
              await this.client.request<unknown>('POST', `savedQueries/${segment(found.id)}`, body, {fields: 'id'}),
              'saved search',
            );
          } else {
            const created = await this.client.request<unknown>(
              'POST',
              'savedQueries',
              {name: savedQueryName, $type: 'SavedQuery', ...body},
              {fields: 'id,name'},
            );
            queryId = receiptId(created, 'saved search');
          }
        },
      },
      {
        // `backlog` is a TOP-LEVEL attribute of the Agile, not part of sprintsSettings (a write there is silently
        // ignored). The read-back belongs to this step: an attach that reads back wrong was not applied, whatever
        // the POST answered, so the step is never listed as applied before its verification (YA-25 Y5).
        name: `attach backlog to "${b.name}"`,
        apply: async () => {
          receiptId(
            await this.client.request<unknown>(
              'POST',
              `agiles/${segment(b.id)}`,
              {backlog: {id: queryId, $type: 'SavedQuery'}},
              {fields: 'id'},
            ),
            'board',
          );
          const back = await this.client.request<{
            backlog: {id: string; query: string} | null;
          }>('GET', `agiles/${segment(b.id)}`, undefined, {fields: 'backlog(id,query)'});
          if (back?.backlog?.id !== queryId) {
            throw new Error(`board "${b.name}": backlog did not attach (read back ${JSON.stringify(back?.backlog)})`);
          }
        },
      },
    ]);
    this.client.log(
      `board "${b.name}": backlog = saved search "${savedQueryName}" (${query})${team ? `, shared with ${teamName}` : ', NOT shared (no team group found: set YOUTRACK_TEAM_GROUP)'}`,
    );
  }

  /**
   * Adds the bundle value and the swimlane. The board is resolved before either write, so a missing board changes
   * nothing. With no board named, the first board that includes the project is used (YA-8 NF4).
   */
  async addSubsystem(name: string, description = '', boardName = this.client.board): Promise<void> {
    const pid = await this.client.getProjectId();
    const pf = await this.client.collect<{id: string; bundle: {id: string}; field: {name: string}}>(
      `admin/projects/${segment(pid)}/customFields`,
      {
        $top: '100',
        fields: 'id,field(name),bundle(id)',
      },
    );
    const sub = pf.find((f) => f.field.name === 'Subsystem');
    if (!sub?.bundle) throw new Error('no Subsystem field on the project');
    const existing = (await this.client.field('Subsystem')).values;
    const boards = await this.client.collect<{
      id: string;
      name: string;
      projects?: {shortName: string}[];
      swimlaneSettings?: {values?: {name: string}[]};
    }>('agiles', {
      fields: 'id,name,projects(shortName),swimlaneSettings(values(name))',
    });
    const b = boardName
      ? boards.find((x) => x.name === boardName)
      : boards.find((x) => x.projects?.some((p) => p.shortName === this.client.project));
    if (!b) {
      throw new TrackerFailure(
        'not-found',
        boardName ? `board "${boardName}" not found` : `no board includes project ${this.client.project}`,
      );
    }
    const steps: AdminStep[] = [];
    if (!existing.some((v) => v.toLowerCase() === name.toLowerCase())) {
      steps.push({
        name: `add bundle value "${name}"`,
        apply: async () => {
          this.client.log(`add bundle value "${name}"`);
          const added = await this.client.request<unknown>(
            'POST',
            `admin/customFieldSettings/bundles/ownedField/${segment(sub.bundle.id)}/values`,
            {
              name,
              description,
              ordinal: existing.length,
              $type: 'OwnedBundleElement',
            },
            {fields: 'id'},
          );
          this.client.invalidateFields();
          receiptId(added, 'bundle value');
        },
      });
    }
    if (!(b.swimlaneSettings?.values ?? []).some((v) => v.name === name)) {
      steps.push({
        name: `add swimlane "${name}" on ${b.name}`,
        apply: async () => {
          this.client.log(`add swimlane "${name}" on ${b.name}`);
          const lane = await this.client.request<unknown>(
            'POST',
            `agiles/${segment(b.id)}/swimlaneSettings/values`,
            {name, $type: 'SwimlaneEntityAttributeValue'},
            {fields: 'id'},
          );
          receiptId(lane, 'swimlane');
        },
      });
    }
    await runSteps(this.client, steps);
  }
}
