/**
 * Small fuzzy matcher for the command palette. Every whitespace-separated query token must
 * match the text, either as a substring (strong, better at a word start and early on) or
 * as an in-order subsequence (weaker, better when characters are consecutive or start
 * words). Returns null when any token fails, otherwise a score where higher is better.
 */

const WORD_BREAK = /[\s\-·/:#._,()]/;

export function normalizeSearchText(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const isWordStart = (text: string, index: number) => index === 0 || WORD_BREAK.test(text[index - 1]);

function tokenScore(token: string, text: string): number | null {
  const at = text.indexOf(token);
  if (at >= 0) return 100 + token.length * 4 + (isWordStart(text, at) ? 40 : 0) - Math.min(at, 30);

  let score = 0;
  let previous = -2;
  for (const character of token) {
    const index = text.indexOf(character, previous + 1);
    if (index < 0) return null;
    score += index === previous + 1 ? 6 : 1;
    if (isWordStart(text, index)) score += 4;
    previous = index;
  }
  return score;
}

export function fuzzyScore(query: string, text: string): number | null {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const haystack = normalizeSearchText(text);
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(token, haystack);
    if (score === null) return null;
    total += score;
  }
  return total;
}

/** Items matching `query` with their scores, best first; ties keep their original order. */
export function scoreByQuery<T>(items: readonly T[], query: string, text: (item: T) => string): { item: T; score: number }[] {
  return items
    .map((item, order) => ({ item, order, score: fuzzyScore(query, text(item)) }))
    .filter((entry): entry is { item: T; order: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ item, score }) => ({ item, score }));
}

/** Items matching `query`, best first. */
export function rankByQuery<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  return scoreByQuery(items, query, text).map((entry) => entry.item);
}
