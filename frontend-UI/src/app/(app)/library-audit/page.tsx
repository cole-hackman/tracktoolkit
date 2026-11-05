"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Download, ListChecks, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ProgressBar,
  ResultPanel,
  Skeleton,
} from "@/components/ui";

interface AuditPlaylist {
  id: number;
  title: string;
  trackCount: number;
  summary: {
    totalTracks: number;
    duplicateTracks: number;
    unavailableTracks: number;
    directDownloads: number;
    purchaseLinks: number;
    nearCap: boolean;
  };
}

interface AuditPage {
  limit: number;
  offset: number;
  returned: number;
  total: number;
  hasMore: boolean;
  from: number;
  to: number;
  /** The playlist list came from cache and is being refreshed behind this response. */
  stale: boolean;
  /** The playlist crawl stopped early, so the library is bigger than `total`. */
  truncated: boolean;
}

interface AuditFailure {
  id: number;
  title: string | null;
}

interface AuditResult {
  page?: AuditPage;
  failed?: AuditFailure[];
  summary: {
    playlists: number;
    tracks: number;
    duplicates: number;
    unavailable: number;
    directDownloads: number;
    purchaseLinks: number;
    nearCap: number;
  };
  playlists: AuditPlaylist[];
}

const PAGE_SIZE = 20;
/** Server rejects offsets past this, so the pager must stop there too. */
const MAX_OFFSET = 10000;

