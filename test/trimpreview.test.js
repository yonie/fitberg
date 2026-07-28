// The trim preview's index arithmetic.
//
// Drawing it needs a GPU, so the rendering itself is checked by eye. This covers the
// half that gets things wrong: which pieces of the route are struck through, where the
// two cut markers land, and the edge cases that would otherwise throw or draw nonsense.
//
// The component is TypeScript, so the function under test is duplicated here rather than
// imported — there is no TS build step for the test runner. It is fifteen lines and the
// duplication is worth more than a build pipeline. If you change one, change both.

import test from 'node:test';
import assert from 'node:assert/strict';

/** Kept in step with `trimPreview` in web/src/components/Flyover.tsx. */
function trimPreview(coordinates, trim) {
  const n = coordinates.length;
  const none = { discarded: [], cuts: [] };
  if (!trim || n < 2) return none;

  const clamp = (v) => Math.max(0, Math.min(n - 1, Math.round(v)));
  const from = clamp(trim.from);
  const to = clamp(trim.to);

  if (to <= from) return none;
  if (from <= 0 && to >= n - 1) return none;

  const discarded = [coordinates.slice(0, from + 1), coordinates.slice(to)]
    .filter((piece) => piece.length >= 2);

  return { discarded, cuts: [coordinates[from], coordinates[to]] };
}

/** A hundred points along a line, which is enough to reason about indices. */
const route = Array.from({ length: 100 }, (_, i) => [5 + i * 0.001, 45 + i * 0.001]);

test('trim preview: both ends trimmed gives two struck-through pieces and two cuts', () => {
  const { discarded, cuts } = trimPreview(route, { from: 20, to: 70 });

  assert.equal(discarded.length, 2);
  // The first piece runs from the start up to and including the cut, so the struck-out
  // section visually meets the kept section rather than leaving a gap.
  assert.equal(discarded[0].length, 21);
  assert.deepEqual(discarded[0][0], route[0]);
  assert.deepEqual(discarded[0].at(-1), route[20]);

  assert.equal(discarded[1].length, 30);
  assert.deepEqual(discarded[1][0], route[70]);
  assert.deepEqual(discarded[1].at(-1), route[99]);

  assert.deepEqual(cuts, [route[20], route[70]]);
});

test('trim preview: trimming only the tail leaves one piece', () => {
  const { discarded, cuts } = trimPreview(route, { from: 0, to: 60 });
  assert.equal(discarded.length, 1, 'nothing is discarded at the start');
  assert.deepEqual(discarded[0][0], route[60]);
  assert.deepEqual(cuts, [route[0], route[60]]);
});

test('trim preview: trimming only the head leaves one piece', () => {
  const { discarded } = trimPreview(route, { from: 30, to: 99 });
  assert.equal(discarded.length, 1);
  assert.deepEqual(discarded[0].at(-1), route[30]);
});

test('trim preview: nothing to show when nothing is trimmed', () => {
  assert.deepEqual(trimPreview(route, { from: 0, to: 99 }), { discarded: [], cuts: [] });
  assert.deepEqual(trimPreview(route, null), { discarded: [], cuts: [] });
  assert.deepEqual(trimPreview(route, undefined), { discarded: [], cuts: [] });
});

test('trim preview: nonsense input draws nothing rather than throwing', () => {
  // Handles crossed.
  assert.deepEqual(trimPreview(route, { from: 80, to: 20 }), { discarded: [], cuts: [] });
  // Identical handles.
  assert.deepEqual(trimPreview(route, { from: 50, to: 50 }), { discarded: [], cuts: [] });
  // Out of range in both directions.
  const clamped = trimPreview(route, { from: -500, to: 5000 });
  assert.deepEqual(clamped, { discarded: [], cuts: [] }, 'clamps to the whole route');
  // Too few points to draw.
  assert.deepEqual(trimPreview([route[0]], { from: 0, to: 1 }), { discarded: [], cuts: [] });
  assert.deepEqual(trimPreview([], { from: 0, to: 1 }), { discarded: [], cuts: [] });
});

test('trim preview: a one-point piece is dropped, not drawn', () => {
  // from=0 discards coordinates.slice(0,1) — a single point, which is not a line.
  const { discarded } = trimPreview(route, { from: 0, to: 50 });
  assert.ok(discarded.every((piece) => piece.length >= 2));

  // to=99 discards coordinates.slice(99) — also a single point.
  const tail = trimPreview(route, { from: 40, to: 99 });
  assert.ok(tail.discarded.every((piece) => piece.length >= 2));
});
