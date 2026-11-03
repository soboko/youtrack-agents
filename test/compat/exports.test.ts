// Root entry points are imported by host repositories, so YA-8's move into src/ must not remove anything they
// could import (acceptance item 6). The names below are the baseline's, hard-coded rather than derived, so a
// removal fails here instead of being absorbed into a regenerated list.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import * as client from '../../client.ts';
import * as identity from '../../identity.ts';
import type {
  ClientOptions,
  Comment,
  Config,
  CreateIssueInput,
  Issue,
  IssueFieldValue,
  ProjectField,
  WorkItem,
} from '../../client.ts';
import type {AgentIdentity, IdentityOverrides} from '../../identity.ts';

// Runtime exports of `git show 15d2245:client.ts` (the last commit before YA-8).
const BASELINE_CLIENT_VALUES = [
  'CONFIG_FILES',
  'DEFAULT_BASE_URL',
  'DEFAULT_PROJECT',
  'YouTrackClient',
  'YouTrackError',
  'configFiles',
  'createClient',
  'formatTokens',
  'loadConfig',
  'parseTokens',
];

// Runtime exports of `git show 15d2245:identity.ts`.
const BASELINE_IDENTITY_VALUES = ['resolveIdentity'];

/**
 * Type exports of `15d2245:client.ts` and `15d2245:identity.ts`. Types vanish at runtime, so `npm run typecheck`
 * is what guards them: removing any one of these from a root entry point fails to compile here.
 */
export type BaselineTypes = [
  ClientOptions,
  Comment,
  Config,
  CreateIssueInput,
  Issue,
  IssueFieldValue,
  ProjectField,
  WorkItem,
  AgentIdentity,
  IdentityOverrides,
];

function missing(module: object, baseline: string[]): string[] {
  return baseline.filter((name) => !(name in module));
}

test('client.ts still exports every baseline runtime name', () => {
  assert.deepEqual(missing(client, BASELINE_CLIENT_VALUES), []);
  assert.equal(typeof client.YouTrackError, 'function');
  assert.equal(typeof client.parseTokens, 'function');
  assert.ok(new client.YouTrackError(500, '', 'boom') instanceof Error);
  assert.equal(client.parseTokens('1.5M'), 1.5);
});

test('identity.ts still exports every baseline runtime name', () => {
  assert.deepEqual(missing(identity, BASELINE_IDENTITY_VALUES), []);
  assert.equal(typeof identity.resolveIdentity, 'function');
});

test('yt.ts stays an executable with no exports, as in the baseline', () => {
  // Importing yt.ts would run the CLI, so its shape is checked from the source and the package manifest.
  const source = readFileSync(new URL('../../yt.ts', import.meta.url), 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node\n/);
  assert.doesNotMatch(source, /^\s*export\b/m);
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    bin: Record<string, string>;
  };
  assert.equal(manifest.bin.yt, './yt.ts');
});
