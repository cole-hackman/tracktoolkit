"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Heart, Loader2, ListMusic, Music, Plus, Users } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  Button,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  ListSearch,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  SegmentedControl,
  SelectableList,
  SelectionBanner,
  Skeleton,
  TrackRow,
  useAnnounce,
  type ResultStatus,
} from "@/components/ui";
import { PlaylistChooser } from "@/components/playlists/PlaylistChooser";
import { PlaylistPicker } from "@/components/playlists/PlaylistPicker";
import { cn } from "@/lib/utils";
import { invalidatePlaylistCaches, useFollowingsQuery, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { useListSearch } from "@/lib/list-search";
import { useListSelection } from "@/lib/useListSelection";

interface Following {
  id: number;
  username: string;
  avatar_url?: string | null;
  permalink_url?: string | null;
  followers_count?: number;
}

interface Track {
  id: number;
  title: string;
  user?: { username?: string | null };
  artwork_url?: string | null;
  duration?: number | null;
  permalink_url?: string | null;
}

interface Playlist {
  id: number;
  title: string;
  user?: { username?: string | null };
  artwork_url?: string | null;
  permalink_url?: string | null;
  track_count?: number | null;
}

interface CreatedPlaylist {
  id?: number | string;
  title?: string;
  permalink_url?: string;
  trackCount?: number;
}

/** A copy the server created but could not finish filling. */
interface PartialPlaylist {
  id?: number | string;
  title?: string;
  permalink_url?: string;
  tracksWritten?: number;
  intendedTrackCount?: number;
  sourcePlaylistId?: number;
}

interface CloneResult {
  playlist?: CreatedPlaylist;
  playlists?: CreatedPlaylist[];
  overflowPlaylists?: CreatedPlaylist[];
  partialPlaylists?: PartialPlaylist[];
  totalTracks?: number;
  addedCount?: number;
  stats?: Record<string, unknown>;
  errors?: { id: number; error: string }[];
  /** A sentence for the panel itself, so the outcome is not announced twice. */
  summary?: string;
}

type LibraryTab = "likes" | "playlists" | "liked-playlists";
type AddMode = "new" | "existing";

const TAB_LABELS: Record<LibraryTab, string> = {
  likes: "Liked Tracks",
  playlists: "Playlists",
  "liked-playlists": "Liked Playlists",
};

const TAB_ORDER = Object.keys(TAB_LABELS) as LibraryTab[];

const ADD_MODES = [
  { value: "new", label: "New playlist" },
  { value: "existing", label: "Add to existing" },
] as const;

/** `id` of a tab button and of the panel it controls — the pair ARIA needs. */
const tabId = (tab: LibraryTab) => `following-library-tab-${tab}`;
const panelId = (tab: LibraryTab) => `following-library-panel-${tab}`;

const trackText = (track: Track) => `${track.title ?? ""} ${track.user?.username ?? ""}`;
const trackKey = (track: Track) => track.id;
const followingText = (user: Following) => user.username ?? "";

/** A playlist row says "0 tracks" when the count is missing, as it always has. */
const withTrackCount = (playlist: Playlist) => ({
  ...playlist,
  track_count: Number(playlist.track_count) || 0,
});

/** The result slot's content, fixed when the run ends. */
interface Outcome {
  id: number;
  status: ResultStatus;
  title: string;
  /** The page's old notice or the server's summary sentence. */
  description?: string;
  /** What the run did, in numbers ("Cloned 2 playlists."). */
  countLine?: string;
  created: CreatedPlaylist[];
  partials: PartialPlaylist[];
  /** Per-playlist failures, named when the run ended. */
  errors: { id: number; name: string; error: string }[];
}

/** A failed request that left nothing to list. */
interface RunError {
  id: number;
  title: string;
  text: string;
}

function buildOutcome(
  result: CloneResult,
  description: string | undefined,
  sourceName: (id: number) => string,
): Outcome {
  const created = result.playlists || (result.playlist ? [result.playlist] : []);
  const partials = result.partialPlaylists || [];
  const errors = (result.errors || []).map((entry) => ({
    id: entry.id,
    name: sourceName(entry.id),
    error: entry.error,
  }));
  const hasProblems = errors.length > 0 || partials.length > 0;
  // Only the clone endpoint answers with stats.numPlaylistsCreated, or (when
  // nothing was fully created) with partialPlaylists and no track totals.
  const isClone =
    typeof result.stats?.numPlaylistsCreated === "number" ||
    result.summary !== undefined ||
    (partials.length > 0 && result.addedCount == null && result.totalTracks == null);

  let countLine: string | undefined;
  if (isClone) {
    if (created.length > 0) countLine = `Cloned ${created.length} playlist${created.length === 1 ? "" : "s"}.`;
  } else if (typeof result.addedCount === "number") {
    countLine = `Added ${result.addedCount} track${result.addedCount === 1 ? "" : "s"} to your playlist.`;
  } else {
    countLine = `Saved ${result.totalTracks || 0} track${(result.totalTracks || 0) === 1 ? "" : "s"} across ${created.length || 1} playlist${(created.length || 1) === 1 ? "" : "s"}.`;
  }

  // Something real was written, even if not all of it: partial. Nothing
  // written and a reason per playlist: error. Nothing to add: empty.
  let status: ResultStatus = "success";
  if (hasProblems) status = created.length > 0 || partials.length > 0 ? "partial" : "error";
  // The append path always returns the target playlist, so "nothing added"
  // is addedCount 0 alone.
  else if (!isClone && result.addedCount === 0) status = "empty";

  return {
    id: Date.now(),
    status,
    title: hasProblems ? "Finished with problems" : "Done",
    description: result.summary ?? description,
    countLine,
    created,
    partials,
    errors,
  };
}

const formatDuration = (ms?: number | null) => {
  if (!ms) return "";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function FollowingLibraryPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [selectedUser, setSelectedUser] = useState<Following | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [trackSearch, setTrackSearch] = useState("");
  const [activeTab, setActiveTab] = useState<LibraryTab>("likes");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [nextHref, setNextHref] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedPlaylists, setSelectedPlaylists] = useState<Set<number>>(new Set());
  const [playlistName, setPlaylistName] = useState("");
  const [addMode, setAddMode] = useState<AddMode>("new");
  const [targetPlaylist, setTargetPlaylist] = useState<ReturnType<typeof withTrackCount> | null>(null);
  const [titlePrefix, setTitlePrefix] = useState("");
  const [working, setWorking] = useState(false);
  /** A library that would not load: stays beside the list it belongs to. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);

  const followingsQuery = useFollowingsQuery();
  const ownPlaylistsQuery = usePlaylistsQuery({ enabled: addMode === "existing" });
  const followings = useMemo(
    () =>
      [...asArray<Following>(followingsQuery.data?.collection)].sort((a, b) =>
        (a.username || "").localeCompare(b.username || ""),
      ),
    [followingsQuery.data?.collection],
  );
  const ownPlaylists = useMemo(
    () => asArray<Playlist>(ownPlaylistsQuery.data?.collection).map(withTrackCount),
    [ownPlaylistsQuery.data?.collection],
  );
  const loadingUsers = followingsQuery.isLoading;

  // Search runs over every following / every loaded item, not rendered rows.
  const { results: shownFollowings } = useListSearch(followings, userSearch, followingText);
  const { results: shownTracks, isFiltered: tracksFiltered } = useListSearch(tracks, trackSearch, trackText);
  const {
    selected: selectedTracks,
    setSelected: setSelectedTracks,
    toggle: toggleTrack,
    toggleAllShown: toggleAllTracks,
    toggleAllLabel: trackToggleLabel,
    allShownSelected: allTracksSelected,
  } = useListSelection(shownTracks, trackKey, { isQueryActive: tracksFiltered });

  useEffect(() => {
    if (selectedUser) {
      fetchLibraryPage(activeTab, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUser, activeTab]);

  useEffect(() => {
    if (!selectedUser && followings.length > 0) {
      setSelectedUser(followings[0]);
    }
  }, [followings, selectedUser]);

  const pickerPlaylists = useMemo(() => playlists.map(withTrackCount), [playlists]);

  const fetchLibraryPage = async (tab: LibraryTab, reset: boolean) => {
    if (!selectedUser) return;
    if (reset) {
      setLoadingContent(true);
      setTracks([]);
      setPlaylists([]);
      setNextHref(null);
      setSelectedTracks(new Set());
      setSelectedPlaylists(new Set());
      setTrackSearch("");
      setOutcome(null);
      setRunError(null);
    } else {
      setLoadingMore(true);
    }
    setLoadError(null);

    try {
      const route =
        tab === "likes"
          ? "likes"
          : tab === "playlists"
            ? "playlists"
            : "liked-playlists";
      const cursor = !reset && nextHref ? `&next=${encodeURIComponent(nextHref)}` : "";
      const response = await apiFetch(`/api/followings/${selectedUser.id}/${route}/paged?limit=50${cursor}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to load public library");
      }

      const incoming = (data.collection || []) as unknown[];
      // Announced from here rather than from an effect on the array length.
      // The fetch starts in the same commit as the tab or user change, so on
      // that render `loadingContent` is still false and the array is still the
      // previous tab's — an effect would speak "0 playlists loaded" (or the
      // last user's count) before the real one. Here the number is the number
      // that just arrived.
      const total =
        (reset ? 0 : tab === "likes" ? tracks.length : playlists.length) + incoming.length;

      if (tab === "likes") {
        setTracks((prev) => (reset ? (incoming as Track[]) : [...prev, ...(incoming as Track[])]));
      } else {
        setPlaylists((prev) =>
          reset ? (incoming as Playlist[]) : [...prev, ...(incoming as Playlist[])],
        );
      }
      setNextHref(data.next_href || null);
      announce(
        `${total} ${tab === "likes" ? "track" : "playlist"}${total === 1 ? "" : "s"} loaded.`,
      );
    } catch (error) {
      console.error("Failed to fetch followed library:", error);
      setLoadError(error instanceof Error ? error.message : "Couldn't load this user's public library.");
    } finally {
      setLoadingContent(false);
      setLoadingMore(false);
    }
  };

  const selectUser = (user: Following) => {
    setSelectedUser(user);
    setActiveTab("likes");
    setPlaylistName(`${user.username} Likes`);
    setTitlePrefix(user.username);
  };

  const canCreateFromTracks =
    selectedUser &&
    (addMode === "existing" ? targetPlaylist !== null : playlistName.trim().length > 0);

  const createFromLikes = async (mode: "selected" | "all") => {
    if (!selectedUser || !canCreateFromTracks) return;
    if (mode === "selected" && selectedTracks.size === 0) return;

    const failureTitle = addMode === "existing" ? "Couldn't add the tracks" : "Couldn't create the playlist";
    setWorking(true);
    setOutcome(null);
    setRunError(null);
    try {
      const body: Record<string, unknown> = { mode };
      if (mode === "selected") body.trackIds = Array.from(selectedTracks);
      if (addMode === "existing" && targetPlaylist) {
        body.targetPlaylistId = targetPlaylist.id;
      } else {
        body.title = playlistName.trim();
      }

      const response = await apiFetch(`/api/followings/${selectedUser.id}/likes/playlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to create playlist");
      }
      await invalidatePlaylistCaches(queryClient, targetPlaylist?.id ?? null);
      setOutcome(
        buildOutcome(
          data,
          addMode === "existing" ? "Tracks added to your playlist." : "Playlist created in your library.",
          (id) => `Playlist ${id}`,
        ),
      );
    } catch (error) {
      console.error("Failed to create from followed likes:", error);
      setRunError({
        id: Date.now(),
        title: failureTitle,
        text: error instanceof Error ? error.message : "Couldn't create the playlist.",
      });
    } finally {
      setWorking(false);
    }
  };

  const sourceName = (id: number) =>
    playlists.find((p) => Number(p.id) === Number(id))?.title || `Playlist ${id}`;

  const cloneSelectedPlaylists = async () => {
    if (!selectedUser || selectedPlaylists.size === 0) return;
    setWorking(true);
    setOutcome(null);
    setRunError(null);
    try {
      const response = await apiFetch(`/api/followings/${selectedUser.id}/playlists/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playlistIds: Array.from(selectedPlaylists),
          ...(titlePrefix.trim() ? { titlePrefix: titlePrefix.trim() } : {}),
        }),
      });
      // One read: a non-JSON body (a proxy's HTML error page) becomes null.
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = errorMessageFromBody(data, "Failed to clone playlists");
        const partials = Array.isArray(data?.partialPlaylists) ? data.partialPlaylists : [];
        const itemErrors = Array.isArray(data?.errors) ? data.errors : [];
        if (partials.length > 0 || itemErrors.length > 0) {
          // The panel carries the outcome (it takes focus), so the server's
          // sentence goes inside it rather than in a second alert.
          setOutcome(
            buildOutcome({ partialPlaylists: partials, errors: itemErrors, summary: message }, undefined, sourceName),
          );
        } else {
          setRunError({ id: Date.now(), title: "Couldn't clone the playlists", text: message });
        }
        // A create may have landed even though the request failed: any 5xx, a
        // SoundCloud error code, or a partialPlaylists list says so. The
        // cached lists are then stale. Show the outcome first, then refresh.
        if (response.status >= 500 || Array.isArray(data?.partialPlaylists) || typeof data?.code === "string") {
          void invalidatePlaylistCaches(queryClient);
        }
        return;
      }
      const hasProblems =
        (Array.isArray(data?.errors) && data.errors.length > 0) ||
        (Array.isArray(data?.partialPlaylists) && data.partialPlaylists.length > 0);
      setOutcome(
        buildOutcome(
          hasProblems ? { ...data, summary: "Some playlists were cloned, but not all of them finished." } : data,
          "Selected playlists were cloned into your library.",
          sourceName,
        ),
      );
      void invalidatePlaylistCaches(queryClient);
    } catch (error) {
      console.error("Failed to clone followed playlists:", error);
      setRunError({
        id: Date.now(),
        title: "Couldn't clone the playlists",
        text: error instanceof Error ? error.message : "Couldn't clone the selected playlists.",
      });
    } finally {
      setWorking(false);
    }
  };

  // A tab strip is one stop in the tab order, not three: Tab reaches the
  // selected tab, and Left/Right/Home/End move between them. Without this the
  // element says `role="tablist"` while behaving like a row of buttons.
  const tabRefs = useRef<Partial<Record<LibraryTab, HTMLButtonElement | null>>>({});
  const focusTab = useCallback((tab: LibraryTab) => {
    setActiveTab(tab);
    tabRefs.current[tab]?.focus();
  }, []);
  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tab: LibraryTab) => {
      const index = TAB_ORDER.indexOf(tab);
      if (event.key === "ArrowRight") focusTab(TAB_ORDER[(index + 1) % TAB_ORDER.length]);
      else if (event.key === "ArrowLeft")
        focusTab(TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]);
      else if (event.key === "Home") focusTab(TAB_ORDER[0]);
      else if (event.key === "End") focusTab(TAB_ORDER[TAB_ORDER.length - 1]);
      else return;
      event.preventDefault();
    },
    [focusTab],
  );

  const activeSelectionCount = activeTab === "likes" ? selectedTracks.size : selectedPlaylists.size;
  const activeSelectionAction = activeTab === "likes" ? () => createFromLikes("selected") : cloneSelectedPlaylists;
  const actionLabel = activeTab === "likes" ? "Create from Selected" : "Clone Selected";
  const actionDisabled = working || (activeTab === "likes" ? !canCreateFromTracks : selectedPlaylists.size === 0);

  // The list arrives 50 at a time; until it is all here, search and "select
  // all" only reach what has loaded, and the count says so.
  const pendingNote = nextHref ? "more still to load" : undefined;

  const loadMore = nextHref ? (
    <div className="flex justify-center">
      <Button nowrap variant="secondary" onClick={() => fetchLibraryPage(activeTab, false)} disabled={loadingMore}>
        {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
        Load more
      </Button>
    </div>
  ) : null;

  const loadAlert = loadError ? (
    <InlineAlert variant="error" onDismiss={() => setLoadError(null)}>
      {loadError}
    </InlineAlert>
  ) : null;

  return (
    <PageContainer kind="workbench" className="pb-28">
      <PageHeader
        title="Following Library"
        description="Copy public tracks and playlists from people you follow into your library."
      />

      <div className="space-y-6">
        {runError ? (
          <ResultPanel
            key={runError.id}
            status="error"
            title={runError.title}
            description={runError.text}
            announcement={runError.text}
            onDismiss={() => setRunError(null)}
          />
        ) : null}

        {outcome ? (
          <ResultPanel
            key={outcome.id}
            status={outcome.status}
            title={outcome.title}
            description={outcome.description}
            onDismiss={() => setOutcome(null)}
          >
            <OutcomeBody outcome={outcome} />
          </ResultPanel>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* `min-w-0`: a grid item's automatic minimum size is its min-content
              width, so one unbreakable username (a SoundCloud permalink slug can
              easily be 60 characters) sizes the whole single-column track to it.
              Nothing scrolls sideways — the results card is `overflow-hidden` —
              so the tabs and buttons in the other column are simply clipped off
              the right edge, which neither the overflow test nor axe can see.
              Panel is `min-w-0` already. */}
          <Panel
            className="self-start"
            title={
              <span className="flex items-center gap-2">
                <Users aria-hidden="true" className="h-4 w-4 text-primary" />
                People you follow
              </span>
            }
          >
            {followingsQuery.isError ? (
              <InlineAlert variant="error">
                Couldn&apos;t load the accounts you follow. Try refreshing the page.
              </InlineAlert>
            ) : (
              <div className="space-y-4">
                <ListSearch
                  label="Search followings"
                  value={userSearch}
                  onChange={setUserSearch}
                  shown={shownFollowings.length}
                  total={followings.length}
                  noun="followings"
                  placeholder="Search followings"
                />

                <div className="max-h-[60dvh] space-y-2 overflow-y-auto pr-1">
                  {loadingUsers ? (
                    <div role="status" className="space-y-2">
                      <span className="sr-only">Loading the accounts you follow…</span>
                      {Array.from({ length: 6 }).map((_, index) => (
                        <Skeleton key={index} aria-hidden="true" className="h-14 w-full" />
                      ))}
                    </div>
                  ) : shownFollowings.length === 0 ? (
                    <EmptyState icon={<Users className="h-6 w-6" />} title="No followings found" description="Try another search." />
                  ) : (
                    shownFollowings.map((user) => {
                      const isActive = selectedUser?.id === user.id;
                      return (
                        <button
                          key={user.id}
                          type="button"
                          onClick={() => selectUser(user)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                            isActive
                              ? "border-primary/40 bg-orange-50 text-foreground dark:bg-orange-950/20 dark:text-foreground"
                              : "border-transparent bg-gray-50 hover:border-border dark:bg-secondary/20",
                          )}
                        >
                          <img
                            src={user.avatar_url || "/brand/icon-192.png"}
                            alt=""
                            width={36}
                            height={36}
                            loading="lazy"
                            decoding="async"
                            className="h-9 w-9 rounded-full object-cover"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{user.username}</div>
                            {typeof user.followers_count === "number" && (
                              <div className="text-xs text-muted-foreground">
                                {user.followers_count.toLocaleString()} followers
                              </div>
                            )}
                          </div>
                          {isActive && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary-text">
                              <Check aria-hidden="true" className="h-4 w-4" />
                              Selected
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </Panel>

          <div className="min-w-0 space-y-6">
            {!selectedUser ? (
              <Panel>
                <EmptyState
                  icon={<Users className="h-6 w-6" />}
                  title="Select a followed user"
                  description="Choose someone you follow to browse their public SoundCloud library."
                />
              </Panel>
            ) : (
              <>
                <Panel
                  title={
                    <span className="flex min-w-0 items-center gap-3">
                      <img
                        src={selectedUser.avatar_url || "/brand/icon-192.png"}
                        alt=""
                        width={48}
                        height={48}
                        loading="lazy"
                        decoding="async"
                        className="h-12 w-12 shrink-0 rounded-full object-cover ring-2 ring-border/60"
                      />
                      <span className="min-w-0 truncate">{selectedUser.username}</span>
                    </span>
                  }
                  description="Public content only — private items won't appear."
                  actions={
                    selectedUser.permalink_url ? (
                      <a
                        href={selectedUser.permalink_url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${selectedUser.username} on SoundCloud`}
                        className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold hover:bg-surface-hover"
                      >
                        Open on SoundCloud
                      </a>
                    ) : undefined
                  }
                >
                  <div
                    className="grid grid-cols-1 gap-1 rounded-xl border border-border/80 bg-background/80 p-1 sm:grid-cols-3"
                    role="tablist"
                    aria-label="Library section"
                  >
                    {TAB_ORDER.map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        id={tabId(tab)}
                        aria-controls={panelId(tab)}
                        aria-selected={activeTab === tab}
                        tabIndex={activeTab === tab ? 0 : -1}
                        ref={(node) => {
                          tabRefs.current[tab] = node;
                        }}
                        onKeyDown={(event) => onTabKeyDown(event, tab)}
                        onClick={() => setActiveTab(tab)}
                        className={cn(
                          "flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition",
                          activeTab === tab
                            ? "bg-surface text-primary-text shadow-sm ring-1 ring-primary/25 dark:bg-secondary/40"
                            : "text-muted-foreground hover:bg-surface/80 hover:text-foreground",
                        )}
                      >
                        {tab === "likes" && <Music aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />}
                        {tab === "playlists" && <ListMusic aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />}
                        {tab === "liked-playlists" && <Heart aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />}
                        <span className="truncate">{TAB_LABELS[tab]}</span>
                      </button>
                    ))}
                  </div>
                </Panel>

                <div
                  role="tabpanel"
                  id={panelId(activeTab)}
                  aria-labelledby={tabId(activeTab)}
                  className="space-y-6"
                >
                  {activeTab === "likes" ? (
                    <>
                      <Panel title="Save to your library">
                        <div className="space-y-4">
                          <SegmentedControl
                            label="Where to save"
                            value={addMode}
                            options={ADD_MODES}
                            onChange={setAddMode}
                          />
                          {addMode === "new" ? (
                            <Field label="Playlist name">
                              {(field) => (
                                <Input
                                  {...field}
                                  value={playlistName}
                                  onChange={(event) => setPlaylistName(event.target.value)}
                                  placeholder="Name for new playlist(s)"
                                />
                              )}
                            </Field>
                          ) : (
                            <PlaylistChooser
                              label="Target playlist"
                              dialogTitle="Choose target playlist"
                              placeholder="Choose playlist…"
                              playlists={ownPlaylists}
                              value={targetPlaylist}
                              onChange={setTargetPlaylist}
                              loading={ownPlaylistsQuery.isLoading}
                              loadError={ownPlaylistsQuery.isError}
                              onRetry={() => void ownPlaylistsQuery.refetch()}
                            />
                          )}
                          <div>
                            <Button
                              variant="secondary"
                              onClick={() => createFromLikes("all")}
                              disabled={working || !canCreateFromTracks}
                            >
                              {working ? (
                                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                              ) : (
                                <Plus aria-hidden="true" className="h-4 w-4" />
                              )}
                              <span className="hidden sm:inline">All public likes</span>
                              <span className="sm:hidden">All likes</span>
                            </Button>
                          </div>
                          {/* Was a `title` on the button above — invisible to touch and to a
                              screen reader that does not read tooltips. */}
                          <p className="text-sm text-muted-foreground">
                            &ldquo;All public likes&rdquo; fetches up to 200 of this user&apos;s public likes from
                            SoundCloud, not just the ones listed here. Selected tracks use the action bar at the
                            bottom of the screen.
                          </p>
                        </div>
                      </Panel>

                      <Panel
                        title={
                          <span className="flex items-center gap-2">
                            <Music aria-hidden="true" className="h-4 w-4 text-primary" />
                            Liked tracks
                          </span>
                        }
                        description="Tap tracks to select; use the bottom bar for bulk actions."
                        actions={
                          tracks.length > 0 ? (
                            <Button nowrap variant="secondary" onClick={toggleAllTracks}>
                              {tracksFiltered ? trackToggleLabel : allTracksSelected ? "Clear loaded" : "Select loaded"}
                            </Button>
                          ) : undefined
                        }
                      >
                        <div className="space-y-4">
                          {loadAlert}
                          {loadingContent ? (
                            <ContentSkeleton />
                          ) : tracks.length === 0 ? (
                            <EmptyState
                              icon={<Music className="h-6 w-6" />}
                              title="No public liked tracks"
                              description="This user may keep likes private, or the API may not expose them."
                            />
                          ) : (
                            <>
                              <ListSearch
                                label="Search liked tracks"
                                value={trackSearch}
                                onChange={setTrackSearch}
                                shown={shownTracks.length}
                                total={tracks.length}
                                noun={tracks.length === 1 ? "track" : "tracks"}
                                pendingNote={pendingNote}
                              />
                              {shownTracks.length === 0 ? (
                                <EmptyState
                                  className="min-h-[160px] py-8"
                                  title="No tracks match your search"
                                  description="Try fewer or different words."
                                />
                              ) : (
                                <SelectableList className="max-h-[60dvh] overflow-y-auto overscroll-contain pr-1">
                                  {shownTracks.map((track, index) => (
                                    <TrackRow
                                      as="li"
                                      key={track.id}
                                      track={{
                                        id: track.id,
                                        title: track.title,
                                        user: track.user,
                                        artwork_url: track.artwork_url,
                                        subtitle: (
                                          <span>
                                            {track.user?.username || "Unknown"}
                                            {formatDuration(track.duration) ? ` / ${formatDuration(track.duration)}` : ""}
                                          </span>
                                        ),
                                      }}
                                      isSelected={selectedTracks.has(track.id)}
                                      onToggle={(event) => toggleTrack(track, index, event)}
                                    />
                                  ))}
                                </SelectableList>
                              )}
                            </>
                          )}
                          {loadMore}
                        </div>
                      </Panel>
                    </>
                  ) : (
                    <Panel
                      title={
                        <span className="flex items-center gap-2">
                          <ListMusic aria-hidden="true" className="h-4 w-4 text-primary" />
                          {TAB_LABELS[activeTab]}
                        </span>
                      }
                      description="Select playlists, add an optional name prefix, then clone from the bar below."
                    >
                      <div className="space-y-4">
                        <Field
                          label="Title prefix"
                          hint="Optional — prepended to the title of every cloned playlist."
                          className="max-w-xl"
                        >
                          {(field) => (
                            <Input
                              {...field}
                              value={titlePrefix}
                              onChange={(event) => setTitlePrefix(event.target.value)}
                              placeholder="Optional prefix for cloned playlists"
                            />
                          )}
                        </Field>

                        {loadAlert}
                        <PlaylistPicker
                          // A different user or tab is a different list: start its search empty.
                          key={`${selectedUser.id}-${activeTab}`}
                          playlists={pickerPlaylists}
                          mode="multi"
                          showBulkSelect
                          selectedIds={selectedPlaylists}
                          onChange={(next) => setSelectedPlaylists(new Set(next.map((p) => Number(p.id))))}
                          loading={loadingContent}
                          searchLabel={`Search ${TAB_LABELS[activeTab].toLowerCase()}`}
                          emptyTitle={`No public ${activeTab === "playlists" ? "playlists" : "liked playlists"}`}
                          emptyDescription="This list may be private or unavailable through the API."
                        />
                        {pendingNote ? (
                          <p className="text-sm text-muted-foreground">
                            Only the playlists loaded so far are listed, searched and selected — load more to include
                            the rest.
                          </p>
                        ) : null}
                        {loadMore}
                      </div>
                    </Panel>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <SelectionBanner
        count={activeSelectionCount}
        entityName={activeTab === "likes" ? "track" : "playlist"}
        actionLabel={actionLabel}
        onAction={activeSelectionAction}
        disabled={actionDisabled}
        actionIcon={working ? <Loader2 className="h-4 w-4 animate-spin" /> : activeTab === "likes" ? <Plus className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      />
    </PageContainer>
  );
}

function ContentSkeleton() {
  return (
    <div role="status" className="space-y-2">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} aria-hidden="true" className="h-16 w-full" />
      ))}
    </div>
  );
}

/** Everything the run produced, under the panel's title and sentence. */
function OutcomeBody({ outcome }: { outcome: Outcome }) {
  const { created, partials, errors, countLine } = outcome;
  return (
    <>
      {countLine ? <p className="text-sm text-muted-foreground">{countLine}</p> : null}

      {created.length > 0 && (
        <div className="space-y-2">
          {created.map((playlist, index) => (
            <div key={`${playlist.id || index}`} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{playlist.title}</div>
                {playlist.trackCount != null && <div className="text-xs text-muted-foreground">{playlist.trackCount} tracks</div>}
              </div>
              {playlist.permalink_url && (
                <a
                  href={playlist.permalink_url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${playlist.title ?? "the playlist"} on SoundCloud`}
                  className="inline-flex min-h-11 shrink-0 items-center px-2 text-sm font-semibold text-primary-text"
                >
                  Open
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {partials.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-warning-text">
            {partials.length === 1 ? "This copy is only partly filled." : "These copies are only partly filled."} Open {partials.length === 1 ? "it" : "them"} on SoundCloud to finish or delete {partials.length === 1 ? "it" : "them"}.
          </p>
          {partials.map((playlist, index) => (
            <div key={`${playlist.id ?? index}`} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{playlist.title}</div>
                {playlist.tracksWritten != null && playlist.intendedTrackCount != null && (
                  <div className="text-xs text-muted-foreground">
                    at least {playlist.tracksWritten} of {playlist.intendedTrackCount} tracks
                  </div>
                )}
              </div>
              {playlist.permalink_url && (
                <a
                  href={playlist.permalink_url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open partly filled copy ${playlist.title ?? "of the playlist"} on SoundCloud`}
                  className="inline-flex min-h-11 shrink-0 items-center px-2 text-sm font-semibold text-primary-text"
                >
                  Open
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((entry, index) => (
            <li key={`${entry.id}-${index}`} className="break-words">
              <span className="font-semibold">{entry.name}:</span> {entry.error}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
