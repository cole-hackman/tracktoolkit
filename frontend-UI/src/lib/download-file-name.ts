/**
 * What a file saved by the Downloads page's folder mode is called.
 *
 * SoundCloud's CDN names a download after the artist's original upload
 * (`drakeMASTERED_.wav`, `final styler mashup.wav`), which is useless in a
 * DJ library. When the page writes the file itself it can name it
 * "Artist - Title.ext" instead. The extension is read from the first bytes
 * of the file, because the CDN's `Content-Type` is often `octet-stream` and
 * its `Content-Disposition` is only readable when the CDN exposes it.
 * Pure functions, unit-tested in e2e/download-file-name.unit.spec.ts.
 */

const MAX_STEM_LENGTH = 150;

/** A name every filesystem Rekordbox runs on will accept. */
export function safeFileName(name: string): string {
  let s = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (s.length > MAX_STEM_LENGTH) {
    const cut = s.slice(0, MAX_STEM_LENGTH);
    const space = cut.lastIndexOf(" ");
    s = (space > MAX_STEM_LENGTH - 30 ? cut.slice(0, space) : cut).trim().replace(/[. ]+$/g, "");
  }
  return s;
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** The container the bytes actually are, from the file's magic numbers. */
export function sniffAudioExtension(bytes: Uint8Array): string | null {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "FORM" && /^AIF[FC]$/.test(ascii(bytes, 8, 4))) return "aiff";
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (bytes.length >= 8 && ascii(bytes, 4, 4) === "ftyp") return "m4a";
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
};

export function extensionFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPES[type] ?? null;
}

export function extensionFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  let filename: string | null = null;
  const star = disposition.match(/filename\*\s*=\s*(?:[\w-]+)'[\w-]*'([^;]+)/i);
  if (star) {
    try {
      filename = decodeURIComponent(star[1].trim());
    } catch {
      filename = star[1].trim();
    }
  } else {
    const plain = disposition.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
    if (plain) filename = (plain[1] ?? plain[2]).trim();
  }
  if (!filename) return null;
  const ext = filename.match(/\.([A-Za-z0-9]{2,5})$/);
  return ext ? ext[1].toLowerCase() : null;
}

export interface FileNameEvidence {
  /** The first bytes of the body — the most reliable witness. */
  head: Uint8Array;
  contentType: string | null;
  disposition: string | null;
}

/** "Artist - Title.ext"; the title alone when it already leads with the artist. */
export function buildFileName(item: { artist: string; title: string }, evidence: FileNameEvidence): string {
  const ext =
    sniffAudioExtension(evidence.head) ??
    extensionFromDisposition(evidence.disposition) ??
    extensionFromContentType(evidence.contentType) ??
    "mp3";
  const artist = item.artist.trim();
  const title = item.title.trim();
  const leadsWithArtist = artist.length > 0 && title.toLowerCase().startsWith(artist.toLowerCase());
  const stem = safeFileName(artist && !leadsWithArtist ? `${artist} - ${title}` : title) || "track";
  return `${stem}.${ext}`;
}
