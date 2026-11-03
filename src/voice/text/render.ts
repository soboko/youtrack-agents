/**
 * Plain-text rendering of a voice response, shared by the text adapter and the transcript tests so that what a
 * transcript expects is exactly what the household sees: an earcon line, then one line per speech segment.
 */
import type {VoiceResponse} from '../core/types.ts';

export function renderLines(response: VoiceResponse): string[] {
  const lines: string[] = [];
  if (response.earcon !== undefined) lines.push(`[earcon: ${response.earcon}]`);
  for (const segment of response.segments) lines.push(segment.text);
  return lines;
}

/** macOS `say` takes words per minute; its default voice runs at about 175. */
export const SAY_DEFAULT_WORDS_PER_MINUTE = 175;

export function sayWordsPerMinute(ratePercent: number): number {
  return Math.round((SAY_DEFAULT_WORDS_PER_MINUTE * ratePercent) / 100);
}
