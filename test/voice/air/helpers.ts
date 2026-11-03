/** Shared fakes for the air-quality tests. Deterministic: no network, no AWS, no real key. */
import type {AirFetch, AirFetchInit} from '../../../src/voice/air/purpleair.ts';
import type {LogLevel, VoiceLogger} from '../../../src/voice/core/types.ts';

/** A key-shaped canary. It must never appear in a log line or an error message. */
export const CANARY_KEY = 'PA-READ-KEY-CANARY-7f3c9e1d';

export interface Recorded {
  level: LogLevel;
  event: string;
  fields: Readonly<Record<string, unknown>>;
}

export function recordingLog(): {log: VoiceLogger; records: Recorded[]; text: () => string} {
  const records: Recorded[] = [];
  return {
    records,
    log: (level, event, fields = {}) => {
      records.push({level, event, fields});
    },
    text: () => JSON.stringify(records),
  };
}

export interface FetchCall {
  url: string;
  init: AirFetchInit;
}

/** A fetch that answers from `respond` and records each call. */
export function fakeFetch(respond: (call: FetchCall) => {status: number; body?: string} | Promise<never>): {
  fetch: AirFetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = {url, init};
      calls.push(call);
      const answer = await respond(call);
      return {status: answer.status, text: async () => answer.body ?? ''};
    },
  };
}

/** A PurpleAir `/v1/sensors` body, fields in the given order. */
export function sensorsBody(fields: readonly string[], data: readonly unknown[][]): string {
  return JSON.stringify({api_version: 'V1.0.15', time_stamp: 1757851200, max_age: 3600, fields, data});
}
