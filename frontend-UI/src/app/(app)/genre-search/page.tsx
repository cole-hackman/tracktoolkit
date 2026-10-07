"use client";

import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Plus, Music, ChevronDown } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  SectionHeading,
  Select,
  SelectableList,
  SelectionBanner,
  TrackRow,
  useAnnounce,
} from "@/components/ui";
import { invalidatePlaylistCaches, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { COMMON_GENRES } from "@/lib/genres";

interface Track {
  id: number;
  title: string;
  user?: { username: string };
  artwork_url?: string;
  duration?: number;
  genre?: string;
  permalink_url?: string;
}

interface Playlist {
  id: number;
  title: string;
  track_count: number;
}

type AddMode = "new" | "existing";

function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function GenreSearchPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const advancedPanelId = useId();
  const addModeLabelId = useId();
  const resultsRef = useRef<HTMLDivElement>(null);
  /**
   * Where focus goes when the dialog closes.
   *
   * Null for a cancel or an Escape, so `useDialog` falls back to whatever was
   * focused before — the selection banner's button, which is still there. A
   * successful add is different: it clears the selection, `SelectionBanner`
   * returns null at a count of zero, and that button unmounts in the same
   * commit. Focusing a detached node is a silent no-op that drops the user at
   * `<body>`, above both the results and the success message, so on success
   * this is pointed at the results block instead.
   */
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  // Search form state
  const [genre, setGenre] = useState("");
  const [tags, setTags] = useState("");
  const [bpmMin, setBpmMin] = useState("");
  const [bpmMax, setBpmMax] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Results state
  const [results, setResults] = useState<Track[]>([]);
  const [nextHref, setNextHref] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState("");

  // Selection state
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());

  // Add-to-playlist state
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("new");
  const [playlistName, setPlaylistName] = useState("");
  const [targetPlaylist, setTargetPlaylist] = useState<Playlist | null>(null);
  const [adding, setAdding] = useState(false);
  const [addSuccess, setAddSuccess] = useState("");
  const [addError, setAddError] = useState("");
  const playlistsQuery = usePlaylistsQuery({ enabled: showAddPanel && addMode === "existing" });
  const userPlaylists = asArray<Playlist>(playlistsQuery.data?.collection);
  const loadingPlaylists = playlistsQuery.isLoading;

  const buildSearchParams = () => {
    const params = new URLSearchParams();
    if (genre.trim()) params.set("genres", genre.trim());
    if (tags.trim()) params.set("tags", tags.trim());
    if (bpmMin.trim()) params.set("bpm_from", bpmMin.trim());
    if (bpmMax.trim()) params.set("bpm_to", bpmMax.trim());
    params.set("limit", "50");
    return params;
  };

  const handleSearch = async () => {
    if (!genre.trim() && !tags.trim()) {
      setSearchError("Enter at least a genre or tag to search.");
      return;
    }
    setSearchError("");
    setSearching(true);
    setHasSearched(true);
    setResults([]);
    setNextHref(null);
    setSelectedTracks(new Set());
    try {
      const params = buildSearchParams();
      const res = await apiFetch(`/api/tracks/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        const collection = data.collection || [];
        setResults(collection);
        setNextHref(data.next_href || null);
        announce(`${collection.length} track${collection.length === 1 ? "" : "s"} found`);
      } else {
        const err = await res.json().catch(() => ({}));
        setSearchError(typeof err?.error === "string" ? err.error : "Search failed. Try different filters.");
      }
    } catch {
      setSearchError("An error occurred. Please try again.");
    } finally {
      setSearching(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextHref) return;
    setLoadingMore(true);
    try {
      // next_href is a full SoundCloud URL — proxy through our search endpoint with offset
      const url = new URL(nextHref);
      const cursor = url.searchParams.get("cursor") || url.searchParams.get("offset");
      const params = buildSearchParams();
      if (cursor) params.set("offset", cursor);
      const res = await apiFetch(`/api/tracks/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        const collection = data.collection || [];
        setResults((prev) => [...prev, ...collection]);
        setNextHref(data.next_href || null);
        announce(`${collection.length} more track${collection.length === 1 ? "" : "s"} loaded`);
      } else {
        setSearchError("Couldn’t load more tracks. Please try again.");
      }
    } catch {
      setSearchError("Couldn’t load more tracks. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleTrack = (id: number) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleOpenAddPanel = () => {
    // Cancel/Escape should go back to the banner button that opened this.
    dialogReturnFocusRef.current = null;
    setShowAddPanel(true);
    setAddSuccess("");
    setAddError("");
  };

  const handleAddToPlaylist = async () => {
    if (selectedTracks.size === 0) return;
    const canAdd = addMode === "existing" ? targetPlaylist !== null : playlistName.trim().length > 0;
    if (!canAdd) return;

    setAdding(true);
    setAddError("");
    try {
      const body: Record<string, unknown> = {
        trackIds: Array.from(selectedTracks),
      };
      if (addMode === "existing" && targetPlaylist) {
        body.targetPlaylistId = targetPlaylist.id;
      } else {
        body.title = playlistName.trim();
      }

      const res = await apiFetch("/api/playlists/from-likes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await invalidatePlaylistCaches(queryClient, targetPlaylist?.id ?? null);
        const count = data.addedCount ?? data.totalTracks ?? selectedTracks.size;
        const name = addMode === "existing" ? targetPlaylist?.title : (data.playlist?.title || playlistName);
        setAddSuccess(`${count} track${count !== 1 ? "s" : ""} added to "${name}".`);
        announce(`${count} track${count !== 1 ? "s" : ""} added to ${name}`, { assertive: true });
        // Hand focus to the results block before the selection clears and the
        // banner button this dialog was opened from stops existing.
        dialogReturnFocusRef.current = resultsRef.current;
        setShowAddPanel(false);
        setSelectedTracks(new Set());
        setPlaylistName("");
      } else {
        // Show the reason first: it must not wait on a cold list refetch.
        setAddError(errorMessageFromBody(data, "Failed to add tracks."));
        if (res.status === 409 && data?.code === "PLAYLIST_NOT_FOUND") {
          // The chosen target is gone from SoundCloud and nothing was written.
          setTargetPlaylist(null);
          void invalidatePlaylistCaches(queryClient);
        }
      }
    } catch {
      setAddError("An error occurred. Please try again.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <PageContainer maxWidth="default" className="pb-28">
        <PageHeader
          title="Genre Search"
          description="Discover tracks by genre or tag and add them to your playlists."
        />

        {/* Search Form */}
        <Card className="mb-8 space-y-4 p-4 sm:p-6">
          <SectionHeading>Filters</SectionHeading>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Genre input with suggestions */}
            <div className="min-w-0">
              <Field label="Genre" hint="Start typing for suggestions">
                {(field) => (
                  <Input
                    {...field}
                    type="text"
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder="e.g. house, techno, ambient…"
                    list="genre-suggestions"
                    className="h-11"
                  />
                )}
              </Field>
              <datalist id="genre-suggestions">
                {COMMON_GENRES.map((g) => <option key={g} value={g} />)}
              </datalist>
              {/* Quick genre chips */}
              <div role="group" aria-label="Common genres" className="mt-2 flex flex-wrap gap-1.5">
                {COMMON_GENRES.slice(0, 8).map((g) => (
                  <button
                    type="button"
                    key={g}
                    aria-pressed={genre === g}
                    onClick={() => setGenre(g)}
                    className={`min-h-9 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                      genre === g
                        ? "bg-primary text-primary-foreground"
                        : "bg-gray-100 dark:bg-secondary/40 text-muted-foreground dark:hover:bg-primary/10 hover:text-primary-text"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            {/* Tags input */}
            <div className="min-w-0">
              <Field label="Tags" hint="Comma-separated">
                {(field) => (
                  <Input
                    {...field}
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder="e.g. deep, melodic, chill…"
                    className="h-11"
                  />
                )}
              </Field>
            </div>
          </div>

          {/* Advanced filters toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            aria-controls={advancedPanelId}
            // -ml-3 cancels the button's own px-3 so the label still lines up
            // with the fields above it.
            className="-ml-3 text-muted-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={`w-4 h-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
            />
            Advanced filters
          </Button>

          <div id={advancedPanelId} hidden={!showAdvanced}>
            <div className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-4 dark:border-border">
              <Field label="Min BPM">
                {(field) => (
                  <Input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    value={bpmMin}
                    onChange={(e) => setBpmMin(e.target.value)}
                    placeholder="e.g. 120"
                    min={1}
                    max={300}
                    className="h-11"
                  />
                )}
              </Field>
              <Field label="Max BPM">
                {(field) => (
                  <Input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    value={bpmMax}
                    onChange={(e) => setBpmMax(e.target.value)}
                    placeholder="e.g. 128"
                    min={1}
                    max={300}
                    className="h-11"
                  />
                )}
              </Field>
            </div>
          </div>

          {searchError && (
            <InlineAlert variant="error" onDismiss={() => setSearchError("")}>
              {searchError}
            </InlineAlert>
          )}

          <Button onClick={handleSearch} disabled={searching}>
            {searching ? (
              <>
                <LoadingSpinner size="sm" className="text-white" />
                Searching…
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                Search
              </>
            )}
          </Button>
        </Card>

        {/* Results */}
        {hasSearched && (
          <>
            {/* Focusable so a successful add has somewhere to land — see
                `dialogReturnFocusRef`. It sits directly above the success
                alert, so the outcome is the next thing read. */}
            <div ref={resultsRef} tabIndex={-1} className="mb-3 focus:outline-none">
              <SectionHeading>Results</SectionHeading>
            </div>

            {/* Add success banner */}
            {addSuccess && (
              <InlineAlert variant="success" className="mb-4" onDismiss={() => setAddSuccess("")}>
                {addSuccess}
              </InlineAlert>
            )}

            {results.length === 0 && !searching ? (
              <EmptyState
                icon={<Music className="w-12 h-12" />}
                title="No tracks found"
                description="Try a different genre, tag, or adjust your filters."
              />
            ) : (
              <>
                <SelectableList>
                  {results.map((track) => {
                    const isSelected = selectedTracks.has(track.id);
                    return (
                      <TrackRow
                        as="li"
                        key={track.id}
                        track={{
                          ...track,
                          subtitle: [track.user?.username, track.genre].filter(Boolean).join(" • "),
                        }}
                        isSelected={isSelected}
                        onToggle={() => toggleTrack(track.id)}
                        rightSlot={
                          track.duration ? (
                            <span className="text-xs text-muted-foreground">
                              {formatDuration(track.duration)}
                            </span>
                          ) : null
                        }
                        className={!isSelected ? "bg-white dark:bg-card" : undefined}
                      />
                    );
                  })}
                </SelectableList>

                {nextHref && (
                  <div className="mt-6 text-center">
                    <Button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      variant="outline"
                      className="mx-auto"
                    >
                      {loadingMore ? (
                        <>
                          <LoadingSpinner size="sm" />
                          Loading…
                        </>
                      ) : (
                        "Load more"
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* Add to Playlist — a real dialog: labelled, focus-trapped, Escape
            closes it, and focus returns to the banner button that opened it. */}
        <Dialog
          open={showAddPanel}
          onClose={() => setShowAddPanel(false)}
          title="Add to playlist"
          subtitle={`${selectedTracks.size} track${selectedTracks.size !== 1 ? "s" : ""} selected`}
          variant="sheet"
          size="sm"
          returnFocusRef={dialogReturnFocusRef}
          footer={
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => setShowAddPanel(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleAddToPlaylist}
                disabled={adding || (addMode === "new" ? !playlistName.trim() : !targetPlaylist)}
                className="flex-1"
              >
                {adding ? <><LoadingSpinner size="sm" className="text-white" /> Adding…</> : "Add tracks"}
              </Button>
            </div>
          }
        >
          {addError && (
            <InlineAlert variant="error" onDismiss={() => setAddError("")}>
              {addError}
            </InlineAlert>
          )}

          {/* Mode toggle */}
          <div>
            <span
              id={addModeLabelId}
              className="mb-2 block text-sm font-semibold text-foreground"
            >
              Add to
            </span>
            <div
              role="group"
              aria-labelledby={addModeLabelId}
              className="flex overflow-hidden rounded-lg border-2 border-gray-200 dark:border-border"
            >
              <button
                type="button"
                aria-pressed={addMode === "new"}
                onClick={() => setAddMode("new")}
                className={`min-h-11 flex-1 px-2 py-2 text-sm font-medium transition ${
                  addMode === "new"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-gray-50 dark:hover:bg-secondary/20"
                }`}
              >
                New playlist
              </button>
              <button
                type="button"
                aria-pressed={addMode === "existing"}
                onClick={() => { setAddMode("existing"); }}
                className={`min-h-11 flex-1 px-2 py-2 text-sm font-medium transition ${
                  addMode === "existing"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-gray-50 dark:hover:bg-secondary/20"
                }`}
              >
                Existing playlist
              </button>
            </div>
          </div>

          {addMode === "new" ? (
            <Field label="Playlist name">
              {(field) => (
                <Input
                  {...field}
                  type="text"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="Playlist name…"
                  className="h-11"
                />
              )}
            </Field>
          ) : loadingPlaylists ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground-subtle">
              <LoadingSpinner size="sm" /> Loading playlists…
            </div>
          ) : (
            <Select
              label="Playlist"
              value={targetPlaylist?.id ?? ""}
              onChange={(e) => {
                const id = Number(e.target.value);
                setTargetPlaylist(userPlaylists.find((p) => Number(p.id) === id) || null);
              }}
            >
              <option value="">Select a playlist…</option>
              {userPlaylists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.track_count} tracks)
                </option>
              ))}
            </Select>
          )}
        </Dialog>
      <SelectionBanner
        count={selectedTracks.size}
        entityName="track"
        actionLabel="Add to Playlist"
        onAction={handleOpenAddPanel}
        actionIcon={<Plus className="h-4 w-4" />}
      />
    </PageContainer>
  );
}
