import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi, FAKE_PLAYLIST_DETAIL } from "./fixtures/api";

const base = { user: { username: "testartist" }, artwork_url: null as string | null, duration: 200000, access: "playable" };
const TRACKS = [{ ...base, id: 9, title: "Gate Nine", permalink_url: "https://soundcloud.com/a/9", purchase_url: "https://hypeddit.com/a/nine" }];

const item = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Track ${id}`,
  artist: `Artist ${id}`,
  site: "droploud",
  gateUrl: `https://droploud.com/a/${id}`,
  status: "waiting",
  ...over,
});
const track = (id: number) => ({ id, title: `Track ${id}`, artist: `Artist ${id}` });

const SUMMARY = {
  runId: "r1",
  startedAt: 1,
  endedAt: 2,
  gates: 9,
  downloaded: 8,
  failed: 1,
  counts: { follow: 9, like: 9, comment: 9, repost: 9, emailSignup: 3, smsSignup: 1 },
  commentText: "fire",
  tracks: { follow: [track(1)], like: [track(1)], comment: [track(2)], repost: [track(1)], emailSignup: [track(1), track(2), track(3)], smsSignup: [track(4)] },
  actionsWithoutFile: [{ ...track(5), site: "cobrand", reason: "no download after unlock" }],
};

const payload = (over: Record<string, unknown> = {}) => ({
  version: 2,
  total: 4,
  index: 2,
  completed: 1,
  failed: 1,
  active: true,
  failures: [],
  downloadedCount: 1,
  skipped: 0,
  runId: "r1",
  notice: "Keep the lid open while this runs",
  items: [
    item(1, { status: "done" }),
    item(2, { status: "running", step: "repost" }),
    item(3, { status: "failed", reason: "Droploud never unlocked the download" }),
    item(4, { status: "waiting", site: "cobrand", gateUrl: "https://drop.cobrand.com/a/4" }),
  ],
  ...over,
});

async function open(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("sc-toolkit-ext-installed", "1.0");
    const posted: unknown[] = [];
    (window as unknown as { __posted: unknown[] }).__posted = posted;
    window.addEventListener("message", (e) => {
      if (typeof e.data?.type === "string" && e.data.type.startsWith("sc-toolkit-") && e.data.type !== "sc-toolkit-queue-set") posted.push(e.data);
    });
  });
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/playlists/1", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...FAKE_PLAYLIST_DETAIL, track_count: TRACKS.length, tracks: TRACKS }) }),
  );
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: false, canDownload: true }),
    }),
  );
  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
}

const send = (page: Page, detail: unknown) =>
  page.evaluate((d) => window.dispatchEvent(new CustomEvent("sc-toolkit-progress-update", { detail: d })), detail);

const posted = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return (window as unknown as { __posted: unknown[] }).__posted;
  });

/** The panel: the side column on desktop, the sheet behind the bar below. */
async function gatePanel(page: Page, desktop: boolean) {
  if (desktop) return page.getByRole("region", { name: "Download queue" });
  await page.getByRole("button", { name: /^Download queue · / }).click();
  const sheet = page.getByRole("dialog", { name: "Download queue" });
  await expect(sheet).toBeVisible();
  return sheet;
}

