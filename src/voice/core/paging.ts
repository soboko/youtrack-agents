/**
 * Paging (design rule 3). Lists and parts are sequences of pieces: a list item, a paragraph or a comment is a unit,
 * and a unit too long for one response is split into pieces. A page is a run of pieces that fits both the verbosity's
 * count and the platform's speech limit.
 *
 * Positions are cursors, `{unit, piece}`, not page numbers, and a page is always fitted from the cursor. So "more"
 * continues exactly where the last page ended, even after the verbosity or the speech limit changed, and "previous"
 * walks back from where the last page started.
 */

/** A position in a paged sequence: the unit (0-based) and the piece within it. */
export interface Cursor {
  unit: number;
  piece: number;
}

/** Anything with a cursor position. */
export interface Positioned {
  unit: number;
  piece: number;
}

export interface PageRange {
  /** Index of the first piece on the page. */
  start: number;
  /** One past the index of the last piece on the page. */
  end: number;
}

/** The index of the first piece at or after `cursor`; the piece count when the cursor is past the end. */
export function indexAtCursor(pieces: readonly Positioned[], cursor: Cursor): number {
  const index = pieces.findIndex(
    (piece) => piece.unit > cursor.unit || (piece.unit === cursor.unit && piece.piece >= cursor.piece),
  );
  return index === -1 ? pieces.length : index;
}

/** The cursor of the piece at `index`, or the cursor just past the last unit when `index` is at the end. */
export function cursorAtIndex(pieces: readonly Positioned[], index: number): Cursor {
  if (index < pieces.length) return {unit: pieces[index].unit, piece: pieces[index].piece};
  const last = pieces.at(-1);
  return {unit: last === undefined ? 0 : last.unit + 1, piece: 0};
}

/**
 * The page starting at `start`: up to `perPage` pieces, shortened one piece at a time until `fits` accepts it. A
 * page always holds at least one piece. Null when `start` is past the end.
 */
export function pageForward(
  start: number,
  count: number,
  perPage: number,
  fits: (range: PageRange) => boolean,
): PageRange | null {
  if (start >= count) return null;
  let end = Math.min(count, start + Math.max(perPage, 1));
  while (end - start > 1 && !fits({start, end})) end--;
  return {start, end};
}

/** The page ending just before `end`, fitted the same way from the other side. Null when `end` is the start. */
export function pageBackward(end: number, perPage: number, fits: (range: PageRange) => boolean): PageRange | null {
  if (end <= 0) return null;
  let start = Math.max(0, end - Math.max(perPage, 1));
  while (end - start > 1 && !fits({start, end})) start++;
  return {start, end};
}
