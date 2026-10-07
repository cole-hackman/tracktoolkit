/**
 * What a track's download situation actually is, in words.
 *
 * SoundCloud gives three relevant fields: `downloadable` + `download_url`
 * (the artist enabled SoundCloud's own download), and `purchase_url` +
 * `purchase_title` (whatever link the artist put on the buy button — a free
 * download gate, a store, a pre-order, a smart link). The Downloads page used
 * to count every `purchase_url` as "downloadable", so a Beatport pre-order
 * was offered as "Download … — PRE ORDER". This turns those fields into one
 * status the page can say out loud, and is the only place that decides it.
 *
 * Only two kinds move a file, and both are paths the artist opted into:
 * `direct` (SoundCloud's download endpoint) and `gate` (a free-download gate
 * the artist published). Everything else is "where to get it".
 */

export type DownloadKind =
  | "direct" // SoundCloud's own download, enabled by the artist
  | "gate" // a free-download gate (Hypeddit, Droploud, ToneDen, …)
  | "store" // a store page (Beatport, Bandcamp, …)
  | "preorder" // a pre-order / pre-save
  | "link" // some other link the artist set (smart link, Patreon, …)
  | "blocked" // SoundCloud blocks this track for this account/region
  | "none"; // nothing offered

export interface DownloadStatus {
  kind: DownloadKind;
  /** Short word(s) for the status chip. */
  label: string;
  /** One sentence: why, or what happens on click. */
  reason: string;
  /** Where the action goes (external link), when there is one. */
  href?: string;
  /** Human name of the link's site, e.g. "Hypeddit", "Beatport". */
  site?: string;
  /** Accessible name for the row's action control. */
  actionLabel?: string;
}

export interface DownloadStatusTrack {
  title: string;
  user?: { username?: string } | null;
  downloadable?: boolean | string | null;
  download_url?: string | null;
  purchase_url?: string | null;
  purchase_title?: string | null;
  access?: string | null;
}

type HostKind = "gate" | "store" | "link";

const HOSTS: Array<{ match: (host: string) => boolean; site: string; kind: HostKind }> = [
  // Free-download gates
  { match: (h) => h === "hypeddit.com", site: "Hypeddit", kind: "gate" },
  { match: (h) => h === "droploud.com", site: "Droploud", kind: "gate" },
  { match: (h) => h === "toneden.io", site: "ToneDen", kind: "gate" },
  { match: (h) => h === "laylo.com", site: "Laylo", kind: "gate" },
  { match: (h) => h === "gaterush.me", site: "Gaterush", kind: "gate" },
  { match: (h) => h === "insom.co", site: "Insom", kind: "gate" },
  { match: (h) => h === "snd.click", site: "snd.click", kind: "gate" },
  { match: (h) => h === "drop.cobrand.com", site: "Cobrand", kind: "gate" },
  // Stores
  { match: (h) => h === "beatport.com", site: "Beatport", kind: "store" },
  { match: (h) => h === "bandcamp.com" || h.endsWith(".bandcamp.com"), site: "Bandcamp", kind: "store" },
  { match: (h) => h === "traxsource.com", site: "Traxsource", kind: "store" },
  { match: (h) => h === "junodownload.com" || h === "juno.co.uk", site: "Juno", kind: "store" },
  { match: (h) => h === "music.apple.com" || h === "itunes.apple.com", site: "Apple Music", kind: "store" },
  { match: (h) => h === "amazon.com" || h.startsWith("amazon."), site: "Amazon", kind: "store" },
  { match: (h) => h === "7digital.com", site: "7digital", kind: "store" },
  // Other links the artist set
  { match: (h) => h === "lnk.to" || h.endsWith(".lnk.to"), site: "lnk.to", kind: "link" },
  { match: (h) => h === "ffm.to" || h.endsWith(".ffm.to"), site: "Feature.fm", kind: "link" },
  { match: (h) => h === "fanlink.to" || h.endsWith(".fanlink.to"), site: "Fanlink", kind: "link" },
  { match: (h) => h === "smarturl.it", site: "smarturl.it", kind: "link" },
  { match: (h) => h === "linktr.ee", site: "Linktree", kind: "link" },
  { match: (h) => h === "distrokid.com", site: "DistroKid", kind: "link" },
  { match: (h) => h === "patreon.com", site: "Patreon", kind: "link" },
];

const FREE_TITLE = /\bfree\b|\bf\.?\s?dl\b|\bfree\s*download\b|^\s*(dl|download)\s*[!🔥]*\s*$/i;
const PREORDER_TITLE = /pre[-\s]?(order|save)/i;
const BUY_TITLE = /\b(buy|purchase|beatport|bandcamp)\b/i;

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * A `download_url` the artist has not switched off. SoundCloud types
 * `downloadable` as a string, so `"false"` has to count as off — the old
 * `Boolean(t.downloadable)` read it as on. An absent flag with a URL present
 * counts as on: some payloads drop the flag but keep the URL.
 */
