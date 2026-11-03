import {formatTokens, type Issue} from '../../client.ts';

const SHOW_FIELDS = [
  'Type',
  'Priority',
  'State',
  'Subsystem',
  'Role',
  'Assignee',
  'Estimation',
  'Spent time',
  'Token Estimate',
  'Actual Tokens',
  'AI Model',
  'AI Session ID',
];

export function fmtIssue(i: Issue, verbose = false): string {
  const f = (k: string) => {
    const v = i.fields[k];
    if (k === 'Token Estimate' || k === 'Actual Tokens') return formatTokens(v);
    return v === null || v === undefined ? '-' : Array.isArray(v) ? v.join(',') : String(v);
  };
  const head = `${i.idReadable}  [${f('State')}]  ${f('Subsystem')}  ${i.summary}`;
  if (!verbose) return head;
  const lines = [head, `  ${i.url}`, `  ${SHOW_FIELDS.map((k) => `${k}: ${f(k)}`).join('  ')}`];
  const others = Object.keys(i.fields).filter(
    (k) =>
      !SHOW_FIELDS.includes(k) &&
      i.fields[k] !== null &&
      !(Array.isArray(i.fields[k]) && (i.fields[k] as unknown[]).length === 0),
  );
  if (others.length) lines.push(`  ${others.map((k) => `${k}: ${f(k)}`).join('  ')}`);
  if (i.description)
    lines.push(
      '',
      i.description
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    );
  return lines.join('\n');
}

export const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
