/**
 * The queue item the Downloads page hands the browser extension (through
 * localStorage and a window message), and the one file the local Hypeddit
 * runner reads. A Droploud or Cobrand gate is only queued when the extension
 * has reported that site in `sc-toolkit-ext-gates` (`extensionGateSites`);
 * Hypeddit has no such condition. How a gate is worked belongs to the
 * extension's own repo, not this one.
 */

export type GateSite = "hypeddit" | "droploud" | "cobrand";

export interface GateQueueItem {
  id: number;
  title: string;
  artist: string;
  site: GateSite;
  gateUrl: string;
  /**
   * Hypeddit items only, and the same value as `gateUrl`: extensions that
   * predate the other sites read this field and ignore the rest.
   */
  hypedditUrl?: string;
}

/** The queue's site for a `DownloadStatus.site` name, or null for any other gate. */
export function gateSiteOf(siteName: string | undefined): GateSite | null {
  switch (siteName) {
    case "Hypeddit":
      return "hypeddit";
    case "Droploud":
      return "droploud";
    case "Cobrand":
      return "cobrand";
    default:
      return null;
  }
}

export function gateQueueItem(
  track: { id: number; title: string; user?: { username?: string } | null },
  site: GateSite,
  gateUrl: string,
): GateQueueItem {
  return {
    id: track.id,
    title: track.title,
    artist: track.user?.username ?? "",
    site,
    gateUrl,
    ...(site === "hypeddit" ? { hypedditUrl: gateUrl } : {}),
  };
}

/** Where the extension records the sites it can work, e.g. "hypeddit,droploud,cobrand". */
export const EXT_GATES_KEY = "sc-toolkit-ext-gates";

/** The extension's default per-queue limit for Droploud and Cobrand gates (its `hdRunCap`). */
export const EXT_RUN_CAP_DEFAULT = 10;

/**
 * The sites the installed extension says it supports. Empty when the flag is
 * absent, which is what keeps a new gate site off the page until an extension
 * that can work it is installed. Hypeddit does not depend on this — it has
 * always been offered.
 */
export function extensionGateSites(raw: string | null | undefined): Set<GateSite> {
  const sites = new Set<GateSite>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "hypeddit" || name === "droploud" || name === "cobrand") sites.add(name);
  }
  return sites;
}

/**
 * Saves Hypeddit gates as the file the local runner (tools/hypeddit-runner)
 * reads: `{ queue: [{ id, title, artist, hypedditUrl }] }`. Items for other
 * sites are left out and the item keys are written explicitly, so this file
 * stays what the runner expects as the queue item grows. The runner drops
 * anything that is not a hypeddit.com gate URL, so this is not a trust
 * boundary — just the one place the file's shape is written.
 */
export function downloadHypedditQueue(queue: GateQueueItem[], filename = "hypeddit-queue.json") {
  const file = queue
    .filter((item) => item.site === "hypeddit" && item.hypedditUrl)
    .map(({ id, title, artist, hypedditUrl }) => ({ id, title, artist, hypedditUrl }));
  const blob = new Blob([JSON.stringify({ queue: file }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
