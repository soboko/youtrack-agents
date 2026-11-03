/**
 * A `UserStateStore` in a directory, one file per person, so the text adapter resumes across runs.
 *
 * The version is a hash of the file's content, so it does not depend on timestamps. A save takes an exclusive lock
 * file (created with `wx`, so two savers, in one process or two, cannot both hold it), checks the stored version
 * still matches, writes a temporary file and renames it into place, then removes the lock. A lock left behind by a
 * crashed process is taken over once it is older than `STALE_LOCK_MS`. An interrupted write never leaves half a
 * state behind.
 */
import {createHash, randomBytes} from 'node:crypto';
import {chmod, mkdir, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {StoredState, UserStateStore} from '../core/types.ts';

/** A lock older than this belonged to a process that died mid-save. */
export const STALE_LOCK_MS = 10_000;
/** How long a save waits for another save's lock before giving up with an error. */
export const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 5;

function versionOf(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  // Node's file errors carry a string code.
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class FileStateStore implements UserStateStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /** The file for a person. The id is percent-encoded (dots too), so it can never name a path outside the directory. */
  fileFor(userId: string): string {
    return join(this.directory, `${encodeURIComponent(userId).replace(/\./g, '%2E')}.json`);
  }

  async load(userId: string): Promise<StoredState | null> {
    try {
      const serialized = await readFile(this.fileFor(userId), 'utf8');
      return {serialized, version: versionOf(serialized)};
    } catch (error) {
      // A missing file is a person with no state yet.
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async save(userId: string, serialized: string, expectedVersion: string | null): Promise<boolean> {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    // mkdir does not tighten a directory that already existed.
    await chmod(this.directory, 0o700);
    const target = this.fileFor(userId);
    const lock = `${target}.lock`;
    await this.acquire(lock);
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const current = await this.load(userId);
      if ((current?.version ?? null) !== expectedVersion) return false;
      await writeFile(temporary, serialized, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      await rename(temporary, target);
      return true;
    } finally {
      await rm(temporary, {force: true});
      await rm(lock, {force: true});
    }
  }

  private async acquire(lock: string): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lock, 'wx', 0o600);
        await handle.close();
        return;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > STALE_LOCK_MS) {
          await rm(lock, {force: true});
          continue;
        }
      } catch (error) {
        // The lock was released between the failed create and the stat: try again straight away.
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting for the state file lock');
      await pause(LOCK_RETRY_MS);
    }
  }
}
