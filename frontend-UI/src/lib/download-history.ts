import type { DownloadHistoryEntry } from "@/lib/queries";

/**
 * "Already downloaded" as the pages use it: track id → when it was last
 * downloaded through Track Toolkit. Read from /api/downloads/history, which
 * records that a download was *started* (a link was handed to the browser),
 * not that the file is still on disk — and only for 12 months.
 */
export function downloadedMap(entries: DownloadHistoryEntry[] | undefined): Map<number, string> {
  return new Map((entries ?? []).map((e) => [e.trackId, e.lastAt]));
}

/** "Downloaded 3 Oct", or "Downloaded 3 Oct 2025" when it isn't this year. */
export function downloadedLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === now.getFullYear();
  const text = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return `Downloaded ${text}`;
}
