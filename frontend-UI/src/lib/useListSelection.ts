"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Checkbox selection over a list that can be searched.
 *
 * The rule (docs/internal/DESIGN-SYSTEM.md, "Search"): ranges and "Select
 * all" act on the rows **shown**. A shift-click range is counted over the
 * filtered rows, so it can only reach what the user can see; "Select all"
 * with a query active selects the matches and says so. Selections made
 * before a search survive it — the set is keyed by id, never by index.
 */
export function useListSelection<T>(
  shown: readonly T[],
  getId: (item: T) => number,
  options?: { initial?: Iterable<number>; isQueryActive?: boolean },
) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(options?.initial ?? []));
  const lastIndexRef = useRef<number | null>(null);

  // The anchor is an index into `shown`. When the rows change — a search,
  // another user's list, a refetch — it points at a different track, and a
  // shift-click would select a range the user never saw. Forget it.
  useEffect(() => {
    lastIndexRef.current = null;
  }, [shown]);

  const toggle = useCallback(
    (item: T, index: number, event?: React.MouseEvent | React.KeyboardEvent) => {
      const shift = Boolean(event && "shiftKey" in event && event.shiftKey);
      if (shift && lastIndexRef.current !== null) {
        const start = Math.min(lastIndexRef.current, index);
        const end = Math.max(lastIndexRef.current, index);
        setSelected((prev) => {
          const next = new Set(prev);
          for (let i = start; i <= end; i++) {
            const candidate = shown[i];
            if (candidate !== undefined) next.add(getId(candidate));
          }
          return next;
        });
        return;
      }
      const id = getId(item);
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastIndexRef.current = index;
    },
    [shown, getId],
  );

  const allShownSelected = useMemo(
    () => shown.length > 0 && shown.every((item) => selected.has(getId(item))),
    [shown, selected, getId],
  );

  /** Select every shown row, or clear them when they are all selected already. */
  const toggleAllShown = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const everyShown = shown.length > 0 && shown.every((item) => prev.has(getId(item)));
      for (const item of shown) {
        if (everyShown) next.delete(getId(item));
        else next.add(getId(item));
      }
      return next;
    });
  }, [shown, getId]);

  const clear = useCallback(() => {
    setSelected(new Set());
    lastIndexRef.current = null;
  }, []);

  const query = options?.isQueryActive ?? false;
  const toggleAllLabel = allShownSelected
    ? query
      ? "Deselect shown"
      : "Deselect All"
    : query
      ? `Select all ${shown.length} shown`
      : "Select All";

  return {
    selected,
    setSelected,
    toggle,
    allShownSelected,
    toggleAllShown,
    toggleAllLabel,
    clear,
  };
}
