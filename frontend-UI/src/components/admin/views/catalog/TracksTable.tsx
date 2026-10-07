"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { fmtAbsolute, fmtInt, fmtMs, timeAgo } from "../../format";
import {
  Empty,
  ErrorNotice,
  Panel,
  RowSkeleton,
  Select,
  SmallButton,
  SortTh,
  StatusPill,
  TableShell,
  tdClass,
  thClass,
  type Tone,
} from "../../primitives";
import { catalogCsvUrl, catalogTracksParams, useCatalogTracks, useTrackOperations } from "../../queries";
import { DEFAULT_CATALOG_FILTER, type CatalogFilter, type CatalogSort, type CatalogSummary, type Period } from "../../types";
import { ColumnToggles, ExportLink, Pager, SearchBox, useToggleSet } from "./shared";
import { TrackPlayer } from "./TrackPlayer";

// Actions that carry trackIds in their metadata, so "touched by" is meaningful.
const TRACK_ACTIONS = [
  "merge", "from-likes", "bulk-unlike", "bulk-like", "clone", "genre-search",
  "library-audit", "playlist-compare", "resolve", "batch-resolve",
  "bulk-remove-reposts", "proxy-download", "download-links", "admin-re-resolve",
];
const ACCESS_STATES = ["playable", "preview", "blocked", "gone", "unknown", "not_playable"];
const RESOLVE_STATES = ["resolved", "pending", "not_found", "gone"];

type OptionalCol = "duration" | "firstSeen" | "lastSeen";
const OPTIONAL_COLS: ReadonlyArray<{ key: OptionalCol; label: string }> = [
  { key: "duration", label: "Duration" },
  { key: "firstSeen", label: "First seen" },
  { key: "lastSeen", label: "Last seen" },
];

export function accessTone(access: string | null): Tone {
  if (!access) return "muted";
  return access === "playable" ? "ok" : "danger";
}

