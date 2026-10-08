/**
 * Reads a Rekordbox collection export (File → Export Collection in xml
 * format): `DJ_PLAYLISTS > COLLECTION > TRACK`. Ported and trimmed from
 * RekordSort's parser (~/Developer/Rekordsort/src/lib/rekordbox-parser.ts),
 * which was validated against Rekordbox 7.2.8 exports of 4,000+ tracks.
 *
 * Runs in the browser, on a file the user picked; nothing here is uploaded.
 * It keeps only what matching needs — no file paths (`Location`), comments,
 * play counts or ratings — so the parsed result holds nothing about the
 * user's disk.
 */

export interface RekordboxTrack {
  title: string;
  artist: string;
  /** `Mix` attribute, e.g. "Extended Mix". */
  mix: string;
  remixer: string;
  genre: string;
  label: string;
  /** Seconds; 0 when Rekordbox did not record it. */
  durationSec: number;
  /** null when unanalysed (Rekordbox writes "0.00"). */
  bpm: number | null;
  /** Rekordbox `Tonality`, e.g. "8A"; null when absent. */
  key: string | null;
}

export interface RekordboxCollection {
  tracks: RekordboxTrack[];
  /** "rekordbox 7.2.8" when the export names itself. */
  product: string | null;
  /** COLLECTION's own Entries attribute, for a "read N of M" check. */
  declaredCount: number | null;
}

export class RekordboxParseError extends Error {
  constructor(
    readonly kind: "invalid-xml" | "unsupported-structure" | "missing-collection" | "empty-library",
    message: string,
  ) {
    super(message);
  }
}

export function parseRekordboxCollection(text: string): RekordboxCollection {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "text/xml");
  } catch {
    throw new RekordboxParseError("invalid-xml", "This file could not be read as XML. Export a fresh copy from Rekordbox.");
  }
  if (doc.querySelector("parsererror")) {
    throw new RekordboxParseError("invalid-xml", "This file is not valid XML. Export a fresh copy from Rekordbox.");
  }

  const root = doc.documentElement;
  if (root.tagName !== "DJ_PLAYLISTS") {
    throw new RekordboxParseError(
      "unsupported-structure",
      `This is not a Rekordbox collection export (it starts with <${root.tagName}>, not <DJ_PLAYLISTS>).`,
    );
  }

  const collection = [...root.children].find((el) => el.tagName === "COLLECTION");
  if (!collection) {
    throw new RekordboxParseError("missing-collection", "The export has no COLLECTION. Use File → Export Collection in xml format.");
  }

  const tracks: RekordboxTrack[] = [];
  // Direct children only: TRACK elements inside PLAYLISTS are references.
  for (const el of collection.children) {
    if (el.tagName !== "TRACK") continue;
    const title = (el.getAttribute("Name") ?? "").trim();
    const artist = (el.getAttribute("Artist") ?? "").trim();
    if (!title && !artist) continue;
    const bpmRaw = parseFloat(el.getAttribute("AverageBpm") ?? "0");
    const key = (el.getAttribute("Tonality") ?? "").trim();
    tracks.push({
      title,
      artist,
      mix: (el.getAttribute("Mix") ?? "").trim(),
      remixer: (el.getAttribute("Remixer") ?? "").trim(),
      genre: (el.getAttribute("Genre") ?? "").trim(),
      label: (el.getAttribute("Label") ?? "").trim(),
      durationSec: parseInt(el.getAttribute("TotalTime") ?? "0", 10) || 0,
      bpm: bpmRaw > 0 ? Math.round(bpmRaw * 100) / 100 : null,
      key: key || null,
    });
  }
  if (tracks.length === 0) {
    throw new RekordboxParseError("empty-library", "The export contains no tracks.");
  }

  const productEl = [...root.children].find((el) => el.tagName === "PRODUCT");
  const product = productEl
    ? [productEl.getAttribute("Name"), productEl.getAttribute("Version")].filter(Boolean).join(" ") || null
    : null;
  const entries = parseInt(collection.getAttribute("Entries") ?? "", 10);

  return { tracks, product, declaredCount: Number.isFinite(entries) ? entries : null };
}
