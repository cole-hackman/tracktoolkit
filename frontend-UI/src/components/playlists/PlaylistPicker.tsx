"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Music } from "lucide-react";
import {
  Button,
  EmptyState,
  ListSearch,
  SelectableList,
  SelectableRow,
  Skeleton,
} from "@/components/ui";
import { useListSearch } from "@/lib/list-search";
import { cn } from "@/lib/utils";

export interface PickerPlaylist {
  id: number;
  title: string;
  track_count?: number;
  artwork_url?: string | null;
  coverUrl?: string | null;
}

/** Why a playlist cannot be picked right now ("merge target", "source"). */
export type PlaylistDisabledReasons = ReadonlyMap<number, string>;

export interface PlaylistPickerProps<P extends PickerPlaylist> {
  /** The whole list — search runs over all of it, not over what is rendered. */
  playlists: readonly P[];
  /** `multi`: checkboxes, any number. `single`: radio rows, exactly one. */
  mode: "single" | "multi";
  selectedIds: ReadonlySet<number> | readonly number[];
  /**
   * The new selection, in list order for `multi`. `viaPointer` is true when a
   * mouse or touch made the change (a dialog closes on that, but not on an
   * arrow key moving through the radio group).
   */
  onChange: (next: P[], info: { viaPointer: boolean; changed: P }) => void;
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  disabledReasons?: PlaylistDisabledReasons;
  /** Accessible name of the search box. */
  searchLabel?: string;
  /** Under the title, per row: an extra fact ("12 blocked"). */
  renderMeta?: (playlist: P) => React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** "Select all shown" / "Clear" above a `multi` list. */
  showBulkSelect?: boolean;
  /** Cap on the scrolling list. Default `max-h-[60dvh]`. */
  listClassName?: string;
  className?: string;
}

function playlistText(playlist: PickerPlaylist): string {
  return playlist.title ?? "";
}

function asIdSet(ids: ReadonlySet<number> | readonly number[]): Set<number> {
  return ids instanceof Set ? (ids as Set<number>) : new Set((ids as readonly number[]).map(Number));
}

/**
 * The one playlist picker. Every tool that chooses playlists — sources to
 * merge, a playlist to scan, the target to add tracks to — renders this list,
 * inline or inside `PlaylistChooser`'s dialog, so it looks and behaves the
 * same everywhere:
 *
 * search box with an "N of M" count → optional bulk-select row → a scrolling
 * `SelectableList` of 48px artwork, title and track count, a real checkbox
 * (`multi`) or radio (`single`) on each row.
 *
 * Shift-click selects a range in `multi`, counted over the rows currently
 * shown — so a search narrows what a range can reach, which is what the user
 * sees. "Select all shown" likewise selects the matches, not hidden rows.
 */
