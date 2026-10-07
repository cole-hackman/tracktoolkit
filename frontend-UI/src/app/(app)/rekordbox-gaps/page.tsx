"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Download, FileDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  useAnnounce,
} from "@/components/ui";
import { DownloadQueuePanel, DownloadQueueSheet, useDownloadQueue } from "@/components/downloads/DownloadQueue";
import { DownloadLinkAction, DownloadStatusLine, downloadTone } from "@/components/downloads/DownloadStatus";
import { useLikesQuery, usePlaylistDetailQuery, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { downloadCsv } from "@/lib/csv";
import { startSoundCloudDownload } from "@/lib/download";
import { type DownloadStatus, downloadStatus } from "@/lib/download-status";
import { type RekordboxCollection, RekordboxParseError, parseRekordboxCollection } from "@/lib/rekordbox-xml";
import { type MatchKind, type TrackMatch, indexCollection, matchTrack } from "@/lib/library-match";

interface Track {
  id: number;
  title: string;
  user: { username: string };
  artwork_url: string | null;
  duration: number;
  downloadable?: boolean | string;
  download_url?: string;
  purchase_url?: string;
  purchase_title?: string;
  access?: string;
  permalink_url: string;
}

const LIKES = "likes";
const SHOW_LABELS: Record<MatchKind, string> = {
  missing: "Missing from Rekordbox",
  "other-version": "Different version in Rekordbox",
  owned: "Already in Rekordbox",
};
const ROW_STEP = 200;

export default function RekordboxGapsPage() {
  const { user } = useAuth();
  const canUse = !!user?.canDownload;
  const announce = useAnnounce();
  const queue = useDownloadQueue(announce);
  const hasQueue = queue.hydrated && queue.state.items.length > 0;

  const [collection, setCollection] = useState<RekordboxCollection | null>(null);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [source, setSource] = useState<string>(LIKES);
  const [show, setShow] = useState<MatchKind>("missing");
  const [visible, setVisible] = useState(ROW_STEP);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const playlistsQuery = usePlaylistsQuery();
  const playlists = useMemo(
    () => asArray<{ id: number; title: string; track_count: number }>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );
  const isLikes = source === LIKES;
  const likesQuery = useLikesQuery({ enabled: canUse && isLikes && !!collection });
  const playlistQuery = usePlaylistDetailQuery(isLikes ? 0 : Number(source), { enabled: canUse && !isLikes && !!collection });
  const loadingTracks = !!collection && (isLikes ? likesQuery.isLoading : playlistQuery.isLoading);
  const tracks = useMemo(
    () => (isLikes ? asArray<Track>(likesQuery.data?.collection) : asArray<Track>(playlistQuery.data?.tracks)),
    [isLikes, likesQuery.data, playlistQuery.data],
  );
  const sourceTitle = isLikes ? "Liked Tracks" : playlists.find((p) => String(p.id) === source)?.title ?? "Playlist";

  const results = useMemo(() => {
    if (!collection) return [];
    const index = indexCollection(collection.tracks);
    return tracks.map((track) => ({ track, match: matchTrack(track, index), status: downloadStatus(track) }));
  }, [collection, tracks]);

  const counts = useMemo(() => {
    const c: Record<MatchKind, number> = { missing: 0, "other-version": 0, owned: 0 };
    for (const r of results) c[r.match.kind]++;
    return c;
  }, [results]);
  const shown = useMemo(() => results.filter((r) => r.match.kind === show), [results, show]);
  const missingDirect = useMemo(
    () => results.filter((r) => r.match.kind === "missing" && r.status.kind === "direct" && r.track.download_url),
    [results],
  );

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setReading(true);
    try {
      // Read and parsed here, in this tab. The file is never sent anywhere.
      const parsed = parseRekordboxCollection(await file.text());
      setCollection(parsed);
      setFileName(file.name);
      setShow("missing");
      setVisible(ROW_STEP);
      announce(`Read ${parsed.tracks.length.toLocaleString()} tracks from ${file.name}`);
    } catch (error) {
      setCollection(null);
      setParseError(error instanceof RekordboxParseError ? error.message : "That file could not be read.");
    } finally {
      setReading(false);
    }
  };

  const downloadOne = async (track: Track, status: DownloadStatus) => {
    setRowError(null);
    if (status.kind === "gate" && status.href) {
      window.open(status.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (status.kind !== "direct" || !track.download_url) return;
    setDownloadingId(track.id);
    const result = await startSoundCloudDownload(track.download_url);
    setDownloadingId(null);
    if (!result.ok) setRowError({ id: track.id, message: result.error });
  };

  const exportShoppingList = () => {
    const rows = results
      .filter((r) => r.match.kind !== "owned")
      .map((r) => [
        r.track.user?.username ?? "",
        r.track.title,
        r.match.kind === "missing" ? "missing" : "different version",
        r.status.label,
        r.status.href ?? (r.status.kind === "direct" ? r.track.permalink_url : ""),
        r.match.note ?? "",
      ]);
    downloadCsv(`rekordbox-gaps-${sourceTitle.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`, [
      ["Artist", "Title", "In Rekordbox", "Where to get it", "Link", "Note"],
      ...rows,
    ]);
  };

  if (!canUse) {
    return (
      <PageContainer maxWidth="default">
        <PageHeader title="Rekordbox gaps" description="Find what you like on SoundCloud but don't have in Rekordbox." />
        <EmptyState
          title="Not available on this account"
          description="This tool is limited to accounts on the download allowlist for now."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer maxWidth="default">
      <PageHeader title="Rekordbox gaps" description="Find what you like on SoundCloud but don't have in Rekordbox, and where to get it." />

      <div className={hasQueue ? "pb-24 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6 lg:pb-0" : undefined}>
        <div className="min-w-0 space-y-6">
          <Card className="space-y-4 p-4 sm:p-6">
            <Field
              label="Rekordbox collection (XML)"
              hint="In Rekordbox: File → Export Collection in xml format. The file is read in this browser tab and never uploaded."
              error={parseError ?? undefined}
            >
              {(field) => (
                <div className="space-y-2">
                  {/* The native control, styled: one tab stop, labelled by Field, works with every assistive tech. */}
                  <input
                    {...field}
                    type="file"
                    accept=".xml,text/xml,application/xml"
                    disabled={reading}
                    onChange={(e) => readFile(e.target.files?.[0])}
                    className="block w-full min-w-0 text-sm text-muted-foreground file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-semibold file:text-foreground hover:file:bg-accent hover:file:text-accent-foreground"
                  />
                  {reading && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoadingSpinner className="h-4 w-4 text-current" /> Reading the collection…
                    </p>
                  )}
                  {collection && !reading && (
                    <p className="min-w-0 text-sm text-muted-foreground">
                      {fileName}: {collection.tracks.length.toLocaleString()} tracks
                      {collection.product ? ` · ${collection.product}` : ""}
                    </p>
                  )}
                </div>
              )}
            </Field>

            <Select label="SoundCloud source" value={source} onChange={(e) => { setSource(e.target.value); setVisible(ROW_STEP); }}>
              <option value={LIKES}>Liked Tracks</option>
              {playlists.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.title}
                </option>
              ))}
            </Select>
          </Card>

          {!collection ? (
            <EmptyState
              icon={<FileDown className="h-12 w-12" />}
              title="Start with your Rekordbox export"
              description="Choose the XML file above; the comparison runs as soon as it's read."
            />
          ) : loadingTracks ? (
            <div className="space-y-3" aria-busy="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : (
            <section aria-labelledby="gaps-results" className="space-y-4">
              <h2 id="gaps-results" className="text-xl font-bold text-foreground">
                {sourceTitle}
              </h2>
              <p className="text-sm text-muted-foreground" role="status">
                Of {results.length.toLocaleString()} tracks: {counts.owned.toLocaleString()} already in Rekordbox ·{" "}
                {counts["other-version"].toLocaleString()} in a different version · {counts.missing.toLocaleString()} missing
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="sm:w-72">
                  <Select label="Show" value={show} onChange={(e) => { setShow(e.target.value as MatchKind); setVisible(ROW_STEP); }}>
                    {(Object.keys(SHOW_LABELS) as MatchKind[]).map((k) => (
                      <option key={k} value={k}>
                        {SHOW_LABELS[k]} ({counts[k].toLocaleString()})
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-wrap gap-2">
                  {missingDirect.length > 0 && (
                    <Button
                      onClick={() =>
                        queue.begin(
                          `${sourceTitle} (missing from Rekordbox)`,
                          missingDirect.map((r) => ({
                            trackId: r.track.id,
                            title: r.track.title,
                            artist: r.track.user?.username ?? "",
                            downloadUrl: r.track.download_url!,
                          })),
                        )
                      }
                      disabled={queue.state.running}
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                      Download missing ({missingDirect.length})
                    </Button>
                  )}
                  <Button variant="secondary" onClick={exportShoppingList} disabled={counts.missing + counts["other-version"] === 0}>
                    <FileDown className="h-4 w-4" aria-hidden="true" />
                    Export shopping list (CSV)
                  </Button>
                </div>
              </div>

              <Card className="p-4 sm:p-6">
                {shown.length === 0 ? (
                  <EmptyState title={`Nothing ${SHOW_LABELS[show].toLowerCase()}`} description="Change “Show” to see the other groups." />
                ) : (
                  <ul className="space-y-2" aria-label={SHOW_LABELS[show]}>
                    {shown.slice(0, visible).map(({ track, match, status }) => (
                      <li key={track.id}>
                        <GapRow
                          track={track}
                          match={match}
                          status={status}
                          downloading={downloadingId === track.id}
                          onDownload={() => downloadOne(track, status)}
                        />
                        {rowError?.id === track.id && (
                          <InlineAlert variant="error" className="mt-1" onDismiss={() => setRowError(null)}>
                            {`${track.title}: ${rowError.message}`}
                          </InlineAlert>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {shown.length > visible && (
                  <div className="pt-3 text-center">
                    <Button variant="secondary" onClick={() => setVisible((n) => n + ROW_STEP)}>
                      Show {Math.min(ROW_STEP, shown.length - visible)} more of {shown.length - visible}
                    </Button>
                  </div>
                )}
              </Card>
              <p className="text-sm text-muted-foreground">
                Matching is by title, artist and version. Remixes count as different versions; extended mixes and
                radio edits count as the same record. Check a match by hand before buying twice.{" "}
                <Link href="/downloads/" className="font-medium text-primary-text underline underline-offset-2">
                  Back to Downloads
                </Link>
              </p>
            </section>
          )}
        </div>

        {hasQueue && (
          <aside className="hidden lg:block">
            <div className="sticky top-6 rounded-xl border border-border bg-card p-4">
              <DownloadQueuePanel state={queue.state} summary={queue.summary} onPause={queue.pause} onResume={queue.resume} onClear={queue.clear} />
            </div>
          </aside>
        )}
      </div>
      {hasQueue && (
        <DownloadQueueSheet state={queue.state} summary={queue.summary} onPause={queue.pause} onResume={queue.resume} onClear={queue.clear} />
      )}
    </PageContainer>
  );
}

function GapRow({
  track,
  match,
  status,
  downloading,
  onDownload,
}: {
  track: Track;
  match: TrackMatch;
  status: DownloadStatus;
  downloading: boolean;
  onDownload: () => void;
}) {
  const canClick = status.kind === "direct" || status.kind === "gate";
  return (
    <div className="flex items-center gap-4 rounded-xl bg-secondary/20 p-3">
      <img
        src={track.artwork_url || "/brand/icon-192.png"}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        decoding="async"
        className="h-10 w-10 shrink-0 self-start rounded-lg object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-foreground">{track.title}</div>
        <div className="truncate text-sm text-muted-foreground">{track.user?.username}</div>
        {match.kind === "other-version" && match.note && <div className="mt-1 text-xs text-foreground">{match.note}</div>}
        {match.kind === "owned" && match.rekordbox && (
          <div className="mt-1 text-xs text-muted-foreground">
            In Rekordbox: {match.rekordbox.artist} - {match.rekordbox.title}
            {match.rekordbox.bpm ? ` · ${match.rekordbox.bpm} BPM` : ""}
            {match.rekordbox.key ? ` · ${match.rekordbox.key}` : ""}
          </div>
        )}
        {match.kind !== "owned" && <DownloadStatusLine track={track} status={status} />}
      </div>
      {match.kind !== "owned" &&
        (canClick ? (
          <IconButton label={status.actionLabel!} disabled={downloading} onClick={onDownload} className={downloadTone(status)}>
            {downloading ? <LoadingSpinner className="h-5 w-5 text-current" /> : <Download className="h-5 w-5" />}
          </IconButton>
        ) : (
          <DownloadLinkAction status={status} />
        ))}
    </div>
  );
}
