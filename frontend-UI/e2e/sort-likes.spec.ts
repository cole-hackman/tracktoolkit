import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * /sort-likes/ end to end against mocked likes, playlists, waveform JSON and
 * the three Sort Likes endpoints. What it pins:
 *  - hotkeys mark, move, skip and undo, and the session survives a reload;
 *  - a label suggestion appears from the track's genre;
 *  - the commit sends each destination its own ids, and unlikes ONLY tracks
 *    every marked destination filed — a failed destination keeps its tracks
 *    liked and marked;
 *  - both preview players mount (own: asks the server for a stream link;
 *    embed: the SoundCloud iframe, stubbed by mockApi);
 *  - no serious axe violations once marked, no horizontal overflow;
 *  - it is admin-only: a non-admin sees "Not available" and no likes are read,
 *    and the tool is in neither the navigation nor the dashboard.
 */

const LIKES = [
  { id: 501, title: "Groove Machine", genre: "Tech House", tag_list: 'ukg "deep house"' },
  { id: 502, title: "Sunny Hook (Someone Remix)", genre: "Pop", tag_list: "" },
  { id: 503, title: "Low End Theory", genre: "Techno", tag_list: "" },
  { id: 504, title: "Night Drive", genre: "Tech House", tag_list: "" },
].map((t) => ({
  ...t,
  user: { username: "artist" },
  artwork_url: null,
  duration: 240000,
  access: "playable",
  permalink_url: `https://soundcloud.com/artist/${t.id}`,
  waveform_url: `https://wave.sndcdn.com/w${t.id}_m.png`,
}));

interface Captured {
  apply: Array<Record<string, unknown>>;
  unlike: number[][];
  stream: number[];
}

const ADMIN_USER = { userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: true };

async function open(page: Page, { failPop = false } = {}): Promise<Captured> {
  await mockApi(page);
  // Sort Likes is admin-only; registered after mockApi, so this answer wins.
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ADMIN_USER) }),
  );
  const captured: Captured = { apply: [], unlike: [], stream: [] };
  await page.route((url) => url.pathname === "/api/likes", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ collection: LIKES, total_results: LIKES.length }) }),
  );
  await page.route("https://wave.sndcdn.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ width: 1800, height: 140, samples: Array.from({ length: 1800 }, (_, i) => (i * 7) % 140) }),
    }),
  );
  await page.route(/\/api\/tracks\/\d+\/stream$/, (route) => {
    captured.stream.push(Number(new URL(route.request().url()).pathname.split("/")[3]));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NO_STREAM", error: "SoundCloud has no playable stream for this track." }) });
  });
  await page.route((url) => url.pathname === "/api/sort/apply", async (route) => {
    const body = route.request().postDataJSON() as { playlistId?: number; title?: string; trackIds: number[] };
    captured.apply.push(body);
    if (failPop && body.title === "Pop Remix") {
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "SoundCloud is having a moment." }) });
    }
    const id = body.playlistId ?? 900;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playlists: [{ id, title: body.title ?? "Sample Playlist 1", permalink_url: `https://soundcloud.com/testuser/sets/${id}`, trackCount: body.trackIds.length, created: !body.playlistId }],
        added: body.trackIds.length,
        alreadyPresent: 0,
        filedTrackIds: body.trackIds,
      }),
    });
  });
  await page.route((url) => url.pathname === "/api/sort/unlike", async (route) => {
    const { trackIds } = route.request().postDataJSON() as { trackIds: number[] };
    captured.unlike.push(trackIds);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: trackIds.map((trackId) => ({ trackId, status: "ok" })), rateLimited: false }),
    });
  });
  await page.goto("/sort-likes/");
  await expect(page.getByTestId("now-sorting")).toBeVisible();
  return captured;
}

async function addDestinations(page: Page) {
  // Existing playlist through the chooser.
  await page.getByRole("button", { name: /Add an existing playlist/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Sample Playlist 1/ }).click();
  // New playlists by name.
  const field = page.getByLabel("Or a new playlist");
  await field.fill("Tech House");
  await field.press("Enter");
  await field.fill("Pop Remix");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("destinations").getByRole("listitem")).toHaveCount(3);
}

