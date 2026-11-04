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
const DROPLOUD_TEN = { ...base, id: 10, title: "Droploud Ten", permalink_url: "https://soundcloud.com/a/10", purchase_url: "https://droploud.com/a/ten", purchase_title: "FREE DOWNLOAD" };
const CDN = (n: number) => `https://cf-media.sndcdn.com/e2e-${n}.mp3?Policy=test`;

type LinksAnswer = (urls: string[]) => { status: number; body: unknown };

/**
 * `window.showDirectoryPicker` for the test: "none" removes it (the browser
 * downloads flow — Chromium has the real one, which would open a native
 * dialog), "fake" grants an in-memory folder that records every file written
 * under `window.__ttFolder`, "cancel" is the user closing the picker.
 */
type Picker = "none" | "fake" | "cancel";
type FolderRecord = { picks: number; files: Record<string, string> };

async function open(
  page: Page,
  {
    owner = true,
    tracks = TRACKS,
    links,
    multiOk = true,
    picker = "none",
    cdnStatus = () => 200,
    files = {},
  }: {
    owner?: boolean;
    /** What the source playlist holds. */
    tracks?: typeof TRACKS;
    links?: LinksAnswer;
    multiOk?: boolean;
    picker?: Picker;
    /** The CDN's status for file n, per request (an expired link is a 403). */
    cdnStatus?: (n: number) => number;
    /** What the fake folder already holds when it is picked. */
    files?: Record<string, string>;
  } = {},
) {
  await page.addInitScript(
    ({ ok, picker, files }) => {
      // Short, but not so short that the helper tab's next navigation cancels
      // the previous file before its response starts (50 ms was flaky; the
      // real gap is 3 s).
      (window as unknown as { __TT_QUEUE_GAP_MS: number }).__TT_QUEUE_GAP_MS = 400;
      // Most tests are about other things: start as a browser that has
      // already allowed multiple downloads. The check has its own tests.
      if (ok) localStorage.setItem("track-toolkit-multi-download-ok", "1");

      const record: FolderRecord = { picks: 0, files: { ...files } };
      (window as unknown as { __ttFolder: FolderRecord }).__ttFolder = record;
      const w = window as unknown as { showDirectoryPicker?: () => Promise<unknown> };
      if (picker === "none") {
        Object.defineProperty(w, "showDirectoryPicker", { value: undefined, configurable: true });
        return;
      }
      const decoder = new TextDecoder();
      const fileHandle = (name: string) => ({
        kind: "file",
        name,
        async getFile() {
          return { size: (record.files[name] ?? "").length };
        },
        async createWritable() {
          let buffer = "";
          return new WritableStream<Uint8Array>({
            write(chunk) {
              buffer += decoder.decode(chunk, { stream: true });
            },
            close() {
              record.files[name] = buffer;
            },
          });
        },
      });
      const directory = {
        kind: "directory",
        name: "Fake",
        async getFileHandle(name: string, options?: { create?: boolean }) {
          if (!(name in record.files)) {
            if (!options?.create) throw new DOMException("not found", "NotFoundError");
            record.files[name] = "";
          }
          return fileHandle(name);
        },
        async removeEntry(name: string) {
          if (!(name in record.files)) throw new DOMException("not found", "NotFoundError");
          delete record.files[name];
        },
      };
      Object.defineProperty(w, "showDirectoryPicker", {
        configurable: true,
        value: async () => {
          record.picks++;
          if (picker === "cancel") throw new DOMException("The user aborted a request.", "AbortError");
          return directory;
        },
      });
    },
    { ok: multiOk, picker, files },
  );
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/playlists/1", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...FAKE_PLAYLIST_DETAIL, track_count: tracks.length, tracks }) }),
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
    route.fulfill({
      status: cdnStatus(Number(route.request().url().match(/e2e-(\d+)/)![1])),
      contentType: "audio/mpeg",
      // What SoundCloud's CDN sends: an attachment, and CORS open (verified
      // live 2026-10-08), which is what lets the page fetch the file itself.
      headers: { "content-disposition": 'attachment; filename="track.mp3"', "access-control-allow-origin": "*" },
      body: "ID3",
    }),
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

// postMessage is delivered in a later task than the click that sent it: let it run before reading.
const postedMessages = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return (window as unknown as { __posted: unknown[] }).__posted;
  });

