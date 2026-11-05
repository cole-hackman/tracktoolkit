"use client";

import { useState, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Users, UserMinus, Loader2, ExternalLink } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  BulkReviewDetails,
  EmptyState,
  InlineAlert,
  ListSearch,
  PageContainer,
  PageHeader,
  Panel,
  ProgressBar,
  ResultPanel,
  Select,
  SelectableRow,
  SelectionBanner,
  Skeleton,
} from "@/components/ui";
import { ProgressiveBlur } from "@/components/ui/ProgressiveBlur";
import { apiFetch } from "@/lib/api";
import { invalidateDashboardSummary, removeUsersFromFollowingsCache } from "@/lib/queries";
import { useProgressiveFollowings, useProgressiveFollowers, progressiveStatus, selectAllLabel } from "@/lib/progressive";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { matchesSearch, searchTerms } from "@/lib/list-search";

interface Following {
  id: number;
  username: string;
  avatar_url: string;
  permalink_url: string;
  followers_count: number;
  track_count: number;
  reposts_count?: number;
  last_modified?: string;
}

type SortOption = "alpha" | "followers" | "tracks" | "reposts" | "last_modified";

// The list renders as a responsive CSS grid (1 column, 2 columns at
// Tailwind's `md` breakpoint). Virtualizing a grid means virtualizing rows
// of N cards rather than individual cards, so we need to know the current
// column count in JS. useSyncExternalStore keeps this correct without a
// hydration-mismatch flash: the server snapshot assumes 1 column (matching
// the mobile-first CSS), and the client re-syncs to the real value.
const MD_BREAKPOINT_QUERY = "(min-width: 768px)";

