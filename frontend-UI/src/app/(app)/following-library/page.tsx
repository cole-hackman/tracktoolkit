"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Heart,
  Loader2,
  ListMusic,
  Music,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Input,
  PageContainer,
  PageHeader,
  ResultPanel,
  SectionHeading,
  SelectableList,
  SelectableRow,
  SelectionBanner,
  Skeleton,
  TrackRow,
  useAnnounce,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { invalidatePlaylistCaches, useFollowingsQuery, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

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

/** `id` of a tab button and of the panel it controls — the pair ARIA needs. */
const tabId = (tab: LibraryTab) => `following-library-tab-${tab}`;
const panelId = (tab: LibraryTab) => `following-library-panel-${tab}`;

export default function FollowingLibraryPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [selectedUser, setSelectedUser] = useState<Following | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [activeTab, setActiveTab] = useState<LibraryTab>("likes");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [nextHref, setNextHref] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());
  const [selectedPlaylists, setSelectedPlaylists] = useState<Set<number>>(new Set());
  const [playlistName, setPlaylistName] = useState("");
  const [addMode, setAddMode] = useState<AddMode>("new");
  const [targetPlaylist, setTargetPlaylist] = useState<Playlist | null>(null);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [titlePrefix, setTitlePrefix] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [result, setResult] = useState<CloneResult | null>(null);

  const followingsQuery = useFollowingsQuery();
  const ownPlaylistsQuery = usePlaylistsQuery({ enabled: addMode === "existing" });
  const followings = useMemo(
    () => asArray<Following>(followingsQuery.data?.collection),
    [followingsQuery.data?.collection],
  );
  const ownPlaylists = useMemo(
    () => asArray<Playlist>(ownPlaylistsQuery.data?.collection),
    [ownPlaylistsQuery.data?.collection],
  );
  const loadingUsers = followingsQuery.isLoading;
  const loadingOwnPlaylists = ownPlaylistsQuery.isLoading;

  useEffect(() => {
    if (selectedUser) {
      fetchLibraryPage(activeTab, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUser, activeTab]);

  useEffect(() => {
    if (followingsQuery.isError) {
      setNotice({ type: "error", text: "Couldn't load the accounts you follow. Try refreshing the page." });
    }
  }, [followingsQuery.isError]);

  useEffect(() => {
    if (!selectedUser && followings.length > 0) {
      setSelectedUser(followings[0]);
    }
  }, [followings, selectedUser]);

  const filteredFollowings = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    return followings
      .filter((user) => !query || user.username?.toLowerCase().includes(query))
      .sort((a, b) => (a.username || "").localeCompare(b.username || ""));
  }, [followings, userSearch]);

  const selectedPlaylistItems = useMemo(
    () => playlists.filter((playlist) => selectedPlaylists.has(playlist.id)),
    [playlists, selectedPlaylists],
  );

  const fetchLibraryPage = async (tab: LibraryTab, reset: boolean) => {
    if (!selectedUser) return;
    if (reset) {
      setLoadingContent(true);
      setTracks([]);
      setPlaylists([]);
      setNextHref(null);
      setSelectedTracks(new Set());
      setSelectedPlaylists(new Set());
      setResult(null);
    } else {
      setLoadingMore(true);
    }
    setNotice(null);

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
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Couldn't load this user's public library.",
      });
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

  const toggleTrack = (id: number) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePlaylist = (id: number) => {
    setSelectedPlaylists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectLoadedTracks = () => {
    if (selectedTracks.size === tracks.length) setSelectedTracks(new Set());
    else setSelectedTracks(new Set(tracks.map((track) => track.id)));
  };

  const selectLoadedPlaylists = () => {
    if (selectedPlaylists.size === playlists.length) setSelectedPlaylists(new Set());
    else setSelectedPlaylists(new Set(playlists.map((playlist) => playlist.id)));
  };

  const canCreateFromTracks =
    selectedUser &&
    (addMode === "existing" ? targetPlaylist !== null : playlistName.trim().length > 0);

  const createFromLikes = async (mode: "selected" | "all") => {
    if (!selectedUser || !canCreateFromTracks) return;
    if (mode === "selected" && selectedTracks.size === 0) return;

    setWorking(true);
    setNotice(null);
    setResult(null);
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
      setResult(data);
      setNotice({
        type: "success",
        text: addMode === "existing" ? "Tracks added to your playlist." : "Playlist created in your library.",
      });
    } catch (error) {
      console.error("Failed to create from followed likes:", error);
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Couldn't create the playlist." });
    } finally {
      setWorking(false);
    }
  };

  const cloneSelectedPlaylists = async () => {
    if (!selectedUser || selectedPlaylists.size === 0) return;
    setWorking(true);
    setNotice(null);
    setResult(null);
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
          // The panel carries the outcome (its heading takes focus), so the
          // server's sentence goes inside it rather than in a second alert.
          setResult({ partialPlaylists: partials, errors: itemErrors, summary: message });
        } else {
          setNotice({ type: "error", text: message });
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
      setResult(
        hasProblems
          ? { ...data, summary: "Some playlists were cloned, but not all of them finished." }
          : data,
      );
      if (!hasProblems) setNotice({ type: "success", text: "Selected playlists were cloned into your library." });
      void invalidatePlaylistCaches(queryClient);
    } catch (error) {
      console.error("Failed to clone followed playlists:", error);
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Couldn't clone the selected playlists." });
    } finally {
      setWorking(false);
    }
  };

  const formatDuration = (ms?: number | null) => {
    if (!ms) return "";
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

  return (
    <PageContainer maxWidth="wide" className="pb-28">
      <PageHeader
        title="Following Library"
        description="Copy public tracks and playlists from people you follow into your library."
      />

      {notice && (
        <InlineAlert variant={notice.type} className="mb-5" onDismiss={() => setNotice(null)}>
          {notice.text}
        </InlineAlert>
      )}

      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* `min-w-0`: a grid item's automatic minimum size is its min-content
            width, so one unbreakable username (a SoundCloud permalink slug can
            easily be 60 characters) sizes the whole single-column track to it.
            Nothing scrolls sideways — the results card is `overflow-hidden` —
            so the tabs and buttons in the other column are simply clipped off
            the right edge, which neither the overflow test nor axe can see. */}
        <Card className="min-w-0 self-start">
          <CardHeader>
            <SectionHeading className="text-base">
              <span className="flex items-center gap-2">
                <Users aria-hidden="true" className="h-4 w-4 text-primary" />
                People you follow
              </span>
            </SectionHeading>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Search followings">
              {(field) => (
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    {...field}
                    type="search"
                    value={userSearch}
                    onChange={(event) => setUserSearch(event.target.value)}
                    placeholder="Search followings"
                    className="pl-9"
                  />
                </div>
              )}
            </Field>

            <div className="max-h-[60dvh] space-y-2 overflow-y-auto pr-1">
              {loadingUsers ? (
                <div role="status" className="space-y-2">
                  <span className="sr-only">Loading the accounts you follow…</span>
                  {Array.from({ length: 6 }).map((_, index) => (
                    <Skeleton key={index} aria-hidden="true" className="h-14 w-full" />
                  ))}
                </div>
              ) : filteredFollowings.length === 0 ? (
                <EmptyState icon={<Users className="h-8 w-8" />} title="No followings found" description="Try another search." />
              ) : (
                filteredFollowings.map((user) => {
                  const isActive = selectedUser?.id === user.id;
                  return (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => selectUser(user)}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                        isActive
                          ? "border-primary/40 bg-orange-50 text-foreground dark:bg-orange-950/20 dark:text-foreground"
                          : "border-transparent bg-gray-50 hover:border-border dark:bg-secondary/20"
                      }`}
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
          </CardContent>
        </Card>

        <div className="min-w-0">
          {!selectedUser ? (
            <Card>
              <CardContent className="py-10">
                <EmptyState
                  icon={<Users className="h-8 w-8" />}
                  title="Select a followed user"
                  description="Choose someone you follow to browse their public SoundCloud library."
                />
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden shadow-elevation-1">
              <CardHeader className="space-y-5 border-b border-border/60 bg-muted/15 pb-5 pt-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <img
                      src={selectedUser.avatar_url || "/brand/icon-192.png"}
                      alt=""
                      width={48}
                      height={48}
                      loading="lazy"
                      decoding="async"
                      className="h-12 w-12 shrink-0 rounded-full object-cover ring-2 ring-border/60"
                    />
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold text-foreground">{selectedUser.username}</h2>
                      <p className="text-sm text-muted-foreground">Public content only — private items won&apos;t appear.</p>
                    </div>
                  </div>
                  {selectedUser.permalink_url && (
                    <a
                      href={selectedUser.permalink_url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${selectedUser.username} on SoundCloud`}
                      className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold hover:bg-surface-hover"
                    >
                      Open on SoundCloud
                    </a>
                  )}
                </div>

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
              </CardHeader>

              <CardContent
                role="tabpanel"
                id={panelId(activeTab)}
                aria-labelledby={tabId(activeTab)}
                className="space-y-4 pt-6"
              >
                {activeTab === "likes" ? (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <SectionHeading as="h3" className="text-base">
                          <span className="flex items-center gap-2">
                            <Music aria-hidden="true" className="h-4 w-4 text-primary" />
                            Liked tracks
                          </span>
                        </SectionHeading>
                        <p className="text-sm text-muted-foreground">Tap tracks to select; use the bottom bar for bulk actions.</p>
                      </div>
                      <Button nowrap variant="secondary" className="shrink-0" onClick={selectLoadedTracks} disabled={tracks.length === 0}>
                        {selectedTracks.size === tracks.length && tracks.length > 0 ? "Clear loaded" : "Select loaded"}
                      </Button>
                    </div>

                    <CreatePanel
                      addMode={addMode}
                      setAddMode={setAddMode}
                      playlistName={playlistName}
                      setPlaylistName={setPlaylistName}
                      targetPlaylist={targetPlaylist}
                      setShowPlaylistPicker={setShowPlaylistPicker}
                      canCreate={Boolean(canCreateFromTracks)}
                      working={working}
                      onCreateAll={() => createFromLikes("all")}
                    />

                    {showPlaylistPicker && (
                      <PlaylistPicker
                        playlists={ownPlaylists}
                        loading={loadingOwnPlaylists}
                        selected={targetPlaylist}
                        onSelect={(playlist) => {
                          setTargetPlaylist(playlist);
                          setShowPlaylistPicker(false);
                        }}
                        onClose={() => setShowPlaylistPicker(false)}
                      />
                    )}

                    <ContentListState
                      loading={loadingContent}
                      empty={tracks.length === 0}
                      emptyTitle="No public liked tracks"
                      emptyDescription="This user may keep likes private, or the API may not expose them."
                    >
                      <SelectableList>
                        {tracks.map((track) => (
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
                            onToggle={() => toggleTrack(track.id)}
                          />
                        ))}
                      </SelectableList>
                    </ContentListState>
                  </>
                ) : (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <SectionHeading as="h3" className="text-base">
                          <span className="flex items-center gap-2">
                            <ListMusic aria-hidden="true" className="h-4 w-4 text-primary" />
                            {TAB_LABELS[activeTab]}
                          </span>
                        </SectionHeading>
                        <p className="text-sm text-muted-foreground">Select playlists, add an optional name prefix, then clone from the bar below.</p>
                      </div>
                      <Button nowrap variant="secondary" className="shrink-0" onClick={selectLoadedPlaylists} disabled={playlists.length === 0}>
                        {selectedPlaylists.size === playlists.length && playlists.length > 0 ? "Clear loaded" : "Select loaded"}
                      </Button>
                    </div>

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

                    <ContentListState
                      loading={loadingContent}
                      empty={playlists.length === 0}
                      emptyTitle={`No public ${activeTab === "playlists" ? "playlists" : "liked playlists"}`}
                      emptyDescription="This list may be private or unavailable through the API."
                    >
                      {/* Was a `<button>` wearing a fake checkbox `<div>`: no
                          checked state to read, and selection said only in
                          colour. `SelectableRow` is a real checkbox. */}
                      <SelectableList className="md:grid-cols-2 md:gap-3">
                        {playlists.map((playlist) => (
                          <SelectableRow
                            key={playlist.id}
                            id={playlist.id}
                            selected={selectedPlaylists.has(playlist.id)}
                            onToggle={() => togglePlaylist(playlist.id)}
                            label={playlist.title}
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <img
                                src={playlist.artwork_url || "/brand/icon-192.png"}
                                alt=""
                                width={48}
                                height={48}
                                loading="lazy"
                                decoding="async"
                                className="h-12 w-12 shrink-0 rounded-lg object-cover"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-semibold text-foreground">
                                  {playlist.title}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {(playlist.track_count || 0).toLocaleString()} tracks
                                </span>
                              </span>
                            </span>
                          </SelectableRow>
                        ))}
                      </SelectableList>
                    </ContentListState>
                  </>
                )}
              </CardContent>

              {nextHref && (
                <CardFooter className="flex justify-center border-t border-border/60 bg-muted/10 py-4">
                  <Button nowrap variant="secondary" onClick={() => fetchLibraryPage(activeTab, false)} disabled={loadingMore}>
                    {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                    Load more
                  </Button>
                </CardFooter>
              )}

              {result && (
                <div className="border-t border-border/60 px-5 pb-5 pt-4">
                  <ResultSummary
                    result={result}
                    sourceName={(id) => playlists.find((p) => Number(p.id) === Number(id))?.title || `Playlist ${id}`}
                  />
                </div>
              )}
            </Card>
          )}
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

