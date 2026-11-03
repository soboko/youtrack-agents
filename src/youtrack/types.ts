import type {AgentIdentity} from '../identity.ts';
import type {Config} from '../config.ts';

export interface ClientOptions {
  config?: Config;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  token?: string;
  project?: string; // short name, the part before the dash in issue ids
  identity: AgentIdentity;
  log?: (msg: string) => void;
}

export interface ProjectField {
  id: string; // project custom field id (e.g. 189-8)
  name: string; // "Stage"
  type: string; // YouTrack fieldType id: enum[1], state[1], user[1], string, ...
  canBeEmpty: boolean;
  values: string[]; // allowed value names for bundle fields, [] otherwise
}

export interface IssueFieldValue {
  name: string;
  value: unknown;
}

export interface Issue {
  id: string; // internal id (e.g. 3-12)
  idReadable: string; // e.g. PRJ-12
  summary: string;
  description: string | null;
  resolved: number | null;
  created: number;
  updated: number;
  reporter: string | null;
  fields: Record<string, unknown>; // field name -> plain value (name string, string[], number, null)
  /** Single-user fields only (e.g. Assignee): field name -> the user's login and full name. Absent when none is set. */
  users?: Record<string, {login: string; fullName: string | null}>;
  url: string;
}

export interface Comment {
  id: string;
  author: string | null;
  text: string;
  created: number;
}

export interface WorkItem {
  id: string;
  author: string | null;
  minutes: number;
  presentation: string; // "1h 15m"
  type: string | null; // Development | Testing | Documentation | Investigation | Implementation
  text: string | null;
  date: number;
}

export interface CreateIssueInput {
  summary: string;
  description?: string;
  fields?: Record<string, string | string[] | number | null>; // by field NAME, values by NAME
}
