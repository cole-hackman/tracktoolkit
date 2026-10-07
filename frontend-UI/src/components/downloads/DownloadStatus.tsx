"use client";

import { ExternalLink } from "lucide-react";
import { type DownloadKind, type DownloadStatus, type DownloadStatusTrack, storeSearchLinks } from "@/lib/download-status";
import { downloadedLabel } from "@/lib/download-history";

/**
 * Status chips: a word, coloured by token. The colour is decoration — the
 * word is the status — and every text token here is gated on `--card` by
 * `npm run contrast`, which is why the chip carries its own card surface.
 */
const CHIP_TONE: Record<DownloadKind, string> = {
  direct: "text-success-text",
  gate: "text-primary-text",
  store: "text-muted-foreground",
  preorder: "text-warning-text",
  link: "text-muted-foreground",
  blocked: "text-destructive-text",
  none: "text-muted-foreground",
};

/** Status chip + the reason in words; for "nothing offered", where to look. */
export function DownloadStatusLine({ track, status, downloadedAt }: { track: DownloadStatusTrack; status: DownloadStatus; downloadedAt?: string | null }) {
  const search = status.kind === "none" ? storeSearchLinks(track) : [];
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {downloadedAt && (
        <span className="rounded-md border border-border bg-card px-1.5 py-0.5 font-medium text-success-text">
          {downloadedLabel(downloadedAt)}
        </span>
      )}
      <span className={`rounded-md border border-border bg-card px-1.5 py-0.5 font-medium ${CHIP_TONE[status.kind]}`}>
        {status.label}
      </span>
      <span className="min-w-0 text-muted-foreground">{status.reason}</span>
      {search.length > 0 && (
        <span className="text-muted-foreground">
          Search:{" "}
          {search.map((link, i) => (
            <span key={link.site}>
              {i > 0 && " · "}
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Search ${link.site} for ${track.title}`}
                className="font-medium text-primary-text underline underline-offset-2"
              >
                {link.site}
              </a>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * Store, pre-order or other link: an outbound link that says so — never the
 * download glyph, which is what made a Beatport pre-order read as a download.
 * Renders nothing for kinds that are not links.
 */
export function DownloadLinkAction({ status, stopPropagation = false }: { status: DownloadStatus; stopPropagation?: boolean }) {
  if (status.kind !== "store" && status.kind !== "preorder" && status.kind !== "link") return null;
  const verb = status.kind === "store" ? "Buy" : status.kind === "preorder" ? "Pre-order" : "Open";
  return (
    <a
      href={status.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={status.actionLabel}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
    >
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
      {verb}
    </a>
  );
}

/**
 * The download button's surface, as HSL tokens. The hue is decoration — the
 * accessible name says which route a button takes — but it still carries its
 * glyph at 3:1, so each branch names its foreground. `hover:text-*` repeats
 * because `IconButton`'s ghost variant sets `hover:text-accent-foreground`.
 */
export const downloadTone = (status: DownloadStatus) =>
  status.kind === "direct"
    ? "bg-tone-download text-tone-foreground hover:bg-tone-download/90 hover:text-tone-foreground"
    : "bg-tone-purchase text-tone-foreground hover:bg-tone-purchase/90 hover:text-tone-foreground";