function CreatePanel({
  addMode,
  setAddMode,
  playlistName,
  setPlaylistName,
  targetPlaylist,
  setShowPlaylistPicker,
  canCreate,
  working,
  onCreateAll,
}: {
  addMode: AddMode;
  setAddMode: (mode: AddMode) => void;
  playlistName: string;
  setPlaylistName: (name: string) => void;
  targetPlaylist: Playlist | null;
  setShowPlaylistPicker: (show: boolean) => void;
  canCreate: boolean;
  working: boolean;
  onCreateAll: () => void;
}) {
  return (
    <div className="rounded-xl border border-border/80 bg-muted/25 p-4 dark:bg-muted/15">
      <SectionHeading as="h3" className="mb-3">
        Save to your library
      </SectionHeading>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-4">
        <div role="group" aria-label="Where to save" className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={addMode === "new"}
            onClick={() => setAddMode("new")}
            className={cn(
              "min-h-11 rounded-lg border px-3 py-2 text-sm font-semibold transition",
              addMode === "new"
                ? "border-primary/50 bg-orange-50 text-primary-text dark:bg-orange-950/20"
                : "border-border bg-background/60 hover:bg-surface-hover",
            )}
          >
            New playlist
          </button>
          <button
            type="button"
            aria-pressed={addMode === "existing"}
            onClick={() => setAddMode("existing")}
            className={cn(
              "min-h-11 rounded-lg border px-3 py-2 text-sm font-semibold transition",
              addMode === "existing"
                ? "border-primary/50 bg-orange-50 text-primary-text dark:bg-orange-950/20"
                : "border-border bg-background/60 hover:bg-surface-hover",
            )}
          >
            Add to existing
          </button>
        </div>

        <div className="min-w-0 flex-1">
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
            <div className="grid gap-1.5">
              {/* A `<label>` cannot label a button, so the caption is plain
                  text the button points at with `aria-labelledby`. */}
              <span id="following-library-target" className="text-sm font-semibold text-foreground">
                Target playlist
              </span>
              <Button
                variant="secondary"
                className="w-full justify-start sm:w-auto"
                aria-labelledby="following-library-target following-library-target-value"
                onClick={() => setShowPlaylistPicker(true)}
              >
                <span id="following-library-target-value">
                  {targetPlaylist ? targetPlaylist.title : "Choose playlist…"}
                </span>
              </Button>
            </div>
          )}
        </div>

        <Button
          variant="secondary"
          className="shrink-0 lg:self-end"
          onClick={onCreateAll}
          disabled={working || !canCreate}
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
      <p className="mt-3 text-sm text-muted-foreground">
        &ldquo;All public likes&rdquo; fetches up to 200 of this user&apos;s public likes from
        SoundCloud, not just the ones listed here. Selected tracks use the action bar at the
        bottom of the screen.
      </p>
    </div>
  );
}