function subscribeToMediaQuery(query: string, onChange: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function useGridColumnCount() {
  const isWide = useSyncExternalStore(
    (onChange) => subscribeToMediaQuery(MD_BREAKPOINT_QUERY, onChange),
    () => window.matchMedia(MD_BREAKPOINT_QUERY).matches,
    () => false,
  );
  return isWide ? 2 : 1;
}

export default function FollowingManagerPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("alpha");
  const [filterMode, setFilterMode] = useState<"all" | "not-following-back">("all");
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [showUnfollowConfirm, setShowUnfollowConfirm] = useState(false);
  // The outcome of the last bulk run, shown in the result slot under the
  // header. `id` is a fresh key per run so each outcome mounts a new panel.
  const [outcome, setOutcome] = useState<{
    id: number;
    status: "success" | "partial" | "error";
    title: string;
    text: string;
  } | null>(null);
  const runCounter = useRef(0);
  const showOutcome = (status: "success" | "partial" | "error", title: string, text: string) => {
    runCounter.current += 1;
    setOutcome({ id: runCounter.current, status, title, text });
  };

  const followingsState = useProgressiveFollowings<Following>();
  const followersState = useProgressiveFollowers<Following>();

  const followings = followingsState.items;
  const followers = useMemo(
    () => new Set<number>(followersState.items.map((u) => u.id)),
    [followersState.items],
  );
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const toggleUser = (id: number, index: number, currentFilteredFollowings: Following[], event?: React.MouseEvent | React.KeyboardEvent) => {
    const isShiftKey = event && 'shiftKey' in event && event.shiftKey;

    if (isShiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          next.add(currentFilteredFollowings[i].id);
        }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastSelectedIndex(index);
    }
  };

  const selectAll = () => {
    if (selected.size === filteredFollowings.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredFollowings.map((f) => f.id)));
    }
  };

  const handleBulkUnfollow = async () => {
    if (selected.size === 0) return;
    setShowUnfollowConfirm(true);
  };

  const executeBulkUnfollow = async () => {
    setShowUnfollowConfirm(false);
    setRemoving(true);
    setProgress({ current: 0, total: selected.size });
    setOutcome(null);
    
    // Chunk size for bulk operations (SoundCloud API limit usually 50-100)
    // We use smaller chunks to be safe and show progress
    const CHUNK_SIZE = 50;
    const allUserIds = Array.from(selected);
    const successfullyRemoved = new Set<number>();
    
    try {
      for (let i = 0; i < allUserIds.length; i += CHUNK_SIZE) {
        const chunk = allUserIds.slice(i, i + CHUNK_SIZE);
        
        try {
          const response = await apiFetch("/api/followings/bulk-unfollow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userIds: chunk }),
          });

          if (response.ok) {
            const data = await response.json();
            data.results
              .filter((r: { status: string; userId: number }) => r.status === "ok")
              .forEach((r: { userId: number }) => successfullyRemoved.add(r.userId));
          }
        } catch (err) {
          console.error(`Failed to unfollow chunk ${i}-${i + CHUNK_SIZE}`, err);
        }

        // Update progress
        setProgress({ 
          current: Math.min(i + CHUNK_SIZE, allUserIds.length), 
          total: allUserIds.length 
        });
      }
      
      // Update UI state
      if (successfullyRemoved.size > 0) {
        removeUsersFromFollowingsCache(queryClient, successfullyRemoved);
        await invalidateDashboardSummary(queryClient);
        
        // Remove successfully unfollowed IDs from selection
        setSelected(prev => {
          const next = new Set(prev);
          successfullyRemoved.forEach(id => next.delete(id));
          return next;
        });

        if (successfullyRemoved.size < allUserIds.length) {
          showOutcome(
            "partial",
            "Some users could not be unfollowed",
            `Unfollowed ${successfullyRemoved.size} of ${allUserIds.length} users. Some failed.`,
          );
        } else {
          showOutcome(
            "success",
            "Users unfollowed",
            `Unfollowed ${successfullyRemoved.size} user${successfullyRemoved.size === 1 ? "" : "s"}.`,
          );
        }
      } else {
        showOutcome("error", "Unfollow failed", "Bulk unfollow failed. Please try again.");
      }

    } catch (error) {
      console.error("Bulk unfollow error:", error);
      showOutcome("error", "Unfollow failed", "An error occurred during bulk unfollow.");
    } finally {
      setRemoving(false);
      setProgress(null);
    }
  };

  const formatNumber = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  const formatDate = (dateStr?: string | number | null) => {
    if (!dateStr) return "N/A";
    try {
      let d = new Date(dateStr);
      
      // Fallback for Safari not parsing SC API "YYYY/MM/DD HH:MM:SS +0000" correctly
      if (isNaN(d.getTime()) && typeof dateStr === "string" && dateStr.includes("/")) {
        d = new Date(dateStr.replace(/\//g, "-").replace(" ", "T"));
      }
      
      // Re-check validity
      if (isNaN(d.getTime())) return "N/A";
      
      // Prevent "Dec 31, 1969" issue by rejecting zero or epoch-close dates
      if (d.getFullYear() <= 1970) return "N/A";

      return d.toLocaleDateString(undefined, { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
      });
    } catch {
      return "N/A";
    }
  };

  const debouncedSearch = useDebouncedValue(search, 150);

  const filteredFollowings = useMemo(() => {
    // The shared rule (lib/list-search.ts): case- and accent-insensitive,
    // every word must appear in the username.
    const terms = searchTerms(debouncedSearch);

    const getParseableTime = (d?: string | null) => {
      if (!d) return 0;
      let parsed = new Date(d);
      if (isNaN(parsed.getTime()) && typeof d === 'string' && d.includes('/')) {
        parsed = new Date(d.replace(/\//g, '-').replace(' ', 'T'));
      }
      const time = parsed.getTime();
      return isNaN(time) ? 0 : time;
    };

    // Precompute the last-modified timestamp once instead of re-parsing it
    // (with the Safari fallback regex) twice per comparison inside .sort().
    const withSortKey = followings
      .filter((f) => {
        const matchesQuery = matchesSearch(f.username ?? "", terms);
        const matchesFilter = filterMode === "all" || !followers.has(f.id);
        return matchesQuery && matchesFilter;
      })
      .map((f) => ({ following: f, lastModifiedMs: getParseableTime(f.last_modified) }));

    withSortKey.sort((a, b) => {
      if (sort === "alpha") return (a.following.username || "").localeCompare(b.following.username || "");
      if (sort === "followers") return (b.following.followers_count || 0) - (a.following.followers_count || 0);
      if (sort === "tracks") return (b.following.track_count || 0) - (a.following.track_count || 0);
      if (sort === "reposts") return (b.following.reposts_count || 0) - (a.following.reposts_count || 0);
      if (sort === "last_modified") return b.lastModifiedMs - a.lastModifiedMs; // Newest first
      return 0;
    });

    return withSortKey.map((entry) => entry.following);
  }, [followings, followers, debouncedSearch, filterMode, sort]);

  // Virtualize the grid by row (each row holds `columns` cards). A card's
  // flat index — used for shift-click range selection — is `rowStart + col`,
  // i.e. still its position in `filteredFollowings`, not a virtual-row index.
  const columns = useGridColumnCount();
  const listScrollRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(filteredFollowings.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 92,
    overscan: 6,
  });

  // Only computed while the confirm dialog is open — no point building this
  // on every render while it's closed.
  const unfollowReviewItems = useMemo(() => {
    if (!showUnfollowConfirm) return [];
    return followings
      .filter((following) => selected.has(following.id))
      .map((following) => ({
        id: following.id,
        label: following.username,
        meta: `${following.followers_count?.toLocaleString?.() || 0} followers`,
      }));
  }, [followings, selected, showUnfollowConfirm]);

  // "Not Following Back" is a negative claim about every remaining following —
  // it's only honest once the followers set (used to check each one) is
  // fully loaded, so the toggle stays disabled until then.
  const followersReady = followersState.isComplete;
  const hasActiveFilter = Boolean(debouncedSearch) || filterMode !== "all";
  const followingsStatus = progressiveStatus(
    followingsState,
    "followings",
    hasActiveFilter ? { filteredCount: filteredFollowings.length } : {},
  );

  const loadError = followingsState.error ? (
    <InlineAlert variant="error" className="mb-4">
      {`Couldn't load who you follow: ${followingsState.error.message}`}
    </InlineAlert>
  ) : null;

  return (
    <PageContainer kind="list" className="pb-28">
      <PageHeader
        title="Following Manager"
        description="Browse and manage who you follow. Unfollow accounts in bulk."
      />

      <div className="space-y-6">
        {outcome ? (
          <ResultPanel
            key={outcome.id}
            status={outcome.status}
            title={outcome.title}
            description={outcome.text}
            announcement={outcome.text}
            onDismiss={() => setOutcome(null)}
          />
        ) : null}

        {removing && progress && (
          <ProgressBar
            className="rounded-lg border border-border bg-secondary/10 p-4"
            label="Unfollowing users"
            value={progress.current}
            max={progress.total}
          />
        )}

        {followingsState.isLoadingFirstPage ? (
          <Panel>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Skeleton className="h-10 min-w-[200px] flex-1 rounded-lg" />
              <Skeleton className="h-10 w-32 rounded-lg" />
              <div className="flex rounded-lg p-1">
                <Skeleton className="h-9 w-16" />
                <Skeleton className="h-9 w-32" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
            <Skeleton className="mb-2 h-4 w-32" />
            <div className="grid gap-3 md:grid-cols-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
              ))}
            </div>
          </Panel>
        ) : followings.length === 0 ? (
          <Panel>
            {loadError ?? (
              <EmptyState
                icon={<Users className="h-12 w-12" />}
                title="Not following anyone"
                description="You don't follow any users yet."
              />
            )}
          </Panel>
        ) : (
          <Panel
            title="Followings"
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={selectAll}
                className="whitespace-nowrap text-primary-text"
              >
                {selected.size === filteredFollowings.length
                  ? "Deselect All"
                  : selectAllLabel(followingsState, filteredFollowings.length)}
              </Button>
            }
          >
            {loadError}

            {/* Controls */}
            <div className="mb-3 space-y-3">
              <ListSearch
                label="Search followings"
                value={search}
                onChange={setSearch}
                shown={filteredFollowings.length}
                total={followings.length}
                noun={followings.length === 1 ? "following" : "followings"}
                placeholder="Search followings..."
                pendingNote={followingsState.isComplete ? undefined : "still loading, search covers loaded followings only"}
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-start">
                <Select
                  label="Sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortOption)}
                  className="bg-secondary/20"
                >
                  <option value="alpha">A → Z</option>
                  <option value="followers">Most Followers</option>
                  <option value="tracks">Most Tracks</option>
                  <option value="reposts">Most Reposts</option>
                  <option value="last_modified">Recently Active</option>
                </Select>

                <div>
                  <div
                    role="group"
                    aria-label="Filter"
                    className="flex rounded-lg border border-border/50 bg-secondary/20 p-1"
                  >
                    <button
                      type="button"
                      onClick={() => setFilterMode("all")}
                      aria-pressed={filterMode === "all"}
                      className={`min-h-11 flex-1 px-3 rounded-md text-sm font-medium transition-all ${
                        filterMode === "all" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => followersReady && setFilterMode("not-following-back")}
                      disabled={!followersReady}
                      aria-pressed={filterMode === "not-following-back"}
                      className={`min-h-11 flex-1 px-3 rounded-md text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                        filterMode === "not-following-back" ? "bg-card text-primary-text shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Not Following Back
                    </button>
                  </div>
                  {/* The reason the filter is unavailable is helper text, not a
                      `title`: a tooltip never reaches a keyboard or touch user,
                      and this is the only explanation of a disabled control. */}
                  {!followersReady && (
                    <p
                      role="status"
                      className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground-subtle"
                    >
                      <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                      Loading followers — who follows you back isn&apos;t known yet.
                    </p>
                  )}
                </div>
              </div>
            </div>

            {followingsStatus && (
              <p role="status" className="text-sm text-muted-foreground mb-2">
                {followingsStatus}
              </p>
            )}

            <ProgressiveBlur
              ref={listScrollRef}
              className="max-h-[60dvh] overflow-y-auto"
              active={filteredFollowings.length > 8}
              fadeHeight={72}
            >
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const rowStart = virtualRow.index * columns;
                  const rowUsers = filteredFollowings.slice(rowStart, rowStart + columns);
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="grid md:grid-cols-2 gap-3 pb-3"
                    >
                      {rowUsers.map((user, col) => {
                        const index = rowStart + col;
                        const isSelected = selected.has(user.id);
                        return (
                          <SelectableRow
                            key={user.id}
                            as="div"
                            // The row is a GRID ITEM, so its `min-width` is
                            // `auto` — which resolves to its min-content
                            // width, and a SoundCloud username has no spaces
                            // to break at. One 60-character name therefore
                            // made every row ~650px wide inside a 360px
                            // column, pushing the profile link off the right
                            // edge where no finger can reach it. The
                            // `truncate` on the name cannot help: the row
                            // refuses to be narrower than its min-content in
                            // the first place, so nothing ever overflows the
                            // element that would have clipped it.
                            //
                            // Neither acceptance check sees this. The list is
                            // `overflow-y-auto`, and a box with one axis
                            // hidden computes the other to `auto`, so the row
                            // scrolls horizontally *inside the list* and
                            // `document.scrollWidth` stays at 360; axe does
                            // not flag an off-screen control either. Hence the
                            // long-username case in e2e/long-titles.spec.ts.
                            id={user.id}
                            selected={isSelected}
                            label={user.username}
                            onToggle={(e) => toggleUser(user.id, index, filteredFollowings, e)}
                            rightSlot={
                              <a
                                href={user.permalink_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Open ${user.username} on SoundCloud`}
                                className="touch-44 inline-flex h-11 w-11 items-center justify-center rounded-md text-primary transition-colors hover:bg-accent hover:text-primary-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                              >
                                <ExternalLink aria-hidden="true" className="w-4 h-4" />
                              </a>
                            }
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <img
                                src={user.avatar_url || "/brand/icon-192.png"}
                                alt=""
                                width={48}
                                height={48}
                                loading="lazy"
                                decoding="async"
                                className="w-12 h-12 shrink-0 rounded-full object-cover"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="font-semibold text-foreground text-sm truncate">
                                    {user.username}
                                  </span>
                                  {user.last_modified && (
                                    <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-secondary/80 text-muted-foreground">
                                      Active: {formatDate(user.last_modified)}
                                    </span>
                                  )}
                                </span>
                                {/* Separators are decorative — a screen reader
                                    reads the three counts, not "middle dot". */}
                                <span className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5">
                                  <span>{formatNumber(user.followers_count || 0)} followers</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{formatNumber(user.track_count || 0)} tracks</span>
                                  {user.reposts_count !== undefined && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span>{formatNumber(user.reposts_count)} reposts</span>
                                    </>
                                  )}
                                </span>
                              </span>
                            </span>
                          </SelectableRow>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </ProgressiveBlur>

            {followingsState.isLoadingMore && (
              <div className="flex items-center justify-center gap-2 pt-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading more…
              </div>
            )}
          </Panel>
        )}
      </div>
      <SelectionBanner
        count={selected.size}
        entityName="user"
        actionLabel={progress ? `Unfollowing ${progress.current}/${progress.total}...` : "Unfollow Selected"}
        actionVariant="destructive"
        onAction={handleBulkUnfollow}
        disabled={removing}
        actionIcon={removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserMinus className="h-4 w-4" />}
      />
      <ConfirmDialog
        open={showUnfollowConfirm}
        title="Unfollow selected users?"
        description={`Unfollow ${selected.size} user${selected.size === 1 ? "" : "s"}? This cannot be undone.`}
        confirmLabel="Unfollow"
        variant="destructive"
        onConfirm={executeBulkUnfollow}
        onCancel={() => setShowUnfollowConfirm(false)}
      >
        <BulkReviewDetails
          action="unfollowing"
          warning="This removes accounts from your following list. Export the selection if you need a record."
          exportFilename="users-to-unfollow.csv"
          items={unfollowReviewItems}
        />
      </ConfirmDialog>
    </PageContainer>
  );
}