const serious = (r: Awaited<ReturnType<AxeBuilder["analyze"]>>) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
const axe = (page: Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("a v2 run shows one row per gate with its status, step and reason — axe-clean, no overflow, at every width", async ({ page }, testInfo) => {
  const desktop = testInfo.project.name === "desktop";
  await open(page);
  await send(page, payload());
  if (desktop) {
    await page.mouse.move(0, 0);
    expect(serious(await axe(page).analyze())).toEqual([]);
  }
  const panel = await gatePanel(page, desktop);
  await expect(panel.getByRole("heading", { name: "Gates" })).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "Working gates" })).toBeVisible();
  await expect(panel.getByText("Keep the lid open while this runs")).toBeVisible();
  const rows = panel.getByRole("list", { name: "Gates" }).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText("Droploud · reposting");
  await expect(rows.nth(1)).toContainText("Running");
  await expect(rows.nth(2)).toContainText("Droploud never unlocked the download");
  await expect(rows.nth(2).getByRole("button", { name: /^Retry/ })).toBeVisible();
  await expect(rows.nth(0).getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  const open1 = rows.nth(3).getByRole("link", { name: /^Open gate/ });
  await expect(open1).toHaveAttribute("href", "https://drop.cobrand.com/a/4");
  await expect(open1).toHaveAttribute("target", "_blank");
  await expect(open1).toHaveAttribute("rel", /noopener/);

  await page.mouse.move(0, 0);
  expect(serious(await axe(page).include(desktop ? "aside" : '[role="dialog"]').analyze())).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // A summary adds its own blocks; same checks.
  await send(
    page,
    payload({
      active: false,
      summary: SUMMARY,
      items: [
        item(1, { status: "done" }),
        item(2, { status: "done" }),
        item(3, { status: "failed", reason: "Droploud never unlocked the download" }),
        item(4, { status: "done", site: "cobrand", gateUrl: "https://drop.cobrand.com/a/4" }),
      ],
    }),
  );
  await expect(panel.getByText("This run: 9 gates")).toBeVisible();
  expect(serious(await axe(page).include(desktop ? "aside" : '[role="dialog"]').analyze())).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("a v1 payload keeps the counts banner and adds no gate section", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page);
  await send(page, { total: 5, index: 2, completed: 2, failed: 1, active: true });
  const bar = page.getByRole("progressbar", { name: "Downloading" });
  await expect(bar).toBeVisible();
  await expect(page.getByText("1 failed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gates" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Download queue" })).toHaveCount(0);
  // Garbage changes nothing and throws nothing.
  await send(page, "nonsense");
  await send(page, null);
  await expect(bar).toBeVisible();
});

test("each control posts its contract message; Clear asks first", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page);
  const panel = page.getByRole("region", { name: "Download queue" });

  await send(page, payload());
  await panel.getByRole("button", { name: /^Stop gates/ }).click();
  await panel.getByRole("button", { name: /^Retry failed gates/ }).click();
  await panel.getByRole("button", { name: "Retry Track 3" }).click();
  expect(await posted(page)).toEqual([
    { type: "sc-toolkit-stop" },
    { type: "sc-toolkit-retry-failed" },
    { type: "sc-toolkit-retry-failed", ids: [3] },
  ]);

  await send(page, payload({ active: false }));
  await expect(panel.getByRole("button", { name: /^Stop gates/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Resume gates" }).click();

  await panel.getByRole("button", { name: "Clear gates" }).click();
  const dialog = page.getByRole("dialog", { name: "Clear the gate queue?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const before = (await posted(page)) as Array<{ type: string }>;
  expect(before.map((m) => m.type)).not.toContain("sc-toolkit-clear");
  await panel.getByRole("button", { name: "Clear gates" }).click();
  await dialog.getByRole("button", { name: "Clear gates" }).click();
  const after = (await posted(page)) as Array<{ type: string }>;
  expect(after.map((m) => m.type)).toEqual(["sc-toolkit-stop", "sc-toolkit-retry-failed", "sc-toolkit-retry-failed", "sc-toolkit-resume", "sc-toolkit-clear"]);
  await expect(page.getByRole("heading", { name: "Gates" })).toHaveCount(0);
});

test("the summary expands each count, lists actions without a file, and copies", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await send(page, payload({ active: false, summary: SUMMARY }));
  const panel = page.getByRole("region", { name: "Download queue" });

  const emails = panel.getByRole("button", { name: "3 email signups" });
  await expect(emails).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByRole("list", { name: "3 email signups, tracks" })).toBeHidden();
  await emails.click();
  await expect(emails).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("list", { name: "3 email signups, tracks" }).getByRole("listitem")).toHaveCount(3);
  await expect(panel.getByRole("button", { name: /9 comments/ })).toContainText("“fire”");
  await expect(panel.getByRole("button", { name: "1 SMS signup" })).toBeVisible();
  await emails.click();
  await expect(emails).toHaveAttribute("aria-expanded", "false");

  await expect(panel.getByRole("heading", { name: "Actions done without a file" })).toBeVisible();
  await expect(panel.getByText("no download after unlock")).toBeVisible();

  await panel.getByRole("button", { name: "Copy summary" }).click();
  await expect(page.locator("#app-live-region")).toHaveText("Summary copied");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("This run: 9 gates · followed 9 artists");
  expect(clip).toContain("Actions done without a file:");
});

const withStatus = (id: number, over: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  payload({ notice: undefined, ...extra, items: payload().items.map((i) => (i.id === id ? { ...i, ...over } : i)) });

test("a gate landing on done is announced, a step change is not, a stop says paused, and only an emptied run says finished", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page);
  const polite = page.locator("#app-live-region");
  const assertive = page.locator("#app-live-region-assertive");
  await send(page, payload({ notice: undefined }));
  // The progress bar's own quarter-mark announcement is all there is yet.
  await expect(polite).toHaveText("Working gates \u2014 50% complete");
  // Step change only: nothing new.
  await send(page, withStatus(2, { step: "verifying" }));
  await page.waitForTimeout(300);
  await expect(polite).toHaveText("Working gates \u2014 50% complete");
  await send(page, withStatus(2, { status: "done", step: undefined }));
  await expect(polite).toHaveText("Track 2 done");
  // Stopped with a gate still waiting: paused, never finished.
  await send(page, withStatus(2, { status: "done", step: undefined }, { active: false, summary: SUMMARY }));
  await expect(polite).toHaveText("Gates paused");
  await expect(assertive).not.toHaveText(/finished/);
  // A paused run's summary is what happened so far, not the run's total.
  await expect(page.getByText("So far: 9 gates")).toBeVisible();
  // Resumed, then everything settles.
  await send(page, withStatus(2, { status: "done", step: undefined }));
  const settled = payload({ notice: undefined, active: false, items: payload().items.map((i) => ({ ...i, status: i.id === 3 ? "failed" : "done", step: undefined })) });
  await send(page, settled);
  await expect(assertive).toHaveText("Gate run finished: 3 done, 1 failed");
});

