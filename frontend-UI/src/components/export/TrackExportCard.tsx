"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Download, Loader2 } from "lucide-react";
import {
  Button,
  ActionBar,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  Panel,
  Select,
  useAnnounce,
} from "@/components/ui";
import {
  buildDatedFilename,
  buildExportContent,
  downloadFile,
  type ExportTrack,
  type TrackExportFormat,
  TRACK_FORMAT_LABELS,
} from "@/lib/export";
import { ExportSection } from "./ExportSection";

const PREVIEW_LINE_COUNT = 10;
const PREVIEW_LABEL = `Preview, first ${PREVIEW_LINE_COUNT} lines`;
const PREVIEW_BOX_CLASS =
  "mt-3 max-h-48 overflow-y-auto rounded-xl border border-border bg-muted/30 p-3 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background";
// A little slack over PREVIEW_LINE_COUNT so blank/filtered lines still
// leave enough real lines to fill the preview — but nowhere near the full
// (possibly tens-of-thousands-long) library.
const PREVIEW_TRACK_COUNT = 20;

type Phase = "idle" | "loading" | "ready" | "empty" | "error";

interface TrackExportCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  description: string;
  fetchLabel: string;
  filenamePrefix: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyLinkHref?: string;
  emptyLinkLabel?: string;
  loadTracks: () => Promise<ExportTrack[]>;
  extraControls?: React.ReactNode;
  fetchDisabled?: boolean;
  /** When true, omit section header (use with PageHeader on parent page). */
  embedded?: boolean;
}

