import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi, FAKE_PLAYLIST_DETAIL } from "./fixtures/api";
// The server's own allowlist: a queued URL the server would refuse fails here.
import { isAllowedDownloadUrl } from "../../server/lib/download-utils.js";

const base = { user: { username: "testartist" }, artwork_url: null as string | null, duration: 200000, access: "playable" };
const direct = (n: number) => ({
  ...base,
  id: n,
  title: `Direct ${n}`,
  permalink_url: `https://soundcloud.com/a/${n}`,
  downloadable: true,
  download_url: `https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`,
});
const TRACKS = [direct(1), direct(2), direct(3), { ...base, id: 9, title: "Gate Nine", permalink_url: "https://soundcloud.com/a/9", purchase_url: "https://hypeddit.com/a/nine" }];
const CDN = (n: number) => `https://cf-media.sndcdn.com/e2e-${n}.mp3?Policy=test`;

type LinksAnswer = (urls: string[]) => { status: number; body: unknown };

async function open(
  page: Page,
  { owner = true, links, multiOk = true }: { owner?: boolean; links?: LinksAnswer; multiOk?: boolean } = {},
) {
  await page.addInitScript((ok) => {
    // Short, but not so short that the helper tab's next navigation cancels
    // the previous file before its response starts (50 ms was flaky; the
    // real gap is 3 s).
    (window as unknown as { __TT_QUEUE_GAP_MS: number }).__TT_QUEUE_GAP_MS = 400;
    // Most tests are about other things: start as a browser that has
    // already allowed multiple downloads. The check has its own tests.
    if (ok) localStorage.setItem("track-toolkit-multi-download-ok", "1");
  }, multiOk);
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/playlists/1", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...FAKE_PLAYLIST_DETAIL, track_count: TRACKS.length, tracks: TRACKS }) }),
  );
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: false, canDownload: owner }),
    }),
  );
  const seen: string[][] = [];
  const answer: LinksAnswer =
    links ??
    ((urls) => ({
      status: 200,
      body: { rateLimited: false, results: urls.map((u) => ({ url: u, status: "ok", link: CDN(Number(u.match(/(\d+)\/download/)![1])) })) },
    }));
  await page.route((url) => url.pathname === "/api/downloads/links", async (route: Route) => {
    const urls = (route.request().postDataJSON()?.urls ?? []) as string[];
    seen.push(urls);
    if (!urls.every((u) => isAllowedDownloadUrl(u))) {
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Invalid" }) });
    }
    const { status, body } = answer(urls);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.context().route("https://cf-media.sndcdn.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/mpeg", headers: { "content-disposition": 'attachment; filename="track.mp3"' }, body: "ID3" }),
  );
  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  return seen;
}

const panel = (page: Page) =>
  page.getByRole("region", { name: "Download queue" }).or(page.getByRole("dialog", { name: "Download queue" })).first();

test("Download all queues SoundCloud's own downloads only, hands each file to one helper tab, and says when it's done", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the side panel is the desktop layout; the sheet has its own test");
  const seen = await open(page);

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  const helper = await popupPromise;
  const downloads: string[] = [];
  helper.on("download", (d) => downloads.push(d.url()));

  await expect(panel(page).getByText("3 started · 0 not available · 0 failed")).toBeVisible();
  await expect.poll(() => downloads.length).toBe(3);
  expect(downloads).toEqual([CDN(1), CDN(2), CDN(3)]);
  expect(seen).toEqual([[1, 2, 3].map((n) => `https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`)]);
  await expect(page.locator("#app-live-region-assertive")).toHaveText(/Download queue finished: 3 started, 0 not available, 0 failed/);
});