test("reloading with a finished run in storage says nothing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page);
  const finished = payload({ active: false, notice: undefined, items: payload().items.map((i) => ({ ...i, status: "done", step: undefined })), summary: SUMMARY });
  await page.evaluate((d) => localStorage.setItem("sc-toolkit-hypeddit-progress", JSON.stringify(d)), finished);
  await page.reload();
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await expect(page.getByRole("region", { name: "Download queue" }).getByText("This run: 9 gates")).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator("#app-live-region")).not.toHaveText(/done|finished|paused/);
  await expect(page.locator("#app-live-region-assertive")).not.toHaveText(/finished/);
});

test("Clear on a gate-only run (phone): the sheet closes first, the page scrolls, focus lands on something real, a late summary stays gone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "m390", "phone flow");
  await open(page);
  await send(page, payload({ active: false }));
  await page.getByRole("button", { name: /^Download queue · / }).click();
  const sheet = page.getByRole("dialog", { name: "Download queue" });
  await sheet.getByRole("button", { name: "Clear gates" }).click();
  const confirm = page.getByRole("dialog", { name: "Clear the gate queue?" });
  await expect(confirm).toBeVisible();
  // Never two modals at once.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await confirm.getByRole("button", { name: "Clear gates" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Download queue · / })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await expect.poll(() => page.evaluate(() => document.activeElement?.isConnected === true && document.activeElement !== document.body)).toBe(true);
  expect((await posted(page)) as Array<{ type: string }>).toEqual([{ type: "sc-toolkit-clear" }]);
  // The extension's lingering summary for the cleared run does not bring it back.
  await send(page, payload({ active: false, summary: SUMMARY }));
  await expect(page.getByRole("button", { name: /^Download queue · / })).toHaveCount(0);
  // A new run does.
  await send(page, payload({ runId: "r2" }));
  await expect(page.getByRole("button", { name: /^Download queue · / })).toBeVisible();
});

test("Escape on the clear confirm closes only that dialog", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "m390", "phone flow");
  await open(page);
  await send(page, payload({ active: false }));
  await page.getByRole("button", { name: /^Download queue · / }).click();
  await page.getByRole("dialog", { name: "Download queue" }).getByRole("button", { name: "Clear gates" }).click();
  await expect(page.getByRole("dialog", { name: "Clear the gate queue?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});