export function PlaylistPicker<P extends PickerPlaylist>({
  playlists,
  mode,
  selectedIds,
  onChange,
  loading = false,
  loadError = false,
  onRetry,
  disabledReasons,
  searchLabel = "Search playlists",
  renderMeta,
  emptyTitle = "No playlists found",
  emptyDescription = "Create some playlists on SoundCloud first.",
  showBulkSelect = false,
  listClassName,
  className,
}: PlaylistPickerProps<P>) {
  const [query, setQuery] = useState("");
  const radioName = useId();
  const lastIndexRef = useRef<number | null>(null);
  const selected = useMemo(() => asIdSet(selectedIds), [selectedIds]);
  const getText = useCallback((playlist: P) => playlistText(playlist), []);
  const { results: shown } = useListSearch(playlists, query, getText);

  const inListOrder = useCallback(
    (ids: Set<number>) => playlists.filter((playlist) => ids.has(Number(playlist.id))),
    [playlists],
  );

  const toggle = (playlist: P, index: number, event?: React.MouseEvent | React.KeyboardEvent) => {
    const id = Number(playlist.id);
    const viaPointer = Boolean(event && "clientX" in event);

    if (mode === "single") {
      onChange([playlist], { viaPointer, changed: playlist });
      return;
    }

    const next = new Set(selected);
    const shift = Boolean(event && "shiftKey" in event && event.shiftKey);
    if (shift && lastIndexRef.current !== null) {
      const start = Math.min(lastIndexRef.current, index);
      const end = Math.max(lastIndexRef.current, index);
      for (let i = start; i <= end; i++) {
        const candidate = shown[i];
        if (candidate && !disabledReasons?.has(Number(candidate.id))) next.add(Number(candidate.id));
      }
    } else {
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastIndexRef.current = index;
    }
    onChange(inListOrder(next), { viaPointer, changed: playlist });
  };

  const selectableShown = shown.filter((playlist) => !disabledReasons?.has(Number(playlist.id)));
  const allShownSelected =
    selectableShown.length > 0 && selectableShown.every((playlist) => selected.has(Number(playlist.id)));

  const selectAllShown = () => {
    const next = new Set(selected);
    for (const playlist of selectableShown) next.add(Number(playlist.id));
    onChange(inListOrder(next), { viaPointer: false, changed: selectableShown[0] });
  };
  const clearShown = () => {
    const next = new Set(selected);
    for (const playlist of shown) next.delete(Number(playlist.id));
    onChange(inListOrder(next), { viaPointer: false, changed: shown[0] });
  };

  if (loading) {
    return (
      <div className={cn("space-y-2", className)} aria-busy="true">
        <span className="sr-only">Loading playlists…</span>
        <Skeleton className="h-11 rounded-md" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <EmptyState
        as="p"
        className={className}
        title="Couldn't load your playlists"
        description="The backend may be unreachable. Retry to refresh the list."
        action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}
      />
    );
  }

  if (playlists.length === 0) {
    return (
      <EmptyState
        as="p"
        className={className}
        icon={<Music className="h-6 w-6" />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <ListSearch
        label={searchLabel}
        value={query}
        onChange={setQuery}
        shown={shown.length}
        total={playlists.length}
        noun={playlists.length === 1 ? "playlist" : "playlists"}
      />

      {mode === "multi" && showBulkSelect && shown.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={allShownSelected ? clearShown : selectAllShown}
            nowrap
          >
            {allShownSelected
              ? query.trim()
                ? "Clear shown"
                : "Clear all"
              : query.trim()
                ? `Select all ${selectableShown.length} shown`
                : "Select all"}
          </Button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          as="p"
          className="min-h-[160px] py-8"
          title="No playlists match your search"
          description="Try fewer or different words."
        />
      ) : (
        <SelectableList className={cn("max-h-[60dvh] overflow-y-auto overscroll-contain pr-1", listClassName)}>
          {shown.map((playlist, index) => {
            const id = Number(playlist.id);
            const isSelected = selected.has(id);
            const reason = disabledReasons?.get(id);
            const meta = renderMeta?.(playlist);
            return (
              <SelectableRow
                key={id}
                id={id}
                type={mode === "single" ? "radio" : "checkbox"}
                name={mode === "single" ? radioName : undefined}
                selected={isSelected}
                disabled={Boolean(reason)}
                // The disabled reason is part of the name: a dimmed row alone
                // says nothing to a screen reader.
                label={reason ? `${playlist.title} (${reason})` : playlist.title}
                onToggle={(event) => toggle(playlist, index, event)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <img
                    src={playlist.coverUrl || playlist.artwork_url || "/brand/icon-192.png"}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    className="h-12 w-12 shrink-0 rounded-lg object-cover"
                  />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {playlist.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {typeof playlist.track_count === "number"
                        ? `${playlist.track_count} track${playlist.track_count === 1 ? "" : "s"}`
                        : null}
                      {reason ? <span className="ml-2 text-primary-text">({reason})</span> : null}
                      {meta ? <span className="ml-2">{meta}</span> : null}
                    </span>
                  </span>
                </span>
              </SelectableRow>
            );
          })}
        </SelectableList>
      )}
    </div>
  );
}