test("a mixed selection goes to the right places: the direct download to the queue, the gates to the extension, nothing before the yes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await page.addInitScript(() => {
    localStorage.setItem("sc-toolkit-ext-installed", "1.0");
    localStorage.setItem("sc-toolkit-ext-gates", "hypeddit,droploud");
    const posted: unknown[] = [];
    (window as unknown as { __posted: unknown[] }).__posted = posted;
    window.addEventListener("message", (e) => {
      if (e.data?.type === "sc-toolkit-queue-set") posted.push(e.data);
    });
  });
  const seen = await open(page, { multiOk: false, picker: "fake", tracks: [...TRACKS, DROPLOUD_TEN] });
  let popups = 0;
  page.on("popup", () => popups++);

  await page.getByRole("checkbox", { name: "Select Direct 1" }).check();
  await page.getByRole("checkbox", { name: "Select Gate Nine" }).check();
  await page.getByRole("checkbox", { name: "Select Droploud Ten" }).check();
  await page.getByRole("button", { name: "Download 3 selected" }).click();

  // The Droploud gate holds the whole selection, the direct download included.
  const dialog = page.getByRole("dialog", { name: "Send these gates to the extension?" });
  await expect(dialog.getByText("1 Droploud gate will follow, like, comment and repost from your SoundCloud account.")).toBeVisible();
  await expect(dialog.getByText(/Cobrand/)).toHaveCount(0);
  // The warning is the dialog's description, so it is read out when it opens.
  await expect(dialog).toHaveAccessibleDescription(/1 Droploud gate will follow, like, comment and repost/);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Cancel keeps the selection, so focus goes back to the button that asked.
  await expect(page.getByRole("button", { name: "Download 3 selected" })).toBeFocused();
  expect(seen).toEqual([]);
  expect((await folderRecord(page)).picks).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("sc-toolkit-hypeddit-queue"))).toBeNull();
  expect(await postedMessages(page)).toEqual([]);

  await page.getByRole("button", { name: "Download 3 selected" }).click();
  await dialog.getByRole("button", { name: "Send to extension" }).click();
  // Sending clears the selection and its button; focus lands somewhere real.
  await expect(page.getByRole("button", { name: "Back to sources" })).toBeFocused();

  // The direct download is the queue's: one link request, one file, no gate in it.
  await expect(panel(page).getByText("1 saved · 0 not available · 0 failed")).toBeVisible();
  expect(seen).toEqual([["https://api.soundcloud.com/tracks/soundcloud:tracks:1/download"]]);
  expect(Object.keys((await folderRecord(page)).files)).toEqual(["testartist - Direct 1.mp3"]);
  expect(popups).toBe(0);

  // The gates are the extension's: the same key, wrapper and message as ever.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sc-toolkit-hypeddit-queue")!));
  expect(stored.queue).toEqual([
    { id: 9, title: "Gate Nine", artist: "testartist", site: "hypeddit", gateUrl: "https://hypeddit.com/a/nine", hypedditUrl: "https://hypeddit.com/a/nine" },
    { id: 10, title: "Droploud Ten", artist: "testartist", site: "droploud", gateUrl: "https://droploud.com/a/ten" },
  ]);
  expect(typeof stored.ts).toBe("number");
  expect(await postedMessages(page)).toEqual([
    { type: "sc-toolkit-queue-set", queue: stored.queue, ts: stored.ts },
  ]);
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

const checkDialog = (page: Page, title = "Direct 2") => page.getByRole("dialog", { name: `Did “${title}” save?` });

test("first time in a browser: after the second file the queue stops and asks whether it saved — as a dialog, on every width", async ({ page }, testInfo) => {
  const seen = await open(page, { multiOk: false });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  const helper = await popupPromise;
  const downloads: string[] = [];
  helper.on("download", (d) => downloads.push(d.url()));

  // The question is a modal, not a card inside a panel the user may never
  // open: live, it sat behind a grey "check needed" bar below `lg` and was
  // never answered.
  const check = checkDialog(page);
  await expect(check).toBeVisible();
  await expect(check.getByText(/This site is trying to download multiple files/)).toBeVisible();
  // Only two links were asked for — the third is not fetched (or logged as
  // downloaded) while Chrome may be holding the second.
  expect(seen).toEqual([[1, 2].map((n) => `https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`)]);
  await expect(page.locator("#app-live-region-assertive")).toHaveText(/did Direct 2 save\?/);

  await check.getByRole("button", { name: "Yes, it saved — continue" }).click();
  await expect(check).toHaveCount(0);
  // The side panel is desktop-only; on a phone the queue bar says it finished.
  const finished =
    testInfo.project.name === "desktop"
      ? panel(page).getByText("3 started · 0 not available · 0 failed")
      : page.getByRole("button", { name: "Download queue · finished" });
  await expect(finished).toBeVisible();
  await expect.poll(() => downloads.length).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem("track-toolkit-multi-download-ok"))).toBe("1");
});