function PlaylistPicker({
  playlists,
  loading,
  selected,
  onSelect,
  onClose,
}: {
  playlists: Playlist[];
  loading: boolean;
  selected: Playlist | null;
  onSelect: (playlist: Playlist) => void;
  onClose: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <SectionHeading as="h3">Choose target playlist</SectionHeading>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X aria-hidden="true" className="h-4 w-4" />
        </IconButton>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div role="status" className="space-y-2">
            <span className="sr-only">Loading your playlists…</span>
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} aria-hidden="true" className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div className="max-h-[60dvh] space-y-2 overflow-y-auto">
            {playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                onClick={() => onSelect(playlist)}
                aria-current={selected?.id === playlist.id ? "true" : undefined}
                className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${
                  selected?.id === playlist.id ? "border-primary/50 bg-orange-50 dark:bg-orange-950/20" : "border-border"
                }`}
              >
                <span className="truncate font-semibold">
                  {playlist.title}
                  {selected?.id === playlist.id && <span className="sr-only"> (current target)</span>}
                </span>
                <span className="ml-3 shrink-0 text-xs text-muted-foreground">{playlist.track_count || 0} tracks</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ContentListState({
  loading,
  empty,
  emptyTitle,
  emptyDescription,
  children,
}: {
  loading: boolean;
  empty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <div role="status" className="space-y-2">
        <span className="sr-only">Loading…</span>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} aria-hidden="true" className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (empty) {
    return <EmptyState icon={<Music className="h-8 w-8" />} title={emptyTitle} description={emptyDescription} />;
  }

  return <>{children}</>;
}

function ResultSummary({ result, sourceName }: { result: CloneResult; sourceName: (id: number) => string }) {
  const playlists = result.playlists || (result.playlist ? [result.playlist] : []);
  const partialPlaylists = result.partialPlaylists || [];
  const hasProblems = (result.errors && result.errors.length > 0) || partialPlaylists.length > 0;
  // Only the clone endpoint answers with stats.numPlaylistsCreated, or (when
  // nothing was fully created) with partialPlaylists and no track totals.
  const isClone =
    typeof result.stats?.numPlaylistsCreated === "number" ||
    result.summary !== undefined ||
    (partialPlaylists.length > 0 && result.addedCount == null && result.totalTracks == null);

  // The outcome of a clone appears at the bottom of a long card with no focus
  // change, so it can be missed entirely. A `role="status"` region that mounts
  // with its content already in it is not reliably announced either — moving
  // focus to its heading is what actually lands the user on the answer.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const heading = containerRef.current?.querySelector("h2");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
  }, []);

  return (
    <div ref={containerRef} role="status">
    <ResultPanel title={hasProblems ? "Finished with problems" : "Done"} tone={hasProblems ? "neutral" : "success"}>
      <div className="space-y-4">
        {result.summary && <p className="text-sm font-semibold">{result.summary}</p>}
        {isClone ? (
          playlists.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {`Cloned ${playlists.length} playlist${playlists.length === 1 ? "" : "s"}.`}
            </p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {typeof result.addedCount === "number"
              ? `Added ${result.addedCount} track${result.addedCount === 1 ? "" : "s"} to your playlist.`
              : `Saved ${result.totalTracks || 0} track${(result.totalTracks || 0) === 1 ? "" : "s"} across ${playlists.length || 1} playlist${(playlists.length || 1) === 1 ? "" : "s"}.`}
          </p>
        )}

        {playlists.length > 0 && (
          <div className="space-y-2">
            {playlists.map((playlist, index) => (
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

        {partialPlaylists.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-warning-text">
              {partialPlaylists.length === 1 ? "This copy is only partly filled." : "These copies are only partly filled."} Open {partialPlaylists.length === 1 ? "it" : "them"} on SoundCloud to finish or delete {partialPlaylists.length === 1 ? "it" : "them"}.
            </p>
            {partialPlaylists.map((playlist, index) => (
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

        {result.errors && result.errors.length > 0 && (
          <InlineAlert variant="warning">
            <ul className="space-y-1">
              {result.errors.map((entry, index) => (
                <li key={`${entry.id}-${index}`} className="break-words">
                  <span className="font-semibold">{sourceName(entry.id)}:</span> {entry.error}
                </li>
              ))}
            </ul>
          </InlineAlert>
        )}
      </div>
    </ResultPanel>
    </div>
  );
}