test("a rate limit pauses with a reason; the queue survives a reload and Resume finishes it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test; layout covered elsewhere");
  let limited = true;
  await open(page, {
    links: (urls) => ({
      status: 200,
      body: limited
        ? { rateLimited: true, results: urls.map((u, i) => (i === 0 ? { url: u, status: "ok", link: CDN(1) } : { url: u, status: "rate_limited" })) }
        : { rateLimited: false, results: urls.map((u) => ({ url: u, status: "ok", link: CDN(Number(u.match(/(\d+)\/download/)![1])) })) },
    }),
  });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await popupPromise;

  await expect(panel(page).getByText(/SoundCloud asked us to slow down/)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Resume (2 left)" })).toBeVisible();

  await page.reload();
  limited = false;
  await expect(panel(page).getByRole("button", { name: "Resume (2 left)" })).toBeVisible();
  await expect(panel(page).getByText(/reloaded|slow down/)).toBeVisible();

  const resumed = page.waitForEvent("popup");
  await panel(page).getByRole("button", { name: "Resume (2 left)" }).click();
  await resumed;
  await expect(panel(page).getByText("3 started · 0 not available · 0 failed")).toBeVisible();
});

test("a refusal from the server stops the queue and says why", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page, { links: () => ({ status: 403, body: { error: "Bulk downloads are limited to allow-listed accounts." } }) });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await popupPromise;
  await expect(panel(page).getByText("Bulk downloads are limited to allow-listed accounts.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Resume (3 left)" })).toBeVisible();
});

test("accounts without download access get no Download all", async ({ page }) => {
  await open(page, { owner: false });
  await expect(page.getByRole("button", { name: "Download all (3)" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download Direct 1 (free download)" })).toBeVisible();
});

test("on a phone the queue is a bar that opens a sheet — axe-clean, no overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile layout only");
  // No entrance animation: axe measuring a sheet mid-fade reads blended colours.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await popupPromise;
  const bar = page.getByRole("button", { name: /^Download queue · / });
  await expect(bar).toBeVisible();
  const axe = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  const serious = (r: Awaited<ReturnType<AxeBuilder["analyze"]>>) =>
    r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  // The page with its queue bar…
  await page.mouse.move(0, 0);
  expect(serious(await axe().analyze())).toEqual([]);
  await bar.click();
  const sheet = page.getByRole("dialog", { name: "Download queue" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Direct 2")).toBeVisible();

  // …and the sheet itself. Scoped: behind an open modal the page is inert
  // and dimmed by the backdrop, so measuring its colours there is noise.
  expect(serious(await axe().include('[role="dialog"]').analyze())).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("first time in a browser: after the second file the queue stops and asks whether it saved", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  const seen = await open(page, { multiOk: false });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  const helper = await popupPromise;
  const downloads: string[] = [];
  helper.on("download", (d) => downloads.push(d.url()));

  const check = panel(page).getByText("Did “Direct 2” save?");
  await expect(check).toBeVisible();
  await expect(panel(page).getByText(/This site is trying to download multiple files/)).toBeVisible();
  // Only two links were asked for — the third is not fetched (or logged as
  // downloaded) while Chrome may be holding the second.
  expect(seen).toEqual([[1, 2].map((n) => `https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`)]);
  await expect(page.locator("#app-live-region-assertive")).toHaveText(/did Direct 2 save\?/);

  await panel(page).getByRole("button", { name: "Yes, it saved — continue" }).click();
  await expect(panel(page).getByText("3 started · 0 not available · 0 failed")).toBeVisible();
  await expect.poll(() => downloads.length).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem("track-toolkit-multi-download-ok"))).toBe("1");
});

test("“No — try it again” hands the same file to the browser again", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  const seen = await open(page, { multiOk: false });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  const helper = await popupPromise;
  const downloads: string[] = [];
  helper.on("download", (d) => downloads.push(d.url()));

  await expect(panel(page).getByText("Did “Direct 2” save?")).toBeVisible();
  await panel(page).getByRole("button", { name: "No — try it again" }).click();
  await expect(panel(page).getByText("Did “Direct 2” save?")).toBeVisible();
  expect(seen[1]).toEqual(["https://api.soundcloud.com/tracks/soundcloud:tracks:2/download"]);
  await expect.poll(() => downloads.filter((u) => u === CDN(2)).length).toBe(2);
});
