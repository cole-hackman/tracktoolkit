import { test, expect } from "@playwright/test";
import { TOOL_RANKING, rankByUsage } from "../src/lib/tool-ranking";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

/**
 * The dashboard order comes from TOOL_RANKING alone. Pins the two rules that
 * are easy to break when someone edits the numbers: tools sort by unique
 * users with "no data" last, and groups sort by their best-ranked tool.
 */

test("ranked tools are in descending order of unique users, with no-data tools last", () => {
  const ranked = TOOL_RANKING.filter((rank) => rank.users !== null);
  const users = ranked.map((rank) => rank.users as number);
  expect(users).toEqual([...users].sort((a, b) => b - a));
  const firstNull = TOOL_RANKING.findIndex((rank) => rank.users === null);
  expect(TOOL_RANKING.slice(firstNull).every((rank) => rank.users === null)).toBe(true);
  expect(new Set(TOOL_RANKING.map((rank) => rank.id)).size).toBe(TOOL_RANKING.length);
});

test("groups sort by their best-ranked tool and tools sort by rank inside them", () => {
  const items = [
    { id: "genre-search", category: "Discovery" },
    { id: "export", category: "Library" },
    { id: "library-audit", category: "Library" },
    { id: "playlist-compare", category: "Playlists" },
    { id: "combine", category: "Playlists" },
    { id: "not-ranked", category: "Playlists" },
  ];
  const groups = rankByUsage(items, ["Discovery", "Library", "Playlists"]);
  expect(groups.map((group) => group.category)).toEqual(["Playlists", "Library", "Discovery"]);
  expect(groups[0].items.map((item) => item.id)).toEqual(["combine", "playlist-compare", "not-ranked"]);
  expect(groups[1].items.map((item) => item.id)).toEqual(["library-audit", "export"]);
});
