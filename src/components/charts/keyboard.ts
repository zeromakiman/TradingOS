/**
 * Roving-focus target of a key press among `count` chart marks laid out in rows of `columns`
 * (1 for a row of bars or points, 7 for a calendar month): the arrow keys move by one mark or one
 * row, Home and End jump to the first and last mark, and moves stop at both ends. Null for any
 * other key (or no marks), so the key press is left to the browser.
 */
export function nextMarkIndex(key: string, position: number, count: number, columns = 1): number | null {
  if (count <= 0) return null;
  const target = keyTarget(key, position, count, Math.max(1, columns));
  return target === null ? null : Math.max(0, Math.min(count - 1, target));
}

function keyTarget(key: string, position: number, count: number, columns: number): number | null {
  switch (key) {
    case "ArrowRight":
      return position + 1;
    case "ArrowLeft":
      return position - 1;
    case "ArrowDown":
      return position + columns;
    case "ArrowUp":
      return position - columns;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
