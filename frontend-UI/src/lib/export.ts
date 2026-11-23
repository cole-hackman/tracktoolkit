import { csvEscape } from "./csv";

export interface ExportUser {
  username?: string;
  display_name?: string;
  full_name?: string;
}

export interface ExportTrack {
  id: number;
  title: string;
  user?: ExportUser;
  permalink_url?: string;
}

export interface NormalizedLike {
  track: ExportTrack;
  liked_at: string;
  liked_order: number;
}

export type TrackExportFormat = "title-artist" | "title-artist-url" | "urls" | "csv";

export interface ExportFollowing {
  id: number;
  username: string;
  full_name?: string;
  permalink_url?: string;
  followers_count?: number;
  track_count?: number;
}

export interface ExportRepost {
  id: number;
  resourceType: "track" | "playlist";
  title: string;
  user?: ExportUser;
  permalink_url?: string | null;
  created_at?: string | null;
}

export function getArtistName(user?: ExportUser): string {
  const display = user?.display_name?.trim() || user?.full_name?.trim();
  if (display) return display;
  const username = user?.username?.trim();
  if (username) return username;
  return "Unknown Artist";
}

export function formatTitleArtistLine(track: ExportTrack): string {
  const title = track.title?.trim() || "Untitled";
  return `${title} - ${getArtistName(track.user)}`;
}

export function formatTitleArtistUrlLine(track: ExportTrack): string {
  const base = formatTitleArtistLine(track);
  const url = track.permalink_url?.trim();
  return url ? `${base} | ${url}` : base;
}

export function formatTrackUrlLine(track: ExportTrack): string {
  return track.permalink_url?.trim() || "";
}

/** Kept for its callers; the quoting and the formula guard live in `csvEscape`. */
export function escapeCsvCell(value: unknown): string {
  return csvEscape(value);
}

export function tracksToCsv(tracks: ExportTrack[], extra?: { liked_at?: string }[]): string {
  const header = "title,artist,permalink_url,track_id";
  const rows = tracks.map((track, i) => {
    const cells = [
      track.title?.trim() || "Untitled",
      getArtistName(track.user),
      track.permalink_url || "",
      track.id,
    ];
    if (extra?.[i]?.liked_at) {
      // optional column not in default header — keep header stable for v1
    }
    return cells.map(escapeCsvCell).join(",");
  });
  return [header, ...rows].join("\n");
}

export function buildExportContent(
  tracks: ExportTrack[],
  format: TrackExportFormat
): { content: string; extension: "txt" | "csv"; mime: string } {
  switch (format) {
    case "title-artist":
      return {
        content: tracks.map(formatTitleArtistLine).join("\n"),
        extension: "txt",
        mime: "text/plain;charset=utf-8",
      };
    case "title-artist-url":
      return {
        content: tracks.map(formatTitleArtistUrlLine).join("\n"),
        extension: "txt",
        mime: "text/plain;charset=utf-8",
      };
    case "urls":
      return {
        content: tracks.map(formatTrackUrlLine).filter(Boolean).join("\n"),
        extension: "txt",
        mime: "text/plain;charset=utf-8",
      };
    case "csv":
      return {
        content: tracksToCsv(tracks),
        extension: "csv",
        mime: "text/csv;charset=utf-8",
      };
    default:
      return {
        content: tracks.map(formatTitleArtistLine).join("\n"),
        extension: "txt",
        mime: "text/plain;charset=utf-8",
      };
  }
}

export function normalizeLikesCollection(
  collection: Array<{ track?: ExportTrack; created_at?: string } & ExportTrack>
): NormalizedLike[] {
  return collection.map((item, index) => {
    if (item.track) {
      return {
        track: item.track,
        liked_at: item.created_at || "",
        liked_order: index,
      };
    }
    return {
      track: item,
      liked_at: "",
      liked_order: index,
    };
  });
}

export function likesToTracks(likes: NormalizedLike[]): ExportTrack[] {
  return likes.map((l) => l.track);
}

export function buildDatedFilename(prefix: string, extension: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${prefix}-${y}-${m}-${d}.${extension}`;
}

export function downloadFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

/** @deprecated use downloadFile */
export function downloadTextFile(content: string, filename: string): void {
  downloadFile(content, filename, "text/plain;charset=utf-8");
}

export function getFollowingDisplayName(user: ExportFollowing): string {
  return user.full_name?.trim() || user.username?.trim() || "Unknown";
}

export function followingsToTxt(followings: ExportFollowing[]): string {
  return followings
    .map((u) => {
      const name = getFollowingDisplayName(u);
      const handle = u.username ? `@${u.username}` : "";
      if (name && handle && name !== u.username) return `${name} (${handle})`;
      return handle || name;
    })
    .join("\n");
}

export function followingsToCsv(followings: ExportFollowing[]): string {
  const header = "username,display_name,permalink_url,followers_count,track_count,user_id";
  const rows = followings.map((u) =>
    [
      u.username || "",
      u.full_name || "",
      u.permalink_url || "",
      u.followers_count ?? "",
      u.track_count ?? "",
      u.id,
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  return [header, ...rows].join("\n");
}

export function formatRepostLine(repost: ExportRepost): string {
  if (repost.resourceType === "playlist") {
    const title = repost.title?.trim() || "Untitled Playlist";
    return `Playlist: ${title} - ${getArtistName(repost.user)}`;
  }
  return formatTitleArtistLine({
    id: repost.id,
    title: repost.title,
    user: repost.user,
    permalink_url: repost.permalink_url || undefined,
  });
}

export function repostsToTxt(reposts: ExportRepost[], includeUrls: boolean): string {
  return reposts
    .map((r) => {
      const line = formatRepostLine(r);
      const url = r.permalink_url?.trim();
      if (includeUrls && url) return `${line} | ${url}`;
      return line;
    })
    .join("\n");
}

export function repostsToUrls(reposts: ExportRepost[]): string {
  return reposts.map((r) => r.permalink_url?.trim() || "").filter(Boolean).join("\n");
}

export function repostsToCsv(reposts: ExportRepost[]): string {
  const header = "type,title,artist,permalink_url,created_at,id";
  const rows = reposts.map((r) =>
    [
      r.resourceType,
      r.title || "",
      getArtistName(r.user),
      r.permalink_url || "",
      r.created_at || "",
      r.id,
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  return [header, ...rows].join("\n");
}

export const TRACK_FORMAT_LABELS: Record<TrackExportFormat, string> = {
  "title-artist": "Title - Artist (.txt)",
  "title-artist-url": "Title - Artist + URL (.txt)",
  urls: "URLs only (.txt)",
  csv: "CSV (title, artist, URL, id)",
};

// Re-export legacy names from export-likes
export {
  formatTitleArtistLine as formatLikeLine,
  likesToTracks as likesToExportLines,
  buildDatedFilename as buildLikesExportFilename,
};
