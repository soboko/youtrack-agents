import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertAccountingSupported, parseTokenMillions, validateActual} from '../../src/accounting/actuals.ts';
import {TrackerFailure} from '../../src/tracker.ts';

test('token notation retains existing millions/raw-count convention without rounding away small contributions', () => {
  for (const [input, expected] of [
    ['25M', 25],
    ['250k', 0.25],
    ['1500000', 1.5],
    [25, 25],
    [1000, 0.001],
    ['0.000001M', 0.000001],
    ['0', 0],
  ] as const) {
    assert.equal(parseTokenMillions(input), expected);
  }
});

test('invalid numeric input never becomes a zero or an unsafe floating-point aggregate', () => {
  for (const input of [-1, NaN, Infinity, -Infinity, 'Infinity', '-1M', '', '1e3', '0.0000001M', 1e30]) {
    assert.throws(() => parseTokenMillions(input), {kind: 'validation'});
  }
});

test('whole request validation preserves work metadata and rejects empty requests', () => {
  assert.deepEqual(validateActual({time: ' 1h ', text: 'review', type: 'Testing'}), {
    time: '1h',
    tokens: undefined,
    text: 'review',
    type: 'Testing',
  });
  for (const input of [{}, {time: ' '}, {time: '1h', type: ' '}, {time: '1h', tokens: NaN}]) {
    assert.throws(() => validateActual(input), {kind: 'validation'});
  }
});

test('unsupported token accounting rejects a mixed request before callers may start time logging', () => {
  for (const input of [{tokens: '1M'}, {time: '1h', tokens: '1M'}, {time: '1h', tokens: 0}]) {
    const actual = validateActual(input);
    assert.throws(
      () => assertAccountingSupported(actual, {atomicAccounting: false}),
      (error: unknown) => {
        assert.ok(error instanceof TrackerFailure);
        assert.equal(error.kind, 'unsupported');
        assert.match(error.message, /Nothing was written, including any requested time/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => assertAccountingSupported(validateActual({time: '1h'}), {atomicAccounting: false}));
});
