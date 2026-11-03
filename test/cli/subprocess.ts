// Subprocess tests run real startup code, which discovers credentials on its own. Every child gets a fresh fake home
// and a deadline so it can never hang the suite (YA-8 review T12, T13). Its working directory sits inside that fresh
// root, and YOUTRACK_ENV_FILE names an existing empty file there: the first existing candidate ends config discovery,
// so the upward walk never reaches the ancestors of the OS temp directory, where anyone may plant an `.env.youtrack`
// (YA-25 Y8). A test that wants a config file points YOUTRACK_ENV_FILE at its own.
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import type {SpawnSyncReturns} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Long enough for a cold `node` start on a loaded machine; far below the suite's 30 s per-test timeout. */
export const SUBPROCESS_TIMEOUT_MS = 10_000;

export interface Isolated {
  /** A fresh empty root used as HOME and XDG_CONFIG_HOME's parent; the working directory is inside it. */
  home: string;
  /** The child's working directory, `home/work`. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A fake home removed when the test ends; `extra` adds variables, never the parent's environment. */
export function isolated(t: {after: (fn: () => void) => void}, extra: NodeJS.ProcessEnv = {}): Isolated {
  const home = mkdtempSync(join(tmpdir(), 'ya25-home-'));
  t.after(() => {
    rmSync(home, {recursive: true, force: true});
  });
  const cwd = join(home, 'work');
  mkdirSync(cwd);
  const stop = join(home, 'empty.env');
  writeFileSync(stop, '');
  return {
    home,
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      YOUTRACK_ENV_FILE: stop,
      ...extra,
    },
  };
}

/** `node` with the given arguments in the sandbox's working directory, killed at the deadline; a timeout fails the test, not the suite. */
export function runNode(sandbox: Isolated, args: string[]): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, args, {
    cwd: sandbox.cwd,
    encoding: 'utf8',
    env: sandbox.env,
    timeout: SUBPROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined, `subprocess failed to finish: ${String(result.error)}`);
  assert.equal(result.signal, null, `subprocess killed by ${result.signal}`);
  return result;
}
