/**
 * Spoken search through the binding against a tracker that filters the way YouTrack does (YA-15 review F1): summary
 * words matched exactly, any one of them enough, newest first, cut at `limit`, with no fuzzy threshold. The core's own
 * `FakeVoiceTracker` filters by fuzzy score, so its transcripts cannot show a stopword flooding the list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {IssueFilter, TrackerIssue} from '../../../src/tracker.ts';
import {createVoiceTracker, type VoiceTrackerPort} from '../../../src/voice/binding/voice-tracker.ts';
import {converse, DEFAULT_POLICY} from '../../../src/voice/core/converse.ts';
import {MemoryStateStore} from '../../../src/voice/core/fakes.ts';
import type {VoiceRequest} from '../../../src/voice/core/types.ts';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const DAY_MS = 86_400_000;

function issue(key: string, summary: string, updated: number): TrackerIssue {
  return {
    id: `2-${key.slice(2)}`,
    key,
    summary,
    description: null,
    url: `https://household.youtrack.example/issue/${key}`,
    updated,
    workflow: {state: 'Open', role: null, assignee: 'household', recommendedModel: null, subsystem: null},
  };
}

/** Any-word exact summary match, newest first, capped: what `summary: "a" or summary: "b"` and `$top` do. */
function portShaped(issues: TrackerIssue[]): {port: VoiceTrackerPort; filters: IssueFilter[]} {
  const filters: IssueFilter[] = [];
  const wordsOf = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  return {
    filters,
    port: {
      listIssues: async (filter) => {
        filters.push(filter);
        const wanted = wordsOf(filter.text ?? '');
        const found = issues
          .filter((candidate) => {
            if (filter.text === undefined) return true;
            const summary = wordsOf(candidate.summary);
            return filter.textMode === 'any'
              ? wanted.some((word) => summary.includes(word))
              : wanted.every((word) => summary.includes(word));
          })
          .sort((left, right) => right.updated - left.updated);
        const limit = filter.limit ?? 50;
        return {issues: found.slice(0, limit), complete: found.length <= limit};
      },
      getIssue: async (key) => {
        const found = issues.find((candidate) => candidate.key === key);
        if (!found) throw new Error(`no ${key}`);
        return found;
      },
      listComments: async () => ({comments: [], complete: true}),
    },
  };
}

async function say(port: VoiceTrackerPort, text: string): Promise<string> {
  const request: VoiceRequest = {
    input: {kind: 'utterance', text},
    speaker: {userId: 'test:1', evidence: ['person']},
    locale: 'en-GB',
    capabilities: {ssml: false, earcons: true, display: false, followUp: true, maxSpeechChars: 1000},
    requestId: 'r1',
  };
  const response = await converse(request, {
    tracker: createVoiceTracker(port, {project: 'H'}),
    store: new MemoryStateStore(),
    policy: DEFAULT_POLICY,
    now: () => NOW,
    log: () => {},
  });
  return response.segments.map((segment) => segment.text).join(' ');
}

test('"find issue about car tax" in a small project opens the car tax issue, with no noise matches', async () => {
  const {port, filters} = portShaped([
    issue('H-1', 'Book the boiler service', NOW - 90 * DAY_MS),
    issue('H-70', 'Renew the car tax', NOW - 50 * DAY_MS),
    issue('H-71', 'Fix login page', NOW),
    issue('H-72', 'Garden issue', NOW),
    issue('H-73', 'Issue with the bins', NOW),
  ]);
  const heard = await say(port, 'find issue about car tax');
  assert.match(heard, /^1 issue matches\. .*Renew the car tax/);
  assert.doesNotMatch(heard, /Garden|bins/);
  assert.deepEqual(
    filters.map((filter) => filter.text),
    ['car tax'],
  );
});

test('"find the issue about the boiler" finds a 90-day-old issue behind 60 recent issues that say "issue"', async () => {
  const issues = [issue('H-1', 'Book the boiler service', NOW - 90 * DAY_MS)];
  for (let n = 2; n < 62; n++) issues.push(issue(`H-${n}`, `Chore ${n} issue with the rota`, NOW - n * 3_600_000));
  const {port, filters} = portShaped(issues);
  const heard = await say(port, 'find the issue about the boiler');
  assert.match(heard, /^1 issue matches\. .*Book the boiler service/);
  assert.doesNotMatch(heard, /at least|Chore/);
  assert.deepEqual(
    filters.map((filter) => filter.text),
    ['boiler'],
  );
});
