"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  ActionBar,
  Button,
  Field,
  InlineAlert,
  Input,
  PageContainer,
  PageHeader,
  Panel,
  ProgressBar,
  ResultPanel,
  SectionHeading,
  Select,
  useAnnounce,
} from "@/components/ui";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import { invalidatePlaylistCaches } from "@/lib/queries";
import {
  entryKey,
  parseSetlist,
  rankCandidates,
  searchQuery,
  titleFromSourceUrl,
  type RankedCandidate,
  type SetlistCandidate,
  type SetlistEntry,
} from "@/lib/setlist";

/** Lines per /api/setlists/match call — the server's cap (SETLIST_MATCH_MAX_ENTRIES). */
const MATCH_CHUNK = 25;
/** Distinct searches per set: six match calls of the 60/hour library budget. */
const MAX_SEARCHES = 150;
/** Rough point past which SoundCloud's description cap trims the list. */
const DESCRIPTION_SOFT_LIMIT = 3800;
const SKIP = "skip";

interface LineMatch {
  ranked: RankedCandidate[];
  /** Track id the user will add, or null for "don't add". */
  chosen: number | null;
  error?: string;
}

interface MatchResponse {
  results: Array<{ position: number; candidates: SetlistCandidate[]; error?: string }>;
}

interface CreateResponse {
  playlist: { id: number; title: string; permalink_url: string | null };
  added: number;
  missing: Array<{ id: number; label: string }>;
  duplicates: Array<{ id: number; label: string }>;
  descriptionOmitted: number;
}

interface PartialPlaylist {
  id: number;
  title: string;
  permalink_url?: string | null;
  tracksWritten: number;
}

type NotAddedReason = "unidentified" | "not-found" | "skipped" | "duplicate" | "unavailable";

const REASON_TEXT: Record<NotAddedReason, string> = {
  unidentified: "Unidentified on the tracklist (ID)",
  "not-found": "No match found on SoundCloud",
  skipped: "Left out at review",
  duplicate: "Already in the playlist earlier in the set",
  unavailable: "No longer playable on SoundCloud",
};

const FIT_TEXT = { confident: "match", possible: "other version?", weak: "unsure" } as const;

function candidateText(c: RankedCandidate): string {
  const uploader = c.track.user?.username ? ` — ${c.track.user.username}` : "";
  const preview = c.track.access === "preview" ? " (30-second preview)" : "";
  return `${c.track.title}${uploader}${preview} · ${FIT_TEXT[c.fit]}`;
}

