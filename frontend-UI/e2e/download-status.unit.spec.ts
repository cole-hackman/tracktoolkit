import { test, expect } from "@playwright/test";
import { downloadStatus, isFreeDownload, matchesFilter, storeSearchLinks } from "../src/lib/download-status";

/**
 * Pure unit tests for the one function that decides what "downloadable"
 * means. No page: Playwright only transpiles the TypeScript. Run once, on
 * the desktop project — the viewport is irrelevant here.
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const t = (over: Record<string, unknown> = {}) => ({ title: "Tune", user: { username: "Artist" }, access: "playable", ...over });

test("SoundCloud's own download is direct, and the string 'false' is off", () => {
  const url = "https://api.soundcloud.com/tracks/soundcloud:tracks:1/download";
  expect(downloadStatus(t({ downloadable: true, download_url: url })).kind).toBe("direct");
  expect(downloadStatus(t({ downloadable: "true", download_url: url })).kind).toBe("direct");
  expect(downloadStatus(t({ download_url: url })).kind).toBe("direct");
  expect(downloadStatus(t({ downloadable: "false", download_url: url })).kind).toBe("none");
  expect(downloadStatus(t({ downloadable: false, download_url: url })).kind).toBe("none");
  expect(downloadStatus(t({ downloadable: true, download_url: url })).actionLabel).toBe("Download Tune (free download)");
});

test("free-download gates are gates, named by site", () => {
  const hype = downloadStatus(t({ purchase_url: "https://hypeddit.com/artist/tune", purchase_title: "FREE DOWNLOAD" }));
  expect(hype).toMatchObject({ kind: "gate", site: "Hypeddit", actionLabel: "Download Tune via Hypeddit", label: "Free gate · Hypeddit" });
  expect(downloadStatus(t({ purchase_url: "https://droploud.com/x" })).kind).toBe("gate");
  expect(downloadStatus(t({ purchase_url: "https://www.toneden.io/x/post/y" })).kind).toBe("gate");
  // An unknown host whose button says "free download" is treated as a gate.
  expect(downloadStatus(t({ purchase_url: "https://example-gate.net/x", purchase_title: "Free DL!" })).kind).toBe("gate");
});

test("stores, pre-orders and other links are never downloads", () => {
  const beatport = downloadStatus(t({ purchase_url: "https://www.beatport.com/release/x/1", purchase_title: "Buy" }));
  expect(beatport).toMatchObject({ kind: "store", site: "Beatport", actionLabel: "Buy Tune on Beatport" });
  expect(isFreeDownload(beatport)).toBe(false);
  // The button text beats the host: a Beatport link labelled PRE ORDER.
  expect(downloadStatus(t({ purchase_url: "https://www.beatport.com/x", purchase_title: "PRE ORDER" })).kind).toBe("preorder");
  expect(downloadStatus(t({ purchase_url: "https://label.bandcamp.com/track/x" })).site).toBe("Bandcamp");
  expect(downloadStatus(t({ purchase_url: "https://tszr.lnk.to/x", purchase_title: "BUY/STREAM" })).kind).toBe("link");
  expect(downloadStatus(t({ purchase_url: "https://www.patreon.com/x" })).kind).toBe("link");
});

test("blocked outranks everything; nothing offered says why", () => {
  expect(downloadStatus(t({ access: "blocked", downloadable: true, download_url: "https://api.soundcloud.com/tracks/1/download" })).kind).toBe("blocked");
  expect(downloadStatus(t({ access: "preview" })).reason).toMatch(/preview/i);
  expect(downloadStatus(t()).reason).toMatch(/hasn't enabled downloads/);
  expect(downloadStatus(t({ purchase_url: "javascript:alert(1)" })).kind).toBe("none");
});

test("store search links are searches built from artist and title", () => {
  const links = storeSearchLinks(t({ title: "Tune & Co" }));
  expect(links.map((l) => l.site)).toEqual(["Beatport", "Bandcamp", "Traxsource"]);
  expect(links[0].href).toBe("https://www.beatport.com/search?q=Artist%20Tune%20%26%20Co");
});

test("filters: downloadable keeps a blocked track that had a link, so it can still be removed", () => {
  const blockedWithLink = t({ access: "blocked", download_url: "https://api.soundcloud.com/tracks/1/download" });
  const blockedBare = t({ access: "blocked" });
  expect(matchesFilter(downloadStatus(blockedWithLink), "downloadable", blockedWithLink)).toBe(true);
  expect(matchesFilter(downloadStatus(blockedBare), "downloadable", blockedBare)).toBe(false);
  const store = t({ purchase_url: "https://www.beatport.com/x" });
  expect(matchesFilter(downloadStatus(store), "buy", store)).toBe(true);
  expect(matchesFilter(downloadStatus(store), "downloadable", store)).toBe(false);
  expect(matchesFilter(downloadStatus(t()), "unavailable", t())).toBe(true);
});
