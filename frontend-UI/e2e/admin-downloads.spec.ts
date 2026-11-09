import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/** The admin console's Downloads tab, against canned /api/admin/downloads/* answers. */

const SUMMARY = {
  period: "30d",
  totals: { downloads: 42, failures: 3, tracks: 17, users: 4, extensionUsers: 2 },
  channels: [
    { channel: "direct", downloads: 20, failures: 1, tracks: 9, users: 4 },
    { channel: "hypeddit", downloads: 12, failures: 1, tracks: 8, users: 2 },
    { channel: "droploud", downloads: 7, failures: 1, tracks: 5, users: 1 },
    { channel: "cobrand", downloads: 3, failures: 0, tracks: 3, users: 1 },
  ],
  daily: Array.from({ length: 30 }, (_, i) => ({ date: `Oct ${i + 1}`, direct: i % 4, hypeddit: i % 3, droploud: i % 5 === 0 ? 1 : 0, cobrand: 0 })),
  users: [
    { userId: "u2", username: "friendone", displayName: "Friend One", soundcloudId: 2, direct: 6, hypeddit: 10, droploud: 7, cobrand: 3, failures: 2, lastAt: new Date().toISOString(), usesExtension: true },
    { userId: "u3", username: "directonly", displayName: null, soundcloudId: 3, direct: 14, hypeddit: 0, droploud: 0, cobrand: 0, failures: 1, lastAt: new Date().toISOString(), usesExtension: false },
  ],
};

const TRACKS = {
  tracks: [
    { trackId: "101", title: "A Very Long Track Title That Should Truncate Rather Than Push The Page Wider Than The Screen", artist: "Some Artist", permalinkUrl: "https://soundcloud.com/a/b", downloads: 9, failures: 0, users: 3, channels: ["direct", "hypeddit"], lastAt: new Date().toISOString() },
    { trackId: "102", title: null, artist: null, permalinkUrl: null, downloads: 2, failures: 1, users: 1, channels: ["droploud"], lastAt: new Date().toISOString() },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const EVENTS = {
  events: [
    { operationId: "o1", at: new Date().toISOString(), ok: true, trackId: "101", title: "Get Lucky", artist: "Daft Punk", channel: "hypeddit", via: "extension", reason: null, user: { id: "u2", username: "friendone", displayName: "Friend One" } },
    { operationId: "o2", at: new Date().toISOString(), ok: false, trackId: "102", title: null, artist: null, channel: "droploud", via: "extension", reason: "Auto-Allow is off — turn it on in the options to run Droploud gates", user: { id: "u2", username: "friendone", displayName: "Friend One" } },
    { operationId: "o3", at: new Date().toISOString(), ok: true, trackId: "103", title: "Direct One", artist: "X", channel: "direct", via: "click", reason: null, user: { id: "u3", username: "directonly", displayName: null } },
  ],
  total: 3,
  page: 1,
  pageSize: 25,
};

async function open(page: Page) {
  const seen: string[] = [];
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "cole", displayName: "Cole", avatarUrl: null, isAdmin: true, canDownload: true }) }),
  );
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route((url) => url.pathname === "/api/admin/downloads/summary", (route) => { seen.push(route.request().url()); return route.fulfill(json(SUMMARY)); });
  await page.route((url) => url.pathname === "/api/admin/downloads/tracks", (route) => { seen.push(route.request().url()); return route.fulfill(json(TRACKS)); });
  await page.route((url) => url.pathname === "/api/admin/downloads/events", (route) => { seen.push(route.request().url()); return route.fulfill(json(EVENTS)); });
  await page.goto("/admin/#downloads");
  return seen;
}

test("the Downloads tab shows totals, channels, tracks, people and events", async ({ page }) => {
  await open(page);
  const main = page.getByRole("tabpanel");
  await expect(page.getByRole("tab", { name: /Downloads/ })).toHaveAttribute("aria-selected", "true");
  await expect(main.getByText("Using the extension")).toBeVisible();
  await expect(main.getByText("42", { exact: true })).toBeVisible();
  await expect(main.getByText("8 tracks · 2 people · 1 failed")).toBeVisible();
  await expect(main.getByText("#102 (not in catalog)")).toBeVisible();
  await expect(main.getByText("@friendone").first()).toBeVisible();
  // Only the account that has the extension carries the badge.
  const people = main.locator("tr", { hasText: "@friendone" });
  await expect(people.getByText("extension", { exact: true })).toBeVisible();
  await expect(main.locator("tr", { hasText: "@directonly" }).getByText("extension", { exact: true })).toHaveCount(0);
  await expect(main.getByText(/Auto-Allow is off/)).toBeVisible();
});

test("picking a channel filters the track list through the API, and Events scopes the trail to one account", async ({ page }) => {
  const seen = await open(page);
  const main = page.getByRole("tabpanel");
  await main.getByRole("group", { name: "Channel", exact: true }).getByRole("button", { name: "Droploud" }).click();
  await expect.poll(() => seen.some((u) => u.includes("/downloads/tracks") && u.includes("channel=droploud"))).toBe(true);
  await main.getByRole("button", { name: "Show events for @friendone" }).click();
  await expect.poll(() => seen.some((u) => u.includes("/downloads/events") && u.includes("userId=u2"))).toBe(true);
  await expect(main.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", /downloads\/tracks\?.*format=csv.*|downloads\/tracks\?.*channel=droploud.*format=csv/);
});

test("no serious a11y violations and no horizontal overflow", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("tabpanel").getByText("Using the extension")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500); // reveal animations
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