async function pressOnPage(page: Page, key: string) {
  // Hotkeys are for the page, not a focused field.
  await page.locator("h1").click();
  await page.keyboard.press(key);
}

test("hotkeys mark, skip and undo; suggestions; the session survives a reload", async ({ page }) => {
  await open(page);
  await addDestinations(page);
  const now = page.getByTestId("now-sorting");
  await expect(now).toHaveAttribute("data-track-id", "501");

  // Genre "Tech House" → the Tech House destination is suggested.
  const mark = (name: RegExp) => now.getByRole("button", { name });
  await expect(mark(/Tech House.*Suggested/)).toBeVisible();

  await pressOnPage(page, "2"); // Tech House
  await expect(mark(/^2 Tech House/)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("marked-total")).toHaveText("1");

  await page.keyboard.press("j");
  await expect(now).toHaveAttribute("data-track-id", "502");
  await expect(mark(/Pop Remix.*Suggested/)).toBeVisible();
  await page.keyboard.press("3");
  await page.keyboard.press("1");
  await expect(page.getByTestId("marked-total")).toHaveText("2");

  await page.keyboard.press("j");
  await expect(now).toHaveAttribute("data-track-id", "503");
  await page.keyboard.press("s"); // decide later, moves on
  await expect(now).toHaveAttribute("data-track-id", "504");
  await page.keyboard.press("z"); // undo the skip, back to 503
  await expect(now).toHaveAttribute("data-track-id", "503");

  await page.reload();
  await expect(page.getByTestId("now-sorting")).toHaveAttribute("data-track-id", "503");
  await expect(page.getByTestId("marked-total")).toHaveText("2");
  await expect(page.getByTestId("destinations").getByRole("listitem")).toHaveCount(3);
});

