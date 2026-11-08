// Minimal line diff. Zero dependencies.
//
// We only need two things from a diff:
//   1. which lines were removed and which were added (with line numbers), and
//   2. which removals and additions belong together (hunks), so that a changed
//      line can be compared with the line it replaced.
//
// Strategy: trim the common prefix and suffix, then run an LCS on the middle.
// If the middle is too large for the O(n*m) table we treat it as a single
// replace hunk. Count-based rules stay correct in that case because they work
// on net counts; only line pairing gets coarser.

const MAX_LCS_CELLS = 4_000_000;

/**
 * @typedef {{ line: number, text: string }} DiffLine   1-based line number
 * @typedef {{ removed: DiffLine[], added: DiffLine[], anchor: number }} Hunk
 *   `anchor` is the 1-based line in the new file closest to the hunk, useful
 *   for reporting removals (which have no line in the new file).
 */

/** @param {string | null | undefined} text */
export function splitLines(text) {
  if (text == null || text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * @param {string[]} a old lines
 * @param {string[]} b new lines
 * @returns {Hunk[]}
 */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];

  /** @type {Array<{ op: '=' | '-' | '+', ai: number, bi: number }>} */
  let ops;
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    ops = [
      ...midA.map((_, i) => ({ op: /** @type {'-'} */ ('-'), ai: i, bi: 0 })),
      ...midB.map((_, j) => ({ op: /** @type {'+'} */ ('+'), ai: midA.length, bi: j })),
    ];
  } else {
    ops = lcsOps(midA, midB);
  }

  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {Hunk | null} */
  let current = null;
  for (const o of ops) {
    if (o.op === '=') {
      current = null;
      continue;
    }
    if (!current) {
      current = { removed: [], added: [], anchor: Math.max(1, start + o.bi + 1) };
      hunks.push(current);
    }
    if (o.op === '-') current.removed.push({ line: start + o.ai + 1, text: midA[o.ai] });
    else current.added.push({ line: start + o.bi + 1, text: midB[o.bi] });
  }
  for (const h of hunks) {
    if (h.added.length) h.anchor = h.added[0].line;
    else h.anchor = Math.min(h.anchor, Math.max(1, b.length));
  }
  return hunks;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  /** @type {Array<{ op: '=' | '-' | '+', ai: number, bi: number }>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: '=', ai: i, bi: j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ op: '-', ai: i, bi: j });
      i++;
    } else {
      ops.push({ op: '+', ai: i, bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ op: '-', ai: i++, bi: j });
  while (j < m) ops.push({ op: '+', ai: i, bi: j++ });
  return ops;
}
