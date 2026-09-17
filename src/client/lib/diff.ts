export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Words and the whitespace after them, so joining the parts gives back the original text. */
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

const MAX_CELLS = 4_000_000;

/**
 * Word diff of two texts by longest common subsequence. Very long pairs fall back to comparing
 * lines, which keeps the table small.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  let a = tokens(before);
  let b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    a = before.split(/(?<=\n)/);
    b = after.split(/(?<=\n)/);
  }

  // lengths[i][j] = LCS length of a[i:] and b[j:].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lengths[i] as Uint32Array;
    const next = lengths[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = normalize(a[i]) === normalize(b[j]) ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (normalize(a[i]) === normalize(b[j])) {
      push('same', b[j] as string);
      i++;
      j++;
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      push('removed', a[i++] as string);
    } else {
      push('added', b[j++] as string);
    }
  }
  while (i < a.length) push('removed', a[i++] as string);
  while (j < b.length) push('added', b[j++] as string);
  return parts;
}

function normalize(token: string | undefined): string {
  return (token ?? '').trim();
}

/** Share of the words the two texts have in common, from 0 to 1. */
export function overlap(parts: DiffPart[]): number {
  const count = (kind: DiffPart['kind']) => parts.filter((part) => part.kind === kind).reduce((sum, part) => sum + tokens(part.text).length, 0);
  const same = count('same');
  const total = same + Math.max(count('added'), count('removed'));
  return total === 0 ? 1 : same / total;
}