test("commit: each destination gets its ids; only fully filed tracks are unliked; a failure keeps its marks", async ({ page }) => {
  const captured = await open(page, { failPop: true });
  await addDestinations(page);

  await pressOnPage(page, "2"); // 501 → Tech House
  await page.keyboard.press("j");
  await page.keyboard.press("2"); // 502 → Tech House
  await page.keyboard.press("3"); //       and Pop Remix (will fail)
  await page.keyboard.press("j");
  await page.keyboard.press("1"); // 503 → Sample Playlist 1

  await page.getByLabel(/Remove filed tracks from my likes/).check();
  await page.getByRole("button", { name: /Add 3 tracks to 3 playlists/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("commit-preview").getByRole("listitem")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Add them" }).click();

  const summary = page.getByTestId("commit-summary");
  await expect(summary).toBeVisible();
  await expect(page.locator("main").getByText(/destination failed; their marks are kept/)).toBeVisible();
  await expect(page.locator("main").getByText("3 tracks added to 2 playlists")).toBeVisible();

  const byDest = Object.fromEntries(captured.apply.map((b) => [String(b.playlistId ?? b.title), (b.trackIds as number[]).slice().sort()]));
  expect(byDest).toEqual({ "1": [503], "Tech House": [501, 502], "Pop Remix": [502] });
  // 502 reached Tech House but not Pop Remix, so it stays liked.
  expect(captured.unlike.flat().sort()).toEqual([501, 503]);
  // …and stays marked for Pop Remix, ready to retry.
  await expect(page.getByTestId("marked-total")).toHaveText("1");
});

test("both preview players mount; the waveform loads", async ({ page }) => {
  const captured = await open(page);
  const now = page.getByTestId("now-sorting");
  await expect(now.getByRole("slider", { name: /Seek in Groove Machine/ })).toHaveAttribute("data-waveform", "loaded");

  // Own player: Play asks the server for a stream link and shows its error.
  await now.getByRole("button", { name: /Play/ }).click();
  await expect(now.getByText("SoundCloud has no playable stream for this track.")).toBeVisible();
  expect(captured.stream).toEqual([501]);

  // Embed player: the SoundCloud iframe for the current track.
  await now.getByRole("button", { name: "SoundCloud embed" }).click();
  const frame = now.locator("iframe");
  await expect(frame).toHaveAttribute("title", "SoundCloud player: Groove Machine");
  await expect(frame).toHaveAttribute("src", /w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fsoundcloud\.com%2Fartist%2F501/);
});

test("no serious axe violations with destinations and marks; no horizontal overflow", async ({ page }) => {
  // Before anything moves, not just before the audit. Marking the first track
  // enables the commit button, which then fades from 50% to full opacity over
  // 150 ms (Button: `transition-all duration-150`, `disabled:opacity-50`). axe
  // read the blended colours mid-fade and reported a contrast failure (4.00:1
  // or less; 5.45:1 once settled) in 79 of 80 runs with one worker. Asking
  // for reduced motion after the keypress did not stop a fade already running.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await addDestinations(page);
  await pressOnPage(page, "2");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("admin only: a non-admin gets 'Not available', and nothing is fetched", async ({ page }) => {
  await mockApi(page); // FAKE_USER is not an admin
  const sortCalls: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path === "/api/likes" || path.startsWith("/api/sort/") || /^\/api\/tracks\/\d+\/stream$/.test(path)) sortCalls.push(path);
  });
  await page.goto("/sort-likes/");
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
  await expect(page.getByTestId("now-sorting")).toHaveCount(0);
  expect(sortCalls).toEqual([]);
});

test("not linked from the navigation or the dashboard, even for an admin", async ({ page }) => {
  await open(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('a[href^="/sort-likes"]')).toHaveCount(0);
});

test("select mode: tick a range, mark them all with a button or a hotkey, undo the batch", async ({ page }) => {
  await open(page);
  await addDestinations(page);
  const list = page.getByTestId("sort-list");
  // Off by default: rows are plain buttons, no checkboxes.
  await expect(list.getByRole("checkbox")).toHaveCount(0);

  await page.getByRole("button", { name: "Select tracks" }).click();
  await expect(page.getByRole("button", { name: "Done selecting" })).toHaveAttribute("aria-pressed", "true");
  const boxes = list.getByRole("checkbox");
  await expect(boxes).toHaveCount(4);

  // Click the first, shift-click the third: a range of three.
  await list.getByText("Groove Machine").click();
  await list.getByText("Low End Theory").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("selected-count")).toHaveText("3 selected");

  const bar = page.getByTestId("bulk-bar");
  await bar.getByRole("button", { name: /Tech House/ }).click();
  await expect(page.getByTestId("marked-total")).toHaveText("3");
  // Marked tracks leave Unsorted, but stay selected and are counted.
  await expect(page.getByTestId("selected-count")).toContainText("3 not in this view");
  await expect(bar.getByRole("button", { name: /Tech House/ })).toHaveAttribute("aria-pressed", "true");

  // The hotkey acts on the selection too: 3 = Pop Remix.
  await page.locator("h1").click();
  await page.keyboard.press("3");
  await expect(bar.getByRole("button", { name: /Pop Remix/ })).toHaveAttribute("aria-pressed", "true");

  // One undo reverts the whole Pop Remix batch, the next the Tech House one.
  await page.keyboard.press("z");
  await expect(bar.getByRole("button", { name: /Pop Remix/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("marked-total")).toHaveText("3");
  await page.keyboard.press("z");
  await expect(page.getByTestId("marked-total")).toHaveText("0");

  // Escape clears the selection; leaving the mode removes the checkboxes.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selected-count")).toHaveText("0 selected");
  await page.getByRole("button", { name: "Done selecting" }).click();
  await expect(list.getByRole("checkbox")).toHaveCount(0);
});

test("select mode: no serious axe violations, no horizontal overflow", async ({ page }) => {
  // Before anything moves, for the reason given on the audit above: ticking
  // the first row enables the selection's buttons, and they fade in.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await addDestinations(page);
  await page.getByRole("button", { name: "Select tracks" }).click();
  await page.getByTestId("sort-list").getByText("Groove Machine").click();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
