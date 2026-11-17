/**
 * Moving several selected rows of a list at once (Playlist Modifier).
 *
 * Asked for in user feedback 2026-11-03: tracks added to a playlist land at
 * the bottom, and moving them up one at a time is slow. The selected rows
 * keep their order relative to each other in every move.
 */

export type MoveDirection = "top" | "up" | "down" | "bottom";

/**
 * Returns a new array with every item whose id is in `selected` moved.
 * `up` / `down` move each selected block one step, like pressing the
 * single-row arrow on each of them; a selected row already against the edge
 * (or against another selected row that cannot move) stays put. The input is
 * never mutated, and the result is the same array when nothing moves.
 */
export function moveSelected<T>(
  items: readonly T[],
  selected: ReadonlySet<number>,
  getId: (item: T) => number,
  direction: MoveDirection,
): T[] {
  if (selected.size === 0 || items.length === 0) return items as T[];
  const isSelected = (item: T) => selected.has(getId(item));

  if (direction === "top" || direction === "bottom") {
    const picked = items.filter(isSelected);
    if (picked.length === 0) return items as T[];
    const rest = items.filter((item) => !isSelected(item));
    const next = direction === "top" ? [...picked, ...rest] : [...rest, ...picked];
    return sameOrder(items, next) ? (items as T[]) : next;
  }

  const next = [...items];
  if (direction === "up") {
    for (let i = 1; i < next.length; i += 1) {
      if (isSelected(next[i]) && !isSelected(next[i - 1])) {
        [next[i - 1], next[i]] = [next[i], next[i - 1]];
      }
    }
  } else {
    for (let i = next.length - 2; i >= 0; i -= 1) {
      if (isSelected(next[i]) && !isSelected(next[i + 1])) {
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    }
  }
  return sameOrder(items, next) ? (items as T[]) : next;
}

function sameOrder<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
