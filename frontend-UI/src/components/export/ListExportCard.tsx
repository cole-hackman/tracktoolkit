"use client";

import { useState } from "react";
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
import { buildDatedFilename, downloadFile } from "@/lib/export";
import { ExportSection } from "./ExportSection";

const PREVIEW_LINE_COUNT = 10;
const PREVIEW_LABEL = `Preview, first ${PREVIEW_LINE_COUNT} lines`;
const PREVIEW_BOX_CLASS =
  "mt-3 max-h-48 overflow-y-auto rounded-xl border border-border bg-muted/30 p-3 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background";

type Phase = "idle" | "loading" | "ready" | "empty" | "error";

export interface ListExportFormat {
  id: string;
  label: string;
  extension: "txt" | "csv";
  mime: string;
  build: (items: unknown[]) => string;
}

interface ListExportCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  description: string;
  fetchLabel: string;
  filenamePrefix: string;
  formats: ListExportFormat[];
  emptyTitle: string;
  emptyDescription: string;
  emptyLinkHref?: string;
  emptyLinkLabel?: string;
  loadItems: () => Promise<unknown[]>;
  embedded?: boolean;
}

export function ListExportCard({
  icon,
  title,
  subtitle,
  description,
  fetchLabel,
  filenamePrefix,
  formats,
  emptyTitle,
  emptyDescription,
  emptyLinkHref,
  emptyLinkLabel,
  loadItems,
  embedded = false,
}: ListExportCardProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [items, setItems] = useState<unknown[]>([]);
  const [formatId, setFormatId] = useState(formats[0]?.id ?? "txt");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const announce = useAnnounce();
  const selectedFormat = formats.find((f) => f.id === formatId) ?? formats[0];

  const fetchAndPrepare = async () => {
    setPhase("loading");
    setErrorMessage(null);
    setItems([]);

    try {
      const loaded = await loadItems();
      if (loaded.length === 0) {
        setPhase("empty");
        announce(emptyTitle);
        return;
      }
      setItems(loaded);
      setPhase("ready");
      announce(`${loaded.length.toLocaleString()} item${loaded.length === 1 ? "" : "s"} ready to download.`);
    } catch (err) {
      console.error(`${title} export fetch failed:`, err);
      setPhase("error");
      // No `announce` here — see the note in `TrackExportCard`.
      setErrorMessage("Couldn't load data. Check your connection and try again.");
    }
  };

  const handleDownload = () => {
    if (items.length === 0 || !selectedFormat) return;
    const content = selectedFormat.build(items);
    downloadFile(
      content,
      buildDatedFilename(filenamePrefix, selectedFormat.extension),
      selectedFormat.mime
    );
  };

  const previewContent =
    items.length > 0 && selectedFormat ? selectedFormat.build(items) : "";
  const previewLines = previewContent.split("\n").filter((l) => l.length > 0).slice(0, PREVIEW_LINE_COUNT);
  const isLoading = phase === "loading";

  const body = (
    <>
      {formats.length > 1 && (
        <div className="mt-4">
          <Select
            label="Format"
            id={`${filenamePrefix}-format`}
            value={formatId}
            onChange={(e) => setFormatId(e.target.value)}
            disabled={isLoading}
          >
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
      )}

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
            {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"} ready
          </p>
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
              {items.length > PREVIEW_LINE_COUNT && (
                <span className="text-muted-foreground">
                  {`\n… and ${(items.length - PREVIEW_LINE_COUNT).toLocaleString()} more`}
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
            Fetching… This may take a while for large lists.
          </p>
        </div>
      )}

      <ActionBar>
        <Button onClick={fetchAndPrepare} disabled={isLoading} className="gap-2">
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
    // `embedded` drops `ExportSection`, and with it the only `<h2>` on the
    // page — leaving the sub-page's `<h1>` with nothing under it. Put the
    // heading back.
    return (
      <Panel title={title}>{body}</Panel>
    );
  }

  return (
    <ExportSection icon={icon} title={title} subtitle={subtitle} description={description}>
      {body}
    </ExportSection>
  );
}