export default function LibraryAuditPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [offset, setOffset] = useState(0);
  // The offset a run is currently fetching, so the progress bar can say which
  // page of the walk is in flight rather than which one finished last.
  const [pendingOffset, setPendingOffset] = useState<number | null>(null);
  // The outcome of the latest run. `key` is the run number, so each run mounts
  // a fresh panel (which takes focus and speaks its summary).
  const [outcome, setOutcome] = useState<{
    key: number;
    status: "success" | "partial" | "empty" | "error";
    title: string;
    text: string;
  } | null>(null);
  const runCount = useRef(0);

  // A page walk has real progress — pages done out of pages there are — but
  // only once a first run has told us how many playlists there are. Before
  // that a run is one opaque request and says so instead of inventing a bar.
  const totalPages = result?.page ? Math.max(1, Math.ceil(result.page.total / PAGE_SIZE)) : null;
  const pageInFlight = pendingOffset === null ? 0 : Math.floor(pendingOffset / PAGE_SIZE) + 1;

  // Each run audits one page of playlists. SoundCloud returns them
  // oldest-first, so walking the offset is how a library larger than one page
  // gets fully covered.
  const runAudit = async (nextOffset = 0) => {
    setLoading(true);
    setPendingOffset(nextOffset);
    setOutcome(null);
    const runKey = ++runCount.current;
    try {
      const response = await apiFetch(`/api/library/audit?limit=${PAGE_SIZE}&offset=${nextOffset}`);
      const data = await response.json();
      if (!response.ok) {
        setOutcome({ key: runKey, status: "error", title: "Audit failed", text: data.error || "Could not run the audit." });
        return;
      }
      setResult(data);
      setOffset(nextOffset);
      const range = data.page ? `${data.page.from}–${data.page.to}` : "";
      const summary =
        data.summary.playlists === 0
          ? "No playlists in this range."
          : `Audited playlist${data.summary.playlists === 1 ? "" : "s"} ${range}. ${data.summary.duplicates} duplicate${data.summary.duplicates === 1 ? "" : "s"}, ${data.summary.unavailable} unavailable.`;
      setOutcome(
        data.summary.playlists === 0
          ? { key: runKey, status: "empty", title: "Nothing to audit", text: summary }
          : {
              key: runKey,
              status: data.failed && data.failed.length > 0 ? "partial" : "success",
              title: "Audit complete",
              text: summary,
            },
      );
    } catch (error) {
      console.error("Library audit failed:", error);
      setOutcome({ key: runKey, status: "error", title: "Audit failed", text: "Could not run the audit. Try again." });
    } finally {
      setLoading(false);
      setPendingOffset(null);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const rows = [
      ["playlist_id", "title", "tracks", "duplicates", "unavailable", "direct_downloads", "purchase_links", "near_cap"],
      ...result.playlists.map((playlist) => [
        playlist.id,
        playlist.title,
        playlist.summary.totalTracks,
        playlist.summary.duplicateTracks,
        playlist.summary.unavailableTracks,
        playlist.summary.directDownloads,
        playlist.summary.purchaseLinks,
        playlist.summary.nearCap ? "yes" : "no",
      ]),
    ];
    const suffix = result.page ? `-${result.page.from}-${result.page.to}` : "";
    downloadCsv(`library-audit${suffix}.csv`, rows);
  };

  return (
    <PageContainer kind="list">
      <PageHeader
        title="Library Audit"
        description="Scan playlists for duplicates, unavailable tracks, download links, and playlists near SoundCloud’s 500-track cap."
      />

      <div className="space-y-6">
        {outcome && (
          <ResultPanel
            key={outcome.key}
            status={outcome.status}
            title={outcome.title}
            description={outcome.text}
            onDismiss={() => setOutcome(null)}
          />
        )}

        <Panel>
          <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => runAudit(0)} disabled={loading}>
            {loading ? (
              <LoadingSpinner size="sm" className="text-white" />
            ) : (
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
            )}
            {result ? "Restart from the top" : "Run playlist audit"}
          </Button>
          {result && (
            <Button nowrap variant="outline" onClick={exportCsv}>
              <Download aria-hidden="true" className="h-4 w-4" />
              Export CSV
            </Button>
          )}
          <p className="text-sm text-muted-foreground">
            {PAGE_SIZE} playlists per run, to stay friendly to SoundCloud&apos;s rate limits. Use
            Next to audit the following {PAGE_SIZE}.
          </p>
          </div>
        </Panel>

        {loading ? (
          <div className="space-y-6">
            {totalPages !== null ? (
              <ProgressBar
                label="Checking playlists"
                value={Math.min(pageInFlight, totalPages)}
                max={totalPages}
                detail={`${PAGE_SIZE} playlists per page`}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Checking playlists…
              </p>
            )}
            <div aria-hidden="true" className="grid gap-3 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="p-4">
                  <Skeleton className="h-8 w-16 mb-2" />
                  <Skeleton className="h-4 w-24" />
                </Card>
              ))}
            </div>
            <Card aria-hidden="true" className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            </Card>
          </div>
        ) : !result ? (
          <Panel>
            <EmptyState
              icon={<ListChecks className="h-12 w-12" />}
              title="No audit yet"
              description="Run an audit to see which playlists need cleanup."
            />
          </Panel>
        ) : (
          <div className="space-y-6">
            {result.page?.stale && (
              <InlineAlert variant="info">
                This list may be up to 15 minutes old — it is refreshing in the background.
              </InlineAlert>
            )}
            {result.page?.truncated && (
              <InlineAlert variant="warning">
                Not all playlists were indexed, so the range below may not cover your whole
                library.
              </InlineAlert>
            )}
            {result.failed && result.failed.length > 0 && (
              <InlineAlert variant="warning">
                {result.failed.length} playlist{result.failed.length === 1 ? "" : "s"} could not be
                read — these results are incomplete.
              </InlineAlert>
            )}

            <div className="grid gap-3 md:grid-cols-4">
              <Metric label="Playlists" value={result.summary.playlists} />
              <Metric label="Tracks scanned" value={result.summary.tracks} />
              <Metric label="Duplicates" value={result.summary.duplicates} tone={result.summary.duplicates > 0 ? "warn" : "ok"} />
              <Metric label="Unavailable" value={result.summary.unavailable} tone={result.summary.unavailable > 0 ? "warn" : "ok"} />
            </div>

            <Panel title="Playlist findings">
              <div className="-mb-3 divide-y divide-border">
                {result.playlists.map((playlist) => {
                  const hasIssues =
                    playlist.summary.duplicateTracks > 0 ||
                    playlist.summary.unavailableTracks > 0 ||
                    playlist.summary.nearCap;
                  return (
                    <div key={playlist.id} className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="font-semibold text-foreground">{playlist.title}</div>
                        <div className="text-sm text-muted-foreground">
                          {playlist.summary.totalTracks} tracks • {playlist.summary.directDownloads} direct downloads • {playlist.summary.purchaseLinks} purchase links
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Finding label={`${playlist.summary.duplicateTracks} duplicates`} active={playlist.summary.duplicateTracks > 0} />
                        <Finding label={`${playlist.summary.unavailableTracks} unavailable`} active={playlist.summary.unavailableTracks > 0} />
                        <Finding label={playlist.summary.nearCap ? "near cap" : "under cap"} active={playlist.summary.nearCap} />
                        {/* The verdict was a bare coloured icon — the one place on
                            this page where a triangle and a tick were the whole
                            difference between "fix this" and "fine". */}
                        {hasIssues ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-text">
                            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                            Issues found
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-success-text">
                            <CheckCircle aria-hidden="true" className="h-4 w-4" />
                            Healthy
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>

            {result.page && (
              <Panel className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {result.page.from === 0
                    ? "No playlists in this range"
                    : `Showing playlists ${result.page.from}–${result.page.to}`}
                  {result.page.hasMore ? " — more to audit" : " — end of your library"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button nowrap
                    variant="outline"
                    onClick={() => runAudit(Math.max(0, offset - PAGE_SIZE))}
                    disabled={loading || offset === 0}
                  >
                    <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                    Previous {PAGE_SIZE}
                  </Button>
                  <Button nowrap
                    variant="outline"
                    onClick={() => runAudit(offset + PAGE_SIZE)}
                    disabled={loading || !result.page.hasMore || offset + PAGE_SIZE > MAX_OFFSET}
                  >
                    Next {PAGE_SIZE}
                    <ChevronRight aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              </Panel>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <Card className="p-4">
      <div className={`text-2xl font-bold ${tone === "warn" ? "text-warning-text" : tone === "ok" ? "text-success-text" : "text-foreground"}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </Card>
  );
}

function Finding({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={`rounded-md border px-2 py-1 ${active ? "border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-900/20 dark:text-yellow-300" : "border-border bg-secondary/20 text-muted-foreground"}`}>
      {label}
    </span>
  );
}