function TrackOpsRow({ trackId, title, permalinkUrl, colSpan }: { trackId: string; title: string; permalinkUrl: string | null; colSpan: number }) {
  const q = useTrackOperations(trackId);
  // Player state lives here so it resets when the row collapses (unmount).
  const [playerOpen, setPlayerOpen] = React.useState(false);
  return (
    <tr className="bg-primary/[0.04]">
      <td colSpan={colSpan} className="px-4 pb-3 pt-1 sm:px-5">
        <div className="mb-3 max-w-[640px]">
          <TrackPlayer permalinkUrl={permalinkUrl} title={title} open={playerOpen} onToggle={() => setPlayerOpen((o) => !o)} />
        </div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Operations touching this track · latest 50</div>
        {q.isPending ? (
          <RowSkeleton rows={2} height="h-5" />
        ) : q.isError ? (
          <ErrorNotice message="Could not load this track's operations." onRetry={() => q.refetch()} />
        ) : q.data.length === 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground">No logged operation references this track.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {q.data.map((op) => (
              <li key={op.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[12px]">
                <span className="font-mono font-medium text-primary-text">@{op.user.username}</span>
                <span className="text-foreground/90">{op.actionName}</span>
                <StatusPill status={op.status} />
                <span className="font-mono text-[11px] text-muted-foreground" title={fmtAbsolute(op.createdAt)}>{timeAgo(op.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

interface Props {
  period: Period;
  enabled: boolean;
  summary: CatalogSummary | undefined;
  filter: CatalogFilter;
  onFilterChange: (next: CatalogFilter) => void;
}

export function TracksTable({ period, enabled, summary, filter, onFilterChange }: Props) {
  const [artistInput, setArtistInput] = React.useState(filter.artist);
  const debouncedArtist = useDebouncedValue(artistInput.trim(), 350);
  React.useEffect(() => {
    if (debouncedArtist !== filter.artist) onFilterChange({ ...filter, artist: debouncedArtist, page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedArtist]);
  // A filter set from elsewhere (an artist clicked in the roll-up) lands in the box too.
  React.useEffect(() => {
    setArtistInput((current) => (current.trim() === filter.artist ? current : filter.artist));
  }, [filter.artist]);

  const [cols, toggleCol] = useToggleSet<OptionalCol>();
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const tracksQ = useCatalogTracks(period, filter, enabled);
  const tracks = tracksQ.data?.tracks ?? [];
  const total = tracksQ.data?.total ?? 0;

  const set = (patch: Partial<CatalogFilter>) => onFilterChange({ ...filter, ...patch, page: 1 });
  const toggleSort = (key: CatalogSort) =>
    onFilterChange({
      ...filter,
      sort: key,
      order: filter.sort === key ? (filter.order === "desc" ? "asc" : "desc") : key === "title" || key === "artist" ? "asc" : "desc",
      page: 1,
    });

  const activeFilters = [filter.genre, filter.artist, filter.access, filter.resolveStatus, filter.action].filter(Boolean).length;
  const COLS = 8 + cols.size;
  const genreOptions = summary?.genreBreakdown ?? [];

  return (
    <Panel
      index={4}
      title="Tracks"
      hint="Aggregate by default — who touched a track only shows when you expand it."
      padded={false}
      action={
        <>
          <span className="font-mono text-[11px] text-muted-foreground">{tracksQ.isPending ? "Loading…" : `${fmtInt(total)} tracks`}</span>
          <ExportLink href={catalogCsvUrl("tracks", catalogTracksParams(period, filter))} />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 pb-3 sm:px-5">
        <label>
          <span className="sr-only">Genre</span>
          <Select value={filter.genre} onChange={(e) => set({ genre: e.target.value })}>
            <option value="">All genres</option>
            {genreOptions.map((g) => (
              <option key={g.genre} value={g.genre}>{g.genre}</option>
            ))}
            {filter.genre && !genreOptions.some((g) => g.genre === filter.genre) && <option value={filter.genre}>{filter.genre}</option>}
          </Select>
        </label>
        <label>
          <span className="sr-only">Access</span>
          <Select value={filter.access} onChange={(e) => set({ access: e.target.value })}>
            <option value="">All access</option>
            {ACCESS_STATES.map((a) => (
              <option key={a} value={a}>{a === "not_playable" ? "not playable (any)" : a}</option>
            ))}
          </Select>
        </label>
        <label>
          <span className="sr-only">Resolve state</span>
          <Select value={filter.resolveStatus} onChange={(e) => set({ resolveStatus: e.target.value })}>
            <option value="">All resolve states</option>
            {RESOLVE_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </label>
        <label>
          <span className="sr-only">Touched by action</span>
          <Select value={filter.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Touched by any action</option>
            {TRACK_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
        </label>
        <SearchBox value={artistInput} onChange={setArtistInput} placeholder="Artist contains…" label="Artist" />
        {activeFilters > 0 && (
          <SmallButton
            className="h-7"
            onClick={() => {
              setArtistInput("");
              onFilterChange({ ...DEFAULT_CATALOG_FILTER, sort: filter.sort, order: filter.order });
            }}
          >
            <X className="h-3 w-3" aria-hidden="true" /> Clear {activeFilters}
          </SmallButton>
        )}
        <div className="ml-auto">
          <ColumnToggles columns={OPTIONAL_COLS} visible={cols} onToggle={toggleCol} />
        </div>
      </div>

      <div className="px-4 pt-3 sm:px-5">
        {tracksQ.isError ? (
          <ErrorNotice message="Could not load catalog tracks." onRetry={() => tracksQ.refetch()} />
        ) : tracksQ.isPending ? (
          <RowSkeleton rows={8} />
        ) : tracks.length === 0 ? (
          <Empty className="mb-4">No catalog tracks match these filters. The catalog fills as operations run.</Empty>
        ) : (
          <TableShell minWidth={860 + cols.size * 110} className={cn(tracksQ.isPlaceholderData && "opacity-60 transition-opacity")}>
            <thead>
              <tr>
                <th scope="col" className={cn(thClass, "w-8")}>
                  <span className="sr-only">Expand</span>
                </th>
                <SortTh label="Track" active={filter.sort === "title"} order={filter.order} onClick={() => toggleSort("title")} />
                <SortTh label="Artist" active={filter.sort === "artist"} order={filter.order} onClick={() => toggleSort("artist")} />
                <th scope="col" className={thClass}>Genre</th>
                <th scope="col" className={thClass}>Access</th>
                {cols.has("duration") && <SortTh label="Duration" active={filter.sort === "duration"} order={filter.order} onClick={() => toggleSort("duration")} align="right" />}
                <SortTh label="Touches" active={filter.sort === "touches"} order={filter.order} onClick={() => toggleSort("touches")} align="right" />
                <SortTh label="Users" active={filter.sort === "users"} order={filter.order} onClick={() => toggleSort("users")} align="right" />
                <SortTh label="Last touched" active={filter.sort === "lastTouched"} order={filter.order} onClick={() => toggleSort("lastTouched")} />
                {cols.has("firstSeen") && <SortTh label="First seen" active={filter.sort === "firstSeen"} order={filter.order} onClick={() => toggleSort("firstSeen")} />}
                {cols.has("lastSeen") && <SortTh label="Last seen" active={filter.sort === "lastSeen"} order={filter.order} onClick={() => toggleSort("lastSeen")} />}
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => {
                const id = String(t.id);
                const open = expanded === id;
                return (
                  <React.Fragment key={id}>
                    <tr
                      onClick={() => setExpanded(open ? null : id)}
                      className={cn("cursor-pointer transition-colors hover:bg-primary/[0.06]", open && "bg-primary/[0.06]")}
                    >
                      <td className={cn(tdClass, "pr-0")}>
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={open ? "Collapse" : "Show operations for this track"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(open ? null : id);
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                        >
                          {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                        </button>
                      </td>
                      <td className={cn(tdClass, "max-w-[280px]")}>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={cn("truncate", t.title ? "text-foreground" : "font-mono text-warning-text")}>{t.title || `#${id} (unresolved)`}</span>
                          {t.permalinkUrl && (
                            <a
                              href={t.permalinkUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Open on SoundCloud"
                              className="shrink-0 text-muted-foreground hover:text-primary-text"
                            >
                              <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            </a>
                          )}
                        </div>
                        {t.resolveStatus !== "resolved" && <span className="font-mono text-[10px] text-warning-text">{t.resolveStatus}</span>}
                      </td>
                      <td className={cn(tdClass, "max-w-[180px] truncate text-foreground/80")}>{t.artistName || "—"}</td>
                      <td className={cn(tdClass, "font-mono text-[11px]", t.genreNormalized ? "text-muted-foreground" : "text-warning-text")}>{t.genreNormalized || "(none)"}</td>
                      <td className={cn(tdClass, "font-mono text-[11px]")}>
                        <span className={cn("inline-flex items-center gap-1.5", accessTone(t.access) === "ok" ? "text-success-text" : accessTone(t.access) === "danger" ? "text-destructive-text" : "text-muted-foreground")}>
                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                          {t.access || "unknown"}
                        </span>
                      </td>
                      {cols.has("duration") && <td className={cn(tdClass, "text-right font-mono tabular-nums text-muted-foreground")}>{fmtMs(t.durationMs)}</td>}
                      <td className={cn(tdClass, "text-right font-mono font-semibold tabular-nums text-primary-text")}>{fmtInt(t.touches)}</td>
                      <td className={cn(tdClass, "text-right font-mono tabular-nums text-foreground/80")}>{fmtInt(t.users)}</td>
                      <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")} title={fmtAbsolute(t.last_touched)}>
                        {t.last_touched ? timeAgo(t.last_touched) : "—"}
                      </td>
                      {cols.has("firstSeen") && (
                        <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")} title={fmtAbsolute(t.firstSeenAt)}>
                          {t.firstSeenAt ? timeAgo(t.firstSeenAt) : "—"}
                        </td>
                      )}
                      {cols.has("lastSeen") && (
                        <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")} title={fmtAbsolute(t.lastSeenAt)}>
                          {t.lastSeenAt ? timeAgo(t.lastSeenAt) : "—"}
                        </td>
                      )}
                    </tr>
                    {open && <TrackOpsRow trackId={id} title={t.title || `#${id}`} permalinkUrl={t.permalinkUrl} colSpan={COLS} />}
                  </React.Fragment>
                );
              })}
            </tbody>
          </TableShell>
        )}
        <Pager page={filter.page} total={total} onPage={(page) => onFilterChange({ ...filter, page })} />
      </div>
    </Panel>
  );
}