export function isDownloadEnabled(track: DownloadStatusTrack): boolean {
  const d = track.downloadable;
  const off = d === false || (typeof d === "string" && d.trim().toLowerCase() === "false");
  return !!track.download_url && !off;
}

export function downloadStatus(track: DownloadStatusTrack): DownloadStatus {
  const title = track.title || "this track";

  if (track.access === "blocked") {
    return {
      kind: "blocked",
      label: "Blocked",
      reason: "SoundCloud blocks this track for your account or region, so nothing can be offered.",
    };
  }

  if (isDownloadEnabled(track)) {
    return {
      kind: "direct",
      label: "Direct download",
      reason: "The artist enabled SoundCloud's own download.",
      site: "SoundCloud",
      actionLabel: `Download ${title} (free download)`,
    };
  }

  const purchaseUrl = track.purchase_url || "";
  const host = purchaseUrl ? hostOf(purchaseUrl) : null;
  const purchaseTitle = (track.purchase_title || "").trim();

  if (host) {
    const known = HOSTS.find((h) => h.match(host));
    const site = known?.site ?? host;
    let kind: DownloadKind = known?.kind ?? "link";
    // The button's own words beat the host for pre-orders ("PRE ORDER" on a
    // Beatport link) and for unknown hosts that say "free download".
    if (PREORDER_TITLE.test(purchaseTitle)) kind = "preorder";
    else if (!known && FREE_TITLE.test(purchaseTitle)) kind = "gate";
    else if (!known && BUY_TITLE.test(purchaseTitle)) kind = "store";

    if (kind === "gate") {
      return {
        kind,
        label: `Free gate · ${site}`,
        reason: `Free download through the artist's ${site} gate.`,
        href: purchaseUrl,
        site,
        actionLabel: site === "Hypeddit" ? `Download ${title} via Hypeddit` : `Download ${title} via ${site} (free download gate)`,
      };
    }
    if (kind === "preorder") {
      return {
        kind,
        label: `Pre-order · ${site}`,
        reason: "Not out yet — the artist links a pre-order or pre-save.",
        href: purchaseUrl,
        site,
        actionLabel: `Pre-order ${title} on ${site}`,
      };
    }
    if (kind === "store") {
      return {
        kind,
        label: `Buy · ${site}`,
        reason: `Sold on ${site}; the artist hasn't offered a free download.`,
        href: purchaseUrl,
        site,
        actionLabel: `Buy ${title} on ${site}`,
      };
    }
    return {
      kind: "link",
      label: `Link · ${site}`,
      reason: purchaseTitle ? `The artist links "${purchaseTitle}" on ${site}.` : `The artist links ${site}.`,
      href: purchaseUrl,
      site,
      actionLabel: `Open ${title} on ${site}`,
    };
  }

  if (track.access === "preview") {
    return {
      kind: "none",
      label: "Not offered",
      reason: "Only a preview plays on SoundCloud, and the artist hasn't offered a download.",
    };
  }
  return {
    kind: "none",
    label: "Not offered",
    reason: "The artist hasn't enabled downloads or linked anywhere to get it.",
  };
}

/** True for the two kinds that move a file — the page's "downloadable". */
export const isFreeDownload = (status: DownloadStatus) => status.kind === "direct" || status.kind === "gate";

/**
 * Search links for a track with nowhere to get it. Searches only — nothing
 * is fetched or scraped; the store does the matching.
 */
export function storeSearchLinks(track: DownloadStatusTrack): Array<{ site: string; href: string }> {
  const q = [track.user?.username, track.title].filter(Boolean).join(" ").trim();
  if (!q) return [];
  const enc = encodeURIComponent(q);
  return [
    { site: "Beatport", href: `https://www.beatport.com/search?q=${enc}` },
    { site: "Bandcamp", href: `https://bandcamp.com/search?q=${enc}` },
    { site: "Traxsource", href: `https://www.traxsource.com/search?term=${enc}` },
  ];
}

/** The page's filter buckets. */
export type DownloadFilter = "downloadable" | "buy" | "unavailable" | "all";

export function matchesFilter(status: DownloadStatus, filter: DownloadFilter, track?: DownloadStatusTrack): boolean {
  switch (filter) {
    case "all":
      return true;
    case "downloadable":
      // A blocked track keeps its row here when it would otherwise have had a
      // download, so it can still be selected and removed (see PR #60).
      return isFreeDownload(status) || (status.kind === "blocked" && !!track && (!!track.download_url || !!track.purchase_url));
    case "buy":
      return status.kind === "store" || status.kind === "preorder" || status.kind === "link";
    case "unavailable":
      return status.kind === "none" || status.kind === "blocked";
  }
}
