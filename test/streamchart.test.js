// Where a sample sits on the x axis.
//
// The stream charts draw with `.chart { overflow: visible }`, so a point placed outside
// the plot is not clipped — it draws across the page. That makes "every x is inside the
// domain" a hard requirement rather than a nicety, and it is the property this file
// pins down.
//
// The component is TypeScript, so the function under test is duplicated here rather than
// imported — there is no TS build step for the test runner, and the same trade is already
// made in trimpreview.test.js. If you change one, change both.

import test from 'node:test';
import assert from 'node:assert/strict';

/** Kept in step with `xAt` in web/src/charts/StreamChart.tsx. */
function xAt(xValues) {
  const out = new Array(xValues.length);
  let last = NaN;
  for (let i = 0; i < xValues.length; i++) {
    const v = xValues[i];
    if (v !== null && Number.isFinite(v)) last = v;
    out[i] = last;
  }
  const first = out.find((v) => Number.isFinite(v)) ?? 0;
  for (let i = 0; i < out.length && !Number.isFinite(out[i]); i++) out[i] = first;
  return out;
}

/** Extent of possibly-sparse data, ignoring nulls — as `extent` in primitives.tsx. */
function extent(values) {
  const finite = values.filter((v) => v !== null && Number.isFinite(v));
  return finite.length ? [Math.min(...finite), Math.max(...finite)] : null;
}

test('stream x: a gap holds the last reading rather than jumping', () => {
  const dist = [0, 10, 20, null, null, null, 30, 40];
  assert.deepEqual(xAt(dist), [0, 10, 20, 20, 20, 20, 30, 40]);
});

test('stream x: a gap at the very start borrows the first real reading', () => {
  const dist = [null, null, 4.5, 9, 14];
  assert.deepEqual(xAt(dist), [4.5, 4.5, 4.5, 9, 14]);
});

test('stream x: a gap at the end holds, so the line stops rather than flying off', () => {
  const dist = [0, 100, 200, null, null];
  assert.deepEqual(xAt(dist), [0, 100, 200, 200, 200]);
});

test('stream x: every position stays inside the plot', () => {
  // Activity 235's real shape after trimming: 1380 samples, 728.5 m, and five runs of
  // trackpoints carrying no distance — the last of them 80 samples long, at the end.
  // Substituting the sample INDEX for a missing distance (which is what this did) puts
  // that run at 1361 on a scale whose domain ends at 728.5: nearly twice the plot width,
  // drawn straight out of the card and across the page.
  const dist = new Array(1380).fill(null);
  for (let i = 0; i < 1380; i++) dist[i] = (i / 1379) * 728.5;
  for (const [from, to] of [[0, 3], [200, 219], [1050, 1059], [1174, 1239], [1282, 1361]]) {
    for (let i = from; i <= to; i++) dist[i] = null;
  }

  const [min, max] = extent(dist);
  const positions = xAt(dist);

  assert.equal(positions.length, dist.length);
  for (let i = 0; i < positions.length; i++) {
    assert.ok(
      Number.isFinite(positions[i]) && positions[i] >= min && positions[i] <= max,
      `sample ${i} sits at ${positions[i]}, outside the ${min}..${max} domain`,
    );
  }

  // And the old fallback really did leave the plot, so this is not a hypothetical.
  const worst = dist.map((v, i) => v ?? i).reduce((a, b) => Math.max(a, b), -Infinity);
  assert.ok(worst > max, 'the index fallback should overshoot the domain');
});

test('stream x: a channel with no readings at all does not throw', () => {
  assert.deepEqual(xAt([null, null, null]), [0, 0, 0]);
  assert.deepEqual(xAt([]), []);
});