export function TrackExportCard({
  icon,
  title,
  subtitle,
  description,
  fetchLabel,
  filenamePrefix,
  emptyTitle,
  emptyDescription,
  emptyLinkHref,
  emptyLinkLabel,
  loadTracks,
  extraControls,
  fetchDisabled = false,
  embedded = false,
}: TrackExportCardProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [tracks, setTracks] = useState<ExportTrack[]>([]);
  const [format, setFormat] = useState<TrackExportFormat>("title-artist");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const announce = useAnnounce();

  const fetchAndPrepare = async () => {
    setPhase("loading");
    setErrorMessage(null);
    setTracks([]);

    try {
      const loaded = await loadTracks();
      if (loaded.length === 0) {
        setPhase("empty");
        announce(emptyTitle);
        return;
      }
      setTracks(loaded);
      setPhase("ready");
      announce(`${loaded.length.toLocaleString()} track${loaded.length === 1 ? "" : "s"} ready to download.`);
    } catch (err) {
      console.error(`${title} export fetch failed:`, err);
      setPhase("error");
      // No `announce` here: the message renders in `InlineAlert variant="error"`,
      // which is `role="alert"` and is spoken on insertion. Announcing as well
      // says it twice.
      setErrorMessage("Couldn't load data. Check your connection and try again.");
    }
  };

  const handleDownload = () => {
    if (tracks.length === 0) return;
    // Full content, built fresh on demand — this is the actual download and
    // must reflect every track, however many there are.
    const { content, extension, mime } = buildExportContent(tracks, format);
    downloadFile(content, buildDatedFilename(filenamePrefix, extension), mime);
  };

  // The on-screen preview only ever shows PREVIEW_LINE_COUNT lines, so build
  // it from a small slice of the library instead of serializing the whole
  // thing (which can be tens of thousands of tracks) on every render.
  const previewLines = useMemo(() => {
    if (tracks.length === 0) return [];
    const { content } = buildExportContent(tracks.slice(0, PREVIEW_TRACK_COUNT), format);
    return content.split("\n").filter((l) => l.length > 0).slice(0, PREVIEW_LINE_COUNT);
  }, [tracks, format]);
  const isLoading = phase === "loading";

  const body = (
    <>
      {extraControls}

      <div className="mt-4">
        <Select
          label="Format"
          id={`${filenamePrefix}-format`}
          value={format}
          onChange={(e) => setFormat(e.target.value as TrackExportFormat)}
          disabled={isLoading}
        >
          {(Object.keys(TRACK_FORMAT_LABELS) as TrackExportFormat[]).map((key) => (
            <option key={key} value={key}>
              {TRACK_FORMAT_LABELS[key]}
            </option>
          ))}
        </Select>
      </div>

      {phase === "error" && errorMessage && (
        <div className="mt-4">
          <InlineAlert variant="error">{errorMessage}</InlineAlert>
        </div>
      )}

      {phase === "empty" && (
        <div className="mt-4">
          <EmptyState
            icon={icon}
            title={emptyTitle}
            description={emptyDescription}
            action={
              emptyLinkHref && emptyLinkLabel ? (
                <Link
                  href={emptyLinkHref}
                  className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-primary-text hover:bg-accent hover:text-accent-foreground hover:underline"
                >
                  {emptyLinkLabel}
                </Link>
              ) : undefined
            }
          />
        </div>
      )}

      {phase === "ready" && (
        <div className="mt-4">
          {/* `role="status"` is on the count alone. Wrapping the block put the
              caption and the ten-line `<pre>` inside an implicitly atomic live
              region, so changing Format re-read the whole preview. */}
          <p role="status" className="text-sm font-medium text-foreground">
            {tracks.length.toLocaleString()} track{tracks.length === 1 ? "" : "s"} ready
          </p>
          {tracks.length > 5000 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Large list — download may take a moment to generate.
            </p>
          )}
          {/* `tabIndex={0}` because this box scrolls: ten preview lines do not
              fit `max-h-48` once the titles are long enough to wrap, and a
              scrollable region that nothing can focus is unreachable from the
              keyboard (WCAG 2.1.1, axe `scrollable-region-focusable`). It is
              the one non-interactive element that has to be focusable, which
              is what the rule exemption below is for. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div tabIndex={0} role="group" aria-label={PREVIEW_LABEL} className={PREVIEW_BOX_CLASS}>
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              Preview (first {PREVIEW_LINE_COUNT} lines)
            </p>
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
              {previewLines.join("\n")}
              {tracks.length > PREVIEW_LINE_COUNT && (
                <span className="text-muted-foreground">
                  {`\n… and ${(tracks.length - PREVIEW_LINE_COUNT).toLocaleString()} more`}
                </span>
              )}
            </pre>
          </div>
        </div>
      )}

      {isLoading && (
        <div role="status" className="mt-4 flex flex-col items-center gap-3 py-6">
          <LoadingSpinner />
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            Fetching… This may take a while for large libraries.
          </p>
        </div>
      )}

      <ActionBar>
        <Button onClick={fetchAndPrepare} disabled={isLoading || fetchDisabled} className="gap-2">
          {isLoading ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Fetching…
            </>
          ) : phase === "ready" ? (
            "Refresh list"
          ) : (
            fetchLabel
          )}
        </Button>

        {phase === "ready" && (
          <Button variant="secondary" onClick={handleDownload} className="gap-2">
            <Download aria-hidden="true" className="h-4 w-4" />
            Download
          </Button>
        )}

        {phase === "error" && (
          <Button variant="secondary" onClick={fetchAndPrepare} disabled={isLoading}>
            Retry
          </Button>
        )}
      </ActionBar>
    </>
  );

  if (embedded) {
    return <EmbeddedPanel title={title}>{body}</EmbeddedPanel>;
  }

  return (
    <ExportSection icon={icon} title={title} subtitle={subtitle} description={description}>
      {body}
    </ExportSection>
  );
}

/**
 * `embedded` drops `ExportSection`, and with it the only `<h2>` on the page —
 * leaving the sub-page's `<h1>` with nothing under it and the export controls
 * in no section at all. The heading comes back here.
 */
function EmbeddedPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Panel title={title}>{children}</Panel>
  );
}