test("Download all while the check is waiting re-asks the question instead of starting over", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  const seen = await open(page, { multiOk: false });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await popupPromise;
  const check = checkDialog(page);
  await expect(check).toBeVisible();

  // Dismissed (Escape) the queue stays put: still two started, nothing fetched.
  await page.keyboard.press("Escape");
  await expect(check).toHaveCount(0);
  await expect(panel(page).getByText("2 started · 0 not available · 0 failed")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /^Resume/ })).toHaveCount(0);

  // The big button brings the question back; it does not replace the queue.
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await expect(check).toBeVisible();
  expect(seen).toHaveLength(1);
  await expect(panel(page).getByText("2 started · 0 not available · 0 failed")).toBeVisible();

  await check.getByRole("button", { name: "Yes, it saved — continue" }).click();
  await expect(panel(page).getByText("3 started · 0 not available · 0 failed")).toBeVisible();
  expect(seen).toHaveLength(2);
});

test("the helper tab — where Chrome's prompt appears — asks the same question, and answering there continues the queue", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page, { multiOk: false });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  const helper = await popupPromise;
  const downloads: string[] = [];
  helper.on("download", (d) => downloads.push(d.url()));

  await expect(checkDialog(page)).toBeVisible();
  await expect(helper.getByText("Did “Direct 2” save?")).toBeVisible();
  await helper.getByRole("button", { name: "Yes, it saved — continue" }).click();

  await expect(checkDialog(page)).toHaveCount(0);
  await expect(panel(page).getByText("3 started · 0 not available · 0 failed")).toBeVisible();
  await expect.poll(() => downloads.length).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem("track-toolkit-multi-download-ok"))).toBe("1");
  // The question is gone from the helper tab; with three files it is already
  // on its "Done" note (the running note comes between, too briefly to pin).
  await expect(helper.getByText("Did “Direct 2” save?")).toHaveCount(0);
  await expect(helper.getByText(/Done — every file has been handed to the browser/)).toBeVisible();
});

test("“No — try it again” hands the same file to the browser again", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  const seen = await open(page, { multiOk: false });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  const helper = await popupPromise;
  const downloads: string[] = [];
  helper.on("download", (d) => downloads.push(d.url()));

  await expect(checkDialog(page)).toBeVisible();
  await checkDialog(page).getByRole("button", { name: "No — try it again" }).click();
  await expect(checkDialog(page)).toBeVisible();
  expect(seen[1]).toEqual(["https://api.soundcloud.com/tracks/soundcloud:tracks:2/download"]);
  await expect.poll(() => downloads.filter((u) => u === CDN(2)).length).toBe(2);
});

const folderRecord = (page: Page) => page.evaluate(() => (window as unknown as { __ttFolder: FolderRecord }).__ttFolder);

test("Save into a folder: files are fetched by the page and written as “Artist - Title.ext”, with no helper tab and no check", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  const seen = await open(page, { multiOk: false, picker: "fake" });
  const folderBox = page.getByRole("checkbox", { name: /Save into a folder/ });
  await expect(folderBox).toBeChecked();
  let popups = 0;
  page.on("popup", () => popups++);

  await page.getByRole("button", { name: "Download all (3)" }).click();
  await expect(panel(page).getByText("3 saved · 0 not available · 0 failed")).toBeVisible();
  await expect(page.locator("#app-live-region-assertive")).toHaveText(/Download queue finished: 3 saved/);

  const record = await folderRecord(page);
  expect(record.picks).toBe(1);
  expect(Object.keys(record.files)).toEqual(["testartist - Direct 1.mp3", "testartist - Direct 2.mp3", "testartist - Direct 3.mp3"]);
  expect(Object.values(record.files)).toEqual(["ID3", "ID3", "ID3"]);
  // Writes are not downloads: Chrome never asks about multiple files, so the
  // queue never stops to ask either, and no tab was opened.
  expect(popups).toBe(0);
  await expect(checkDialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("track-toolkit-multi-download-ok"))).toBeNull();
  // One link per call, each asked for just before its file: a link dies
  // about 90 s after it is issued, and a wav takes longer than that.
  expect(seen).toEqual([1, 2, 3].map((n) => [`https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`]));
});

