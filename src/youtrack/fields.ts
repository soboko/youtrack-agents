import type {ProjectField} from './types.ts';
import {TrackerFailure} from '../tracker.ts';

export const ISSUE_FIELD_TYPES: Record<string, string> = {
  'enum[1]': 'SingleEnumIssueCustomField',
  'enum[*]': 'MultiEnumIssueCustomField',
  'state[1]': 'StateIssueCustomField',
  'user[1]': 'SingleUserIssueCustomField',
  'user[*]': 'MultiUserIssueCustomField',
  'ownedField[1]': 'SingleOwnedIssueCustomField',
  'ownedField[*]': 'MultiOwnedIssueCustomField',
  'version[1]': 'SingleVersionIssueCustomField',
  'version[*]': 'MultiVersionIssueCustomField',
  'build[1]': 'SingleBuildIssueCustomField',
  'build[*]': 'MultiBuildIssueCustomField',
  'group[1]': 'SingleGroupIssueCustomField',
  'group[*]': 'MultiGroupIssueCustomField',
  string: 'SimpleIssueCustomField',
  text: 'TextIssueCustomField',
  integer: 'SimpleIssueCustomField',
  float: 'SimpleIssueCustomField',
  date: 'DateIssueCustomField',
  'date and time': 'DateIssueCustomField',
  period: 'PeriodIssueCustomField',
};

const isBundleType = (t: string) => /^(enum|state|user|ownedField|version|build|group)\[/.test(t);
const isMulti = (t: string) => t.endsWith('[*]');

function resolveValue(f: ProjectField, v: string): string {
  if (!isBundleType(f.type)) return v;
  if (f.type.startsWith('user')) return v; // users are matched by login server-side
  const hit = f.values.find((x) => x.toLowerCase() === v.toLowerCase());
  if (!hit)
    throw new TrackerFailure('validation', `"${v}" is not a value of ${f.name}; allowed: ${f.values.join(' | ')}`);
  return hit;
}

/** Encodes one validated project field using YouTrack issue custom-field shapes. */
export function encodeField(f: ProjectField, value: string | string[] | number | null): Record<string, unknown> {
  const $type = ISSUE_FIELD_TYPES[f.type];
  if (!$type)
    throw new TrackerFailure(
      'unsupported',
      `field ${f.name} has type ${f.type}, which this client does not know how to set`,
    );
  const base = {name: f.name, $type};
  if (value === null || value === '') return {...base, value: null};
  if (isBundleType(f.type)) {
    const wrap = (v: string) => (f.type.startsWith('user') ? {login: v} : {name: v});
    if (isMulti(f.type)) {
      const arr = Array.isArray(value)
        ? value
        : String(value)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      return {
        ...base,
        value: arr.map((v) => wrap(resolveValue(f, v))),
      };
    }
    return {...base, value: wrap(resolveValue(f, String(value)))};
  }
  if (f.type === 'date' || f.type === 'date and time') {
    const ms = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(ms)) throw new TrackerFailure('validation', `bad date for ${f.name}: ${value}`);
    return {...base, value: ms};
  }
  if (f.type === 'period') return {...base, value: {presentation: String(value)}};
  if (f.type === 'integer' || f.type === 'float') {
    const number = Number(value);
    if (!Number.isFinite(number) || (f.type === 'integer' && !Number.isSafeInteger(number))) {
      throw new TrackerFailure('validation', `Invalid numeric value for ${f.name}`);
    }
    return {...base, value: number};
  }
  return {...base, value: String(value)};
}
