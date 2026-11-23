/**
 * Mirrors frontend-UI/src/lib/export.ts for node jest runs
 */

function getArtistName(user) {
  const display = user?.display_name?.trim() || user?.full_name?.trim();
  if (display) return display;
  const username = user?.username?.trim();
  if (username) return username;
  return "Unknown Artist";
}

function formatTitleArtistLine(track) {
  const title = track.title?.trim() || "Untitled";
  return `${title} - ${getArtistName(track.user)}`;
}

function formatTitleArtistUrlLine(track) {
  const base = formatTitleArtistLine(track);
  const url = track.permalink_url?.trim();
  return url ? `${base} | ${url}` : base;
}

// Mirrors csvEscape in frontend-UI/src/lib/csv.ts, which escapeCsvCell now
// delegates to (formula guard on strings; the real coverage is
// frontend-UI/e2e/export-csv.unit.spec.ts).
function escapeCsvCell(value) {
  const raw = String(value ?? "");
  const safe = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function tracksToCsv(tracks) {
  const header = "title,artist,permalink_url,track_id";
  const rows = tracks.map((track) =>
    [track.title || "Untitled", getArtistName(track.user), track.permalink_url || "", track.id]
      .map(escapeCsvCell)
      .join(",")
  );
  return [header, ...rows].join("\n");
}

function buildExportContent(tracks, format) {
  switch (format) {
    case "title-artist-url":
      return { content: tracks.map(formatTitleArtistUrlLine).join("\n"), extension: "txt" };
    case "urls":
      return {
        content: tracks.map((t) => t.permalink_url?.trim() || "").filter(Boolean).join("\n"),
        extension: "txt",
      };
    case "csv":
      return { content: tracksToCsv(tracks), extension: "csv" };
    default:
      return { content: tracks.map(formatTitleArtistLine).join("\n"), extension: "txt" };
  }
}

function buildDatedFilename(prefix, extension, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${prefix}-${y}-${m}-${d}.${extension}`;
}

function getFollowingDisplayName(user) {
  return user.full_name?.trim() || user.username?.trim() || "Unknown";
}

function followingsToTxt(followings) {
  return followings
    .map((u) => {
      const name = getFollowingDisplayName(u);
      const handle = u.username ? `@${u.username}` : "";
      if (name && handle && name !== u.username) return `${name} (${handle})`;
      return handle || name;
    })
    .join("\n");
}

function followingsToCsv(followings) {
  return "username,display_name,permalink_url,followers_count,track_count,user_id";
}

function formatRepostLine(repost) {
  if (repost.resourceType === "playlist") {
    return `Playlist: ${repost.title || "Untitled Playlist"} - ${getArtistName(repost.user)}`;
  }
  return formatTitleArtistLine({ id: repost.id, title: repost.title, user: repost.user });
}

function repostsToTxt(reposts) {
  return reposts.map(formatRepostLine).join("\n");
}

function repostsToCsv() {
  return "type,title,artist,permalink_url,created_at,id";
}

describe("export utilities", () => {
  const track = {
    id: 1,
    title: "Midnight City",
    user: { display_name: "M83", username: "m83" },
    permalink_url: "https://soundcloud.com/m83/midnight-city",
  };

  test("formatTitleArtistLine", () => {
    expect(formatTitleArtistLine(track)).toBe("Midnight City - M83");
  });

  test("formatTitleArtistUrlLine includes permalink", () => {
    expect(formatTitleArtistUrlLine(track)).toContain("https://soundcloud.com");
  });

  test("buildExportContent csv has header", () => {
    const { content, extension } = buildExportContent([track], "csv");
    expect(extension).toBe("csv");
    expect(content.split("\n")[0]).toBe("title,artist,permalink_url,track_id");
  });

  test("buildExportContent urls only", () => {
    expect(buildExportContent([track], "urls").content).toBe(track.permalink_url);
  });

  test("buildDatedFilename", () => {
    expect(buildDatedFilename("soundcloud-likes", "txt", new Date(2026, 4, 14))).toBe(
      "soundcloud-likes-2026-05-14.txt"
    );
  });

  test("followingsToTxt", () => {
    const lines = followingsToTxt([{ id: 1, username: "artist", full_name: "The Artist" }]);
    expect(lines).toContain("The Artist");
    expect(lines).toContain("@artist");
  });

  test("repostsToTxt playlist prefix", () => {
    const txt = repostsToTxt([
      { id: 2, resourceType: "playlist", title: "Summer Mix", user: { username: "dj" } },
    ]);
    expect(txt).toContain("Playlist: Summer Mix");
  });
});
