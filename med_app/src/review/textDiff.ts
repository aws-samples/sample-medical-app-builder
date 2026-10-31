/**
 * A line diff for the raw view of a review — the two versions' text (the specs, else the manifests) as unified
 * hunks. Longest-common-subsequence on lines; manifests are a few hundred lines, so the quadratic table is cheap.
 */

export interface DiffLine {
  readonly type: 'same' | 'add' | 'del';
  readonly text: string;
  /** Line numbers in the old and the new text (1-based); absent on the side the line is not in. */
  readonly before?: number;
  readonly after?: number;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.length ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.length ? after.replace(/\n$/, '').split('\n') : [];
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]!, before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]!, before: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]!, after: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i]!, before: ++i });
  while (j < m) out.push({ type: 'add', text: b[j]!, after: ++j });
  return out;
}

export interface Hunk {
  readonly lines: readonly DiffLine[];
  /** Unchanged lines skipped before this hunk. */
  readonly skipped: number;
}

/** The changed lines with `context` unchanged lines around them; long unchanged runs are folded. */
export function hunks(lines: readonly DiffLine[], context = 3): Hunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: Hunk[] = [];
  let current: DiffLine[] | null = null;
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (!current) {
        current = [];
        out.push({ lines: current, skipped });
        skipped = 0;
      }
      current.push(l);
    } else {
      current = null;
      skipped++;
    }
  });
  return out;
}

export function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.type === 'add').length, removed: lines.filter((l) => l.type === 'del').length };
}