test("a file the CDN refuses leaves no empty file behind, and Retry failed saves it under its own name", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  let refuse = true;
  await open(page, { picker: "fake", cdnStatus: (n) => (n === 2 && refuse ? 403 : 200) });
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await expect(panel(page).getByText("2 saved · 0 not available · 1 failed")).toBeVisible();
  await expect(panel(page).getByText(/link had expired/)).toBeVisible();
  // Before, the empty file a failed save created stayed, and the retry
  // became "Direct 2 (2).mp3".
  expect(Object.keys((await folderRecord(page)).files)).toEqual(["testartist - Direct 1.mp3", "testartist - Direct 3.mp3"]);

  refuse = false;
  await panel(page).getByRole("button", { name: "Retry failed (1)" }).click();
  await expect(panel(page).getByText("3 saved · 0 not available · 0 failed")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Retry failed/ })).toHaveCount(0);
  const record = await folderRecord(page);
  expect(Object.keys(record.files).sort()).toEqual(["testartist - Direct 1.mp3", "testartist - Direct 2.mp3", "testartist - Direct 3.mp3"]);
  expect(record.picks).toBe(1);
});

test("an empty file left by an interrupted save is written over, not saved beside as (2)", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page, { picker: "fake", files: { "testartist - Direct 1.mp3": "", "testartist - Direct 2.mp3": "ID3 kept" } });
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await expect(panel(page).getByText("3 saved · 0 not available · 0 failed")).toBeVisible();
  const record = await folderRecord(page);
  expect(record.files).toEqual({
    "testartist - Direct 1.mp3": "ID3",
    // A real file of the same name is never overwritten.
    "testartist - Direct 2.mp3": "ID3 kept",
    "testartist - Direct 2 (2).mp3": "ID3",
    "testartist - Direct 3.mp3": "ID3",
  });
});

test("closing the folder picker queues nothing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  const seen = await open(page, { picker: "cancel" });
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await expect(page.locator("#app-live-region-assertive")).toHaveText(/No folder chosen/);
  await expect(panel(page)).toHaveCount(0);
  expect(seen).toEqual([]);
  await expect(page.getByRole("button", { name: "Download all (3)" })).toBeEnabled();
});

test("unticking Save into a folder keeps the browser-download flow, check included", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  await open(page, { multiOk: false, picker: "fake" });
  await page.getByRole("checkbox", { name: /Save into a folder/ }).uncheck();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await popupPromise;
  await expect(checkDialog(page)).toBeVisible();
  expect((await folderRecord(page)).picks).toBe(0);
  // The choice is remembered for next time. (The reload brings the pending
  // check back as a dialog, as it should; dismiss it to reach the page.)
  await page.reload();
  await expect(checkDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await expect(page.getByRole("checkbox", { name: /Save into a folder/ })).not.toBeChecked();
});

test("a folder queue that stops (rate limit, reload) asks for the folder again on Resume and carries on", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flow test");
  let limited = true;
  await open(page, {
    picker: "fake",
    links: (urls) => ({
      status: 200,
      body: limited
        ? { rateLimited: true, results: urls.map((u, i) => (i === 0 ? { url: u, status: "ok", link: CDN(1) } : { url: u, status: "rate_limited" })) }
        : { rateLimited: false, results: urls.map((u) => ({ url: u, status: "ok", link: CDN(Number(u.match(/(\d+)\/download/)![1])) })) },
    }),
  });
  await page.getByRole("button", { name: "Download all (3)" }).click();
  await expect(panel(page).getByText(/SoundCloud asked us to slow down/)).toBeVisible();
  await expect(panel(page).getByText("1 saved · 0 not available · 0 failed")).toBeVisible();

  await page.reload();
  limited = false;
  await expect(panel(page).getByRole("button", { name: "Resume (2 left)" })).toBeVisible();
  await panel(page).getByRole("button", { name: "Resume (2 left)" }).click();
  await expect(panel(page).getByText("3 saved · 0 not available · 0 failed")).toBeVisible();
  // The folder handle does not survive a reload, so Resume picked again; the
  // in-memory folder does not either, so only the two files after it are there.
  const record = await folderRecord(page);
  expect(record.picks).toBe(1);
  expect(Object.keys(record.files)).toEqual(["testartist - Direct 2.mp3", "testartist - Direct 3.mp3"]);
});
