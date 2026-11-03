import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cursorAtIndex, indexAtCursor, pageBackward, pageForward} from '../../../src/voice/core/paging.ts';
import type {PageRange} from '../../../src/voice/core/paging.ts';

const pieces = [
  {unit: 0, piece: 0},
  {unit: 1, piece: 0},
  {unit: 1, piece: 1},
  {unit: 2, piece: 0},
  {unit: 3, piece: 0},
];

test('cursors map to piece indexes and back, including past the end', () => {
  assert.equal(indexAtCursor(pieces, {unit: 0, piece: 0}), 0);
  assert.equal(indexAtCursor(pieces, {unit: 1, piece: 1}), 2);
  assert.equal(indexAtCursor(pieces, {unit: 1, piece: 5}), 3, 'a piece that no longer exists moves to the next unit');
  assert.equal(indexAtCursor(pieces, {unit: 9, piece: 0}), 5);
  assert.deepEqual(cursorAtIndex(pieces, 2), {unit: 1, piece: 1});
  assert.deepEqual(cursorAtIndex(pieces, 5), {unit: 4, piece: 0});
  assert.deepEqual(cursorAtIndex([], 0), {unit: 0, piece: 0});
});

test('a forward page takes up to the count, then shrinks until it fits, never below one piece', () => {
  const always = (): boolean => true;
  assert.deepEqual(pageForward(0, 5, 3, always), {start: 0, end: 3});
  assert.deepEqual(pageForward(3, 5, 3, always), {start: 3, end: 5});
  assert.equal(pageForward(5, 5, 3, always), null);
  const atMostTwo = (range: PageRange): boolean => range.end - range.start <= 2;
  assert.deepEqual(pageForward(0, 5, 5, atMostTwo), {start: 0, end: 2});
  assert.deepEqual(
    pageForward(1, 5, 5, () => false),
    {start: 1, end: 2},
  );
});

test('a backward page ends where the last one started and shrinks from its far end', () => {
  const always = (): boolean => true;
  assert.deepEqual(pageBackward(5, 3, always), {start: 2, end: 5});
  assert.deepEqual(pageBackward(2, 3, always), {start: 0, end: 2});
  assert.equal(pageBackward(0, 3, always), null);
  assert.deepEqual(
    pageBackward(5, 5, (range) => range.end - range.start <= 2),
    {start: 3, end: 5},
  );
});
