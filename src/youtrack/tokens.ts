import {parseTokenMillions} from '../accounting/actuals.ts';

// Token fields hold MILLIONS of tokens as a float (25 = 25M, 0.2 = 200k), so cards and column totals stay short.
// Inputs accept "25M", "1.5m", "250k", "250K", or a bare number, which is read as millions when it has a decimal
// point or is under 1000 and as a raw token count otherwise ("1500000" -> 1.5).
export function parseTokens(input: string | number): number {
  return parseTokenMillions(input);
}

export function formatTokens(millions: unknown): string {
  if (millions === null || millions === undefined || millions === '') return '-';
  const m = Number(millions);
  if (Number.isNaN(m)) return String(millions);
  if (m >= 1) return `${Number(m.toFixed(2))}M`;
  return `${Math.round(m * 1000)}k`;
}
