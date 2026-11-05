"use client";

import { useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { Field } from "./Field";
import { Input } from "./Input";
import { useAnnounce } from "./useAnnounce";

export interface ListSearchProps {
  /** The label (visually hidden by default — the list below says what it searches). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** How many items match the current query. */
  shown: number;
  /** How many items the list holds in total. */
  total: number;
  /** Plural noun for the count line: "playlists", "tracks". */
  noun: string;
  placeholder?: string;
  /**
   * Appended to the count while the list is still arriving page by page, so
   * the user knows the search has not covered everything yet.
   */
  pendingNote?: string;
  /** Show the visible label above the box instead of hiding it. */
  labelVisible?: boolean;
  className?: string;
}

/**
 * The search box above every list a user picks from or scrolls through.
 *
 * One look and one behaviour everywhere: a `Field` with a real (normally
 * sr-only) label, the search icon, and a count line under the box —
 * "Showing 12 of 340 playlists" while a query is active, "340 playlists"
 * otherwise. The count is the box's `aria-describedby`, and a settled change
 * of it is spoken through the app's live region (debounced, so typing
 * "remix" is one announcement, not five).
 *
 * Filtering itself is `useListSearch` in `lib/list-search.ts`; this
 * component only renders the control and the count.
 */
export function ListSearch({
  label,
  value,
  onChange,
  shown,
  total,
  noun,
  placeholder,
  pendingNote,
  labelVisible = false,
  className,
}: ListSearchProps) {
  const announce = useAnnounce();
  const active = value.trim().length > 0;
  const countText = active
    ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
    : `${total.toLocaleString()} ${noun}`;
  const hint = pendingNote ? `${countText} (${pendingNote})` : countText;

  const settledQuery = useDebouncedValue(value.trim(), 400);
  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    // Nothing to say until the user has typed something; clearing the box
    // after a search is worth saying once.
    if (!settledQuery && lastAnnounced.current === null) return;
    const message = settledQuery
      ? `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun} match`
      : `Search cleared, ${total.toLocaleString()} ${noun}`;
    if (message === lastAnnounced.current) return;
    lastAnnounced.current = message;
    announce(message);
    // `shown`/`total` deliberately excluded: a list refetch should not speak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledQuery, announce]);

  return (
    <Field label={label} labelHidden={!labelVisible} hint={hint} className={cn("min-w-0", className)}>
      {(field) => (
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            {...field}
            type="search"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder ?? `Search ${noun}…`}
            autoComplete="off"
            className="h-11 pl-9"
          />
        </div>
      )}
    </Field>
  );
}
