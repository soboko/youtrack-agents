/** Shared fakes for the Alexa adapter tests. Everything is deterministic: no real timers, network or AWS. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DEFAULT_API_ENDPOINT_HOSTS, DEFAULT_POLICY, type AlexaSkillConfig} from '../../../src/voice/alexa/config.ts';
import type {FetchInit, FetchLike, HandlerClock} from '../../../src/voice/alexa/handler.ts';
import type {LogLevel, StoredState, UserStateStore, VoiceLogger, VoiceTracker} from '../../../src/voice/core/types.ts';

export const SKILL_ID = 'amzn1.ask.skill.00000000-1111-2222-3333-444444444444';
export const ENROLLED_PERSON_ID = 'amzn1.ask.person.ENROLLEDHOUSEHOLDMEMBER';
export const PERSON_TOKEN = 'Atza|PERSON-TOKEN-SECRET-1';
export const ACCOUNT_TOKEN = 'Atza|ACCOUNT-TOKEN-SECRET-2';
export const API_ACCESS_TOKEN = 'API-ACCESS-TOKEN-SECRET-3';
/** Every fixture's request timestamp, so the fake clock can start exactly there. */
export const FIXTURE_TIME = Date.parse('2026-09-12T10:00:00Z');

export function loadEnvelope(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/envelopes/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

export function testConfig(overrides: Partial<AlexaSkillConfig> = {}): AlexaSkillConfig {
  return {
    skillId: SKILL_ID,
    enrolledPersonId: ENROLLED_PERSON_ID,
    accountTokenFallback: false,
    cards: false,
    enrolmentLog: false,
    policy: DEFAULT_POLICY,
    progressiveAfterMs: 5000,
    answerByMs: 7000,
    apiEndpointHosts: DEFAULT_API_ENDPOINT_HOSTS,
    ...overrides,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

interface PendingTimer {
  due: number;
  fire: () => void;
  cancelled: boolean;
}

/**
 * A clock whose timers fire only when the test advances it. `timerArmed` resolves once the handler has armed a
 * given number of timers, so a test waits on the event it needs rather than on a count of event-loop turns.
 */
export class FakeClock implements HandlerClock {
  private current: number;
  private readonly timers: PendingTimer[] = [];
  private readonly armedWaiters: Array<{count: number; done: () => void}> = [];
  private readonly dueWaiters: Array<{due: number; done: () => void}> = [];

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimer(ms: number, fire: () => void): () => void {
    const timer: PendingTimer = {due: this.current + ms, fire, cancelled: false};
    this.timers.push(timer);
    for (const waiter of this.armedWaiters.filter((candidate) => candidate.count <= this.timers.length)) {
      this.armedWaiters.splice(this.armedWaiters.indexOf(waiter), 1);
      waiter.done();
    }
    for (const waiter of this.dueWaiters.filter((candidate) => candidate.due === timer.due)) {
      this.dueWaiters.splice(this.dueWaiters.indexOf(waiter), 1);
      waiter.done();
    }
    return () => {
      timer.cancelled = true;
    };
  }

  /** Resolves once a timer due at exactly `due` has been armed. */
  timerDue(due: number): Promise<void> {
    if (this.timers.some((timer) => timer.due === due)) return Promise.resolve();
    return new Promise((done) => {
      this.dueWaiters.push({due, done});
    });
  }

  timerArmed(count: number): Promise<void> {
    if (this.timers.length >= count) return Promise.resolve();
    return new Promise((done) => {
      this.armedWaiters.push({count, done});
    });
  }

  /** When each timer armed so far is due, in arming order. */
  get dueTimes(): number[] {
    return this.timers.map((timer) => timer.due);
  }

  /** Moves time forward, firing due timers in order. */
  advanceTo(time: number): void {
    const due = this.timers
      .filter((timer) => !timer.cancelled && timer.due <= time)
      .sort((left, right) => left.due - right.due);
    for (const timer of due) {
      this.current = timer.due;
      timer.cancelled = true;
      timer.fire();
    }
    this.current = time;
  }
}

export interface LogRecord {
  level: LogLevel;
  event: string;
  fields: Readonly<Record<string, unknown>>;
}

export interface CapturedLog {
  log: VoiceLogger;
  records: LogRecord[];
  /** Resolves with the first record of `event`, already logged or still to come. */
  waitFor(event: string): Promise<LogRecord>;
  /** Resolves once `count` records of `event` exist. */
  waitForCount(event: string, count: number): Promise<LogRecord[]>;
}

export function captureLog(): CapturedLog {
  const records: LogRecord[] = [];
  const waiters: Array<{event: string; count: number; done: (found: LogRecord[]) => void}> = [];
  const matching = (event: string) => records.filter((record) => record.event === event);
  const waitForCount = (event: string, count: number) => {
    const found = matching(event);
    if (found.length >= count) return Promise.resolve(found);
    return new Promise<LogRecord[]>((done) => {
      waiters.push({event, count, done});
    });
  };
  return {
    records,
    log: (level, event, fields = {}) => {
      records.push({level, event, fields});
      for (const waiter of [...waiters]) {
        const found = matching(waiter.event);
        if (found.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done(found);
        }
      }
    },
    waitFor: async (event) => (await waitForCount(event, 1))[0] as LogRecord,
    waitForCount,
  };
}

/** A versioned in-memory store with the contract's conditional save. */
export function memoryStore(): UserStateStore & {data: Map<string, StoredState>} {
  const data = new Map<string, StoredState>();
  return {
    data,
    load: async (userId) => data.get(userId) ?? null,
    save: async (userId, serialized, expectedVersion) => {
      const current = data.get(userId);
      if ((current?.version ?? null) !== expectedVersion) return false;
      data.set(userId, {serialized, version: String(Number(current?.version ?? '0') + 1)});
      return true;
    },
  };
}

/** A tracker that fails loudly if used: the handler never calls the tracker itself, only hands it to the core. */
export const UNUSED_TRACKER: VoiceTracker = {
  listIssues: async () => {
    throw new Error('the adapter must not call the tracker directly');
  },
  getIssue: async () => {
    throw new Error('the adapter must not call the tracker directly');
  },
  listComments: async () => {
    throw new Error('the adapter must not call the tracker directly');
  },
  listAssignees: async () => {
    throw new Error('the adapter must not call the tracker directly');
  },
};

export interface FetchCall {
  url: string;
  init: FetchInit;
}

export const DEVICE_TIME_ZONE = 'Europe/London';

export interface RecordingFetch {
  fetch: FetchLike;
  /** Every call, in order. */
  calls: FetchCall[];
  /** Progressive-response POSTs only. */
  posts: FetchCall[];
  /** Time-zone GETs only. */
  gets: FetchCall[];
  /** Resolves with the first POST. */
  called: Promise<FetchCall>;
}

/**
 * A fetch that records calls. GETs (the time-zone lookup) answer 200 with a JSON zone; POSTs (progressive responses)
 * answer `postStatus`.
 */
export function recordingFetch(postStatus = 204, timeZoneBody = JSON.stringify(DEVICE_TIME_ZONE)): RecordingFetch {
  const calls: FetchCall[] = [];
  const posts: FetchCall[] = [];
  const gets: FetchCall[] = [];
  const firstPost = deferred<FetchCall>();
  return {
    calls,
    posts,
    gets,
    called: firstPost.promise,
    fetch: async (url, init) => {
      const call = {url, init};
      calls.push(call);
      if (init.method === 'POST') {
        posts.push(call);
        firstPost.resolve(call);
        return {status: postStatus, text: async () => ''};
      }
      gets.push(call);
      return {status: 200, text: async () => timeZoneBody};
    },
  };
}