export default function SetToPlaylistPage() {
  const announce = useAnnounce();
  const queryClient = useQueryClient();

  const [sourceUrl, setSourceUrl] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [text, setText] = useState("");

  const [matches, setMatches] = useState<Map<number, LineMatch> | null>(null);
  const [matching, setMatching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [creating, setCreating] = useState(false);
  // A run that did not finish (matching stopped, the playlist was not
  // created) reports in the result slot; `runCount` keys the panel per run.
  const [error, setError] = useState<{ title: string; text: string; announcement?: string } | null>(null);
  // The tracklist field's own message (nothing to look up, too many tracks).
  const [textError, setTextError] = useState<string | null>(null);
  const [partial, setPartial] = useState<PartialPlaylist | null>(null);
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const runCount = useRef(0);

  const parsed = useMemo(() => parseSetlist(text), [text]);
  const searchable = parsed.entries.filter((e) => e.kind !== "unidentified");
  const uniqueSearches = useMemo(() => {
    const byKey = new Map<string, SetlistEntry>();
    for (const e of parsed.entries) if (e.kind !== "unidentified" && !byKey.has(entryKey(e))) byKey.set(entryKey(e), e);
    return [...byKey.values()];
  }, [parsed]);

  const sourceUrlError =
    sourceUrl.trim() && !titleFromSourceUrl(sourceUrl) ? "Paste a 1001tracklists.com tracklist link, or leave this empty." : undefined;

  const onSourceUrl = (value: string) => {
    setSourceUrl(value);
    const fromSlug = titleFromSourceUrl(value);
    if (fromSlug && !titleTouched) setTitle(fromSlug);
  };

  const resetResults = () => {
    setMatches(null);
    setCreated(null);
    setPartial(null);
    setError(null);
    setTextError(null);
  };

  async function runMatch() {
    resetResults();
    runCount.current += 1;
    if (uniqueSearches.length === 0) {
      setTextError("No tracks found in that text. Paste the tracklist with one “Artist - Title” per line.");
      return;
    }
    if (uniqueSearches.length > MAX_SEARCHES) {
      setTextError(`That is ${uniqueSearches.length} different tracks. Paste at most ${MAX_SEARCHES} at a time.`);
      return;
    }

    setMatching(true);
    setProgress({ done: 0, total: uniqueSearches.length });
    announce(`Matching ${uniqueSearches.length} tracks on SoundCloud…`);

    const byKey = new Map<string, { candidates: SetlistCandidate[]; error?: string }>();
    let failure: string | null = null;
    for (let i = 0; i < uniqueSearches.length; i += MATCH_CHUNK) {
      const chunk = uniqueSearches.slice(i, i + MATCH_CHUNK);
      const entries = chunk.map((e) =>
        e.kind === "url" ? { position: e.position, url: e.label } : { position: e.position, query: searchQuery(e) },
      );
      try {
        const res = await apiFetch("/api/setlists/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          failure = errorMessageFromBody(data, "Matching failed. Try again in a minute.");
          break;
        }
        const byPosition = new Map((data as MatchResponse).results.map((r) => [r.position, r]));
        for (const e of chunk) {
          const r = byPosition.get(e.position);
          byKey.set(entryKey(e), { candidates: r?.candidates ?? [], error: r?.error });
        }
      } catch {
        failure = "Could not reach Track Toolkit. Check your connection and try again.";
        break;
      }
      setProgress({ done: Math.min(i + MATCH_CHUNK, uniqueSearches.length), total: uniqueSearches.length });
    }

    const next = new Map<number, LineMatch>();
    let reached = 0;
    for (const e of parsed.entries) {
      if (e.kind === "unidentified") continue;
      const found = byKey.get(entryKey(e));
      if (!found) {
        next.set(e.position, { ranked: [], chosen: null, error: "Not looked up — matching stopped before this line" });
        continue;
      }
      reached++;
      const { ranked, pick } = rankCandidates(e, found.candidates);
      next.set(e.position, { ranked, chosen: pick ? pick.track.id : null, error: found.error });
    }
    setMatches(next);
    setMatching(false);

    const picked = [...next.values()].filter((m) => m.chosen != null).length;
    if (failure) {
      setError({
        title: "Matching stopped",
        text: `${failure} ${reached} of ${searchable.length} lines were matched before it stopped.`,
        announcement: `Matching stopped: ${failure}`,
      });
    } else {
      announce(`Matched ${picked} of ${searchable.length} tracks. Review the list before creating the playlist.`);
    }
  }

  const choose = (position: number, value: string) => {
    setMatches((prev) => {
      if (!prev) return prev;
      const next = new Map(prev);
      const line = next.get(position);
      if (line) next.set(position, { ...line, chosen: value === SKIP ? null : Number(value) });
      return next;
    });
  };

  /** The rows in set order with what will happen to each. */
  const review = useMemo(() => {
    if (!matches) return null;
    const firstAt = new Map<number, number>();
    return parsed.entries.map((entry) => {
      const line = matches.get(entry.position);
      let reason: NotAddedReason | null = null;
      let duplicateOf: number | null = null;
      if (entry.kind === "unidentified") reason = "unidentified";
      else if (!line || line.ranked.length === 0) reason = "not-found";
      else if (line.chosen == null) reason = "skipped";
      else if (firstAt.has(line.chosen)) {
        reason = "duplicate";
        duplicateOf = firstAt.get(line.chosen) ?? null;
      } else firstAt.set(line.chosen, entry.position);
      const chosen = line?.ranked.find((c) => c.track.id === line.chosen) ?? null;
      return { entry, line, chosen, reason, duplicateOf };
    });
  }, [matches, parsed]);

  const toAdd = review?.filter((r) => r.reason === null && r.chosen) ?? [];
  const descriptionLength = toAdd.reduce((n, r) => n + (r.chosen?.label.length ?? 0) + 1, 0);
  const counts = useMemo(() => {
    const c: Record<NotAddedReason, number> = { unidentified: 0, "not-found": 0, skipped: 0, duplicate: 0, unavailable: 0 };
    for (const r of review ?? []) if (r.reason) c[r.reason]++;
    return c;
  }, [review]);

  async function createPlaylist() {
    if (toAdd.length === 0) return;
    setCreating(true);
    setError(null);
    setPartial(null);
    runCount.current += 1;
    announce(`Creating “${title.trim()}” with ${toAdd.length} tracks…`);
    try {
      const res = await apiFetch("/api/setlists/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          sourceUrl: sourceUrl.trim() || null,
          tracks: toAdd.map((r) => ({ id: r.chosen!.track.id, label: r.chosen!.label })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.partialPlaylist) setPartial(data.partialPlaylist as PartialPlaylist);
        const message = errorMessageFromBody(data, "Creating the playlist failed.");
        setError({ title: data?.partialPlaylist ? "Playlist partly created" : "Playlist not created", text: message });
        return;
      }
      const result = data as CreateResponse;
      setCreated(result);
    } catch {
      setError({ title: "Playlist not created", text: "Could not reach Track Toolkit. Check your connection and try again." });
    } finally {
      setCreating(false);
      void invalidatePlaylistCaches(queryClient);
    }
  }

  /** Everything that did not make it in, in set order, after the create. */
  const notAdded = useMemo(() => {
    if (!review) return [];
    const unavailable = new Set((created?.missing ?? []).map((m) => m.id));
    return review
      .map((r) => {
        const reason: NotAddedReason | null =
          r.reason ?? (created && r.chosen && unavailable.has(r.chosen.track.id) ? "unavailable" : null);
        return reason ? { position: r.entry.position, label: r.entry.label, reason } : null;
      })
      .filter((x): x is { position: number; label: string; reason: NotAddedReason } => x !== null);
  }, [review, created]);

  const busy = matching || creating;
  const canCreate = !busy && !created && toAdd.length > 0 && title.trim().length > 0 && !sourceUrlError;

  return (
    <PageContainer kind="form">
      <PageHeader
        title="Set → Playlist"
        description="Paste a DJ set's tracklist and get it as a SoundCloud playlist, in set order, with the tracklist in the description."
      />

      <div className="space-y-6">
      {created ? (
        <ResultPanel
          key={runCount.current}
          status={notAdded.length > 0 ? "partial" : "success"}
          title={`Created “${created.playlist.title}”`}
          description={`${created.added} track${created.added === 1 ? "" : "s"} added, in set order, with the tracklist in the description.`}
          announcement={`Created “${created.playlist.title}” with ${created.added} tracks.`}
          actions={
            created.playlist.permalink_url ? (
              <a
                href={created.playlist.permalink_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 font-medium text-primary-text underline"
              >
                Open on SoundCloud <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            ) : undefined
          }
        >
          {created.descriptionOmitted > 0 && (
            <p className="text-sm text-muted-foreground">
              The description lists the first {created.added - created.descriptionOmitted} and notes that{" "}
              {created.descriptionOmitted} more follow — SoundCloud limits description length.
            </p>
          )}
          {notAdded.length > 0 && (
            <section>
              <SectionHeading as="h3">Not added ({notAdded.length})</SectionHeading>
              <ol className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
                {notAdded.map((row) => (
                  <li key={row.position} className="min-w-0 px-4 py-2 text-sm">
                    <span className="mr-2 font-mono text-muted-foreground-subtle">{row.position}.</span>
                    <span className="break-words text-foreground">{row.label}</span>
                    <span className="block text-xs text-muted-foreground">{REASON_TEXT[row.reason]}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </ResultPanel>
      ) : error ? (
        <ResultPanel
          key={runCount.current}
          status={partial ? "partial" : "error"}
          title={error.title}
          description={error.text}
          announcement={error.announcement}
          onDismiss={() => {
            setError(null);
            setPartial(null);
          }}
          actions={
            partial?.permalink_url ? (
              <a
                href={partial.permalink_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center font-medium text-primary-text underline"
              >
                Open “{partial.title}”
              </a>
            ) : undefined
          }
        />
      ) : null}

      <Panel>
        <div className="space-y-4">
          <Field
            label="Tracklist"
            required
            error={textError ?? undefined}
            hint="On the 1001Tracklists page, select the whole tracklist and copy it, then paste it here. One “Artist - Title” per line works too, and so do SoundCloud track links."
          >
            {(field) => (
              <textarea
                {...field}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  resetResults();
                }}
                rows={10}
                placeholder={"01\nCASSIMM - Love Desire\n02\nID - ID\n…"}
                className="w-full resize-y rounded-xl border border-input bg-surface px-4 py-3 font-mono text-base text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 sm:text-sm"
              />
            )}
          </Field>

          {text.trim() && (
            <p className="text-sm text-muted-foreground">
              Found {parsed.entries.length} lines: {searchable.length} to look up
              {parsed.entries.length - searchable.length > 0 && `, ${parsed.entries.length - searchable.length} unidentified (ID)`}
              {parsed.suggestions.length > 0 && `, and ${parsed.suggestions.length} community guess${parsed.suggestions.length === 1 ? "" : "es"} under an ID, which are left out`}
              .
            </p>
          )}

          <Field
            label="1001Tracklists link (optional)"
            hint="Used for the playlist name and as the source link in the description. Track Toolkit never opens it."
            error={sourceUrlError}
          >
            {(field) => (
              <Input
                {...field}
                type="url"
                inputMode="url"
                value={sourceUrl}
                onChange={(e) => onSourceUrl(e.target.value)}
                placeholder="https://www.1001tracklists.com/tracklist/…"
              />
            )}
          </Field>

          <Field label="Playlist name" required hint="Up to 100 characters.">
            {(field) => (
              <Input
                {...field}
                value={title}
                maxLength={100}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
              />
            )}
          </Field>

          <ActionBar>
            <Button onClick={runMatch} disabled={busy || searchable.length === 0}>
              {matching ? "Matching…" : matches ? "Match again" : "Find on SoundCloud"}
            </Button>
            <span className="text-sm text-muted-foreground-subtle">Nothing is created until you review the matches.</span>
          </ActionBar>

          {matching && (
            <ProgressBar
              value={progress.done}
              max={progress.total}
              label="Matching tracks"
              detail={`${progress.done} of ${progress.total}`}
            />
          )}
        </div>
      </Panel>

      {review && !created && (
        <Panel title="Review the matches">
          <p className="text-sm text-muted-foreground">
            {toAdd.length} will be added
            {counts["not-found"] > 0 && ` · ${counts["not-found"]} not found`}
            {counts.skipped > 0 && ` · ${counts.skipped} need a pick or are left out`}
            {counts.unidentified > 0 && ` · ${counts.unidentified} unidentified`}
            {counts.duplicate > 0 && ` · ${counts.duplicate} repeats`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground-subtle">
            Only exact matches are picked for you. Check the rest: another version, a 30-second preview or a different
            upload is left for you to choose.
          </p>

          <ol className="mt-4 divide-y divide-border rounded-xl border border-border bg-card">
            {review.map(({ entry, line, reason, duplicateOf }) => (
              <li key={entry.position} className="min-w-0 px-4 py-3">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 sm:w-1/2">
                    <p className="break-words text-sm text-foreground">
                      <span className="mr-2 font-mono text-muted-foreground-subtle">{entry.position}.</span>
                      {entry.withPrevious && <span className="mr-1 text-muted-foreground-subtle">w/</span>}
                      {entry.label}
                    </p>
                    {reason === "duplicate" && duplicateOf != null && (
                      <p className="text-xs text-muted-foreground">Same track as #{duplicateOf} — added once, there.</p>
                    )}
                    {line?.error && <p className="text-xs text-warning-text">{line.error}</p>}
                  </div>
                  <div className="min-w-0 sm:w-1/2">
                    {entry.kind === "unidentified" ? (
                      <p className="text-sm text-muted-foreground">Unidentified — not searched</p>
                    ) : !line || line.ranked.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No match found</p>
                    ) : (
                      <Select
                        aria-label={`Match for line ${entry.position}: ${entry.label}`}
                        value={line.chosen == null ? SKIP : String(line.chosen)}
                        onChange={(e) => choose(entry.position, e.target.value)}
                        disabled={creating}
                      >
                        <option value={SKIP}>Don't add</option>
                        {line.ranked.map((c) => (
                          <option key={c.track.id} value={String(c.track.id)}>
                            {candidateText(c)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          {descriptionLength > DESCRIPTION_SOFT_LIMIT && (
            <InlineAlert variant="warning" className="mt-4">
              This list is longer than SoundCloud allows in a description. The playlist will have every track; the
              description will list as many as fit and say how many more follow.
            </InlineAlert>
          )}

          <ActionBar>
            <Button onClick={createPlaylist} disabled={!canCreate}>
              {creating ? "Creating…" : `Create playlist with ${toAdd.length} track${toAdd.length === 1 ? "" : "s"}`}
            </Button>
            {!title.trim() && <span className="text-sm text-warning-text">Give the playlist a name first.</span>}
          </ActionBar>
        </Panel>
      )}

      </div>
    </PageContainer>
  );
}
