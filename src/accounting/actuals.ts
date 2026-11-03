import {TrackerFailure} from '../tracker.ts';

/** User input uses the existing CLI convention: small bare numbers represent millions. */
export interface ActualInput {
  time?: string;
  tokens?: number | string;
  text?: string;
  type?: string;
}

/** Token quantities are normalized to millions; durations remain provider-interpreted. */
export interface ValidatedActual {
  time?: string;
  tokens?: number;
  text?: string;
  type?: string;
}

/** Parse the historical token notation without accepting negative, infinite or fractional-token counts. */
export function parseTokenMillions(input: number | string): number {
  let quantity: number;
  let suffix = '';
  if (typeof input === 'number') {
    quantity = input;
  } else {
    const match = /^\s*([0-9]*\.?[0-9]+)\s*([kKmM]?)\s*$/.exec(input);
    if (!match) {
      throw new TrackerFailure('validation', 'Invalid token count: use 25M, 250k, 1.5M or a raw count.');
    }
    quantity = Number(match[1]);
    suffix = match[2].toLowerCase();
  }

  const millions =
    suffix === 'm' ? quantity : suffix === 'k' ? quantity / 1000 : quantity >= 1000 ? quantity / 1e6 : quantity;
  const rawTokens = millions * 1e6;
  // Decimal conversion can introduce sub-ULP error; rounding is allowed only within floating precision.
  const rounded = Math.round(rawTokens);
  const tolerance = Number.EPSILON * Math.max(1, rawTokens);
  if (
    !Number.isFinite(millions) ||
    millions < 0 ||
    !Number.isSafeInteger(rounded) ||
    Math.abs(rawTokens - rounded) > tolerance
  ) {
    throw new TrackerFailure(
      'validation',
      'Token count must be nonnegative, finite and a safe whole number of tokens.',
    );
  }
  return rounded / 1e6;
}

/** Validate the entire request before any read or mutation, including a mixed time/token request. */
export function validateActual(input: ActualInput): ValidatedActual {
  if (input.time === undefined && input.tokens === undefined) {
    throw new TrackerFailure('validation', 'Actuals require time or tokens.');
  }
  if (input.time !== undefined && !input.time.trim()) {
    throw new TrackerFailure('validation', 'Actual time must be a nonempty duration.');
  }
  if (input.type !== undefined && !input.type.trim()) {
    throw new TrackerFailure('validation', 'Work item type must be nonempty.');
  }
  return {
    time: input.time?.trim(),
    tokens: input.tokens === undefined ? undefined : parseTokenMillions(input.tokens),
    text: input.text,
    type: input.type,
  };
}

/** Require provider-side accounting guarantees; local locks cannot coordinate other machines. */
export function assertAccountingSupported(
  actual: ValidatedActual,
  capabilities: {readonly atomicAccounting: boolean},
): void {
  if (actual.tokens !== undefined && !capabilities.atomicAccounting) {
    throw new TrackerFailure(
      'unsupported',
      'Token increments require atomic, retry-safe provider accounting, which this adapter does not support. ' +
        'Nothing was written, including any requested time. Submit time separately; reconcile tokens with the owner.',
    );
  }
}
