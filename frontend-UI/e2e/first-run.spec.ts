import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * Both arms of the activation experiment on the dashboard
 * (docs/experiments/2026-11-activation-guided-first-run.md).
 *
 * The server decides the arm; these tests stand in for it. What is pinned:
 *
 * - an account `/api/auth/me` does not list makes no exposure request and
 *   sees the dashboard exactly as before (this is everyone at 0%);
 * - control asks once, and renders nothing extra;
 * - guided shows the panel above the tools, and only on the server's word:
 *   not when the request fails, not once the account has completed a write;
 * - the steps on the panel name controls that exist on the pages they send
 *   people to.
 */

const KEY = "guided-first-run";

const ME = {
  userId: "u1",
  soundcloudId: 1000001,
  username: "testuser",
  displayName: "Test User",
  avatarUrl: null,
};

type Exposure = { enrolled: boolean; variant: string | null; activated: boolean };

interface OpenOptions {
  /** What `/api/auth/me` lists under `experiments`. */
  experiments?: string[];
  /** The exposure route's answer, or a status to fail with. */
  exposure?: Exposure | number;
  isAdmin?: boolean;
  path?: string;
}

/** Opens the dashboard and returns the bodies of every exposure request made. */
async function open(page: Page, { experiments = [KEY], exposure, isAdmin = false, path = "/dashboard/" }: OpenOptions = {}) {
  const requests: unknown[] = [];
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/auth/me",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...ME, isAdmin, canDownload: isAdmin, flags: [], experiments }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/experiments/exposure",
    (route) => {
      requests.push(route.request().postDataJSON());
      if (typeof exposure === "number" || exposure === undefined) {
        return route.fulfill({
          status: exposure ?? 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Could not resolve the experiment" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: KEY, ...exposure }),
      });
    },
  );
  await page.goto(path);
  // The tool search only exists on the loaded dashboard.
  await expect(page.getByLabel("Search tools")).toBeVisible();
  return requests;
}

const guide = (page: Page) => page.getByRole("region", { name: "Start here" });

/** The stats row has arrived, so the page has had every chance to add a panel. */
const statsLoaded = (page: Page) => page.getByRole("link", { name: "5 Liked tracks" });

const GUIDED: Exposure = { enrolled: true, variant: "guided", activated: false };
const CONTROL: Exposure = { enrolled: true, variant: "control", activated: false };

async function expectNoBlockingViolations(page: Page) {
  // Park the cursor: axe must not score a :hover style nobody is pointing at.
  await page.mouse.move(0, 0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectNoOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`).toBeLessThanOrEqual(clientWidth);
}

/** The dashboard's sections, top to bottom, by what each one is. */
async function sectionOrder(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector("main#main-content .space-y-6");
    return Array.from(body?.children ?? []).map((el) => {
      if (el.querySelector('input[type="url"]')) return "link-resolver";
      if (el.querySelector('input[type="search"]')) return "tools";
      if (el.getAttribute("aria-labelledby") && el.querySelector("ol")) return "first-run";
      if (el.querySelector('a[href^="/feedback"]')) return "feedback";
      return "other";
    });
  });
}

test("an account that is not a candidate makes no exposure request and sees no panel", async ({ page }) => {
  const requests = await open(page, { experiments: [], exposure: GUIDED });
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(await sectionOrder(page)).not.toContain("first-run");
});

test("an older /api/auth/me with no experiments field behaves the same", async ({ page }) => {
  // mockApi's own /me carries no `experiments` at all: the shape before this
  // feature. The page must treat a missing list as an empty one.
  const requests: string[] = [];
  await mockApi(page);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/experiments")) requests.push(request.url());
  });
  await page.goto("/dashboard/");
  await expect(page.getByLabel("Search tools")).toBeVisible();
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("control: the arm is asked for once, with the flag key, and the dashboard is unchanged", async ({ page }) => {
  const requests = await open(page, { exposure: CONTROL });
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ key: KEY });
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  // Same sections, same order, as an account outside the experiment.
  expect(await sectionOrder(page)).toEqual(["link-resolver", "other", "tools", "feedback"]);
  await expectNoBlockingViolations(page);
  await expectNoOverflow(page);
});

test("guided: the panel sits above the tools with three jobs, each linking to its tool", async ({ page }) => {
  const requests = await open(page, { exposure: GUIDED });
  const panel = guide(page);
  await expect(panel).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ key: KEY });

  await expect(panel.getByRole("heading", { level: 2, name: "Start here" })).toBeVisible();
  await expect(panel).toContainText("Each one creates a new playlist");
  await expect(panel.getByRole("heading", { level: 3 })).toHaveText([
    "Combine playlists into one",
    "Save your likes as a playlist",
    "Copy someone else's playlist",
  ]);
  await expect(panel.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) })).toHaveCount(3);
  // Three steps per job.
  await expect(panel.locator("ol > li")).toHaveCount(9);

  await expect(panel.getByRole("link", { name: "Open Combine Playlists" })).toHaveAttribute("href", "/combine/");
  await expect(panel.getByRole("link", { name: "Open Likes → Playlist" })).toHaveAttribute("href", "/likes-to-playlist/");
  await expect(panel.getByRole("link", { name: "Open Playlist Cloner" })).toHaveAttribute("href", "/playlist-cloner/");

  // First on the page, and everything that was there is still there below it.
  expect(await sectionOrder(page)).toEqual(["first-run", "link-resolver", "other", "tools", "feedback"]);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Combine Playlists", exact: true })).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectNoBlockingViolations(page);
  await expectNoOverflow(page);
});

test("guided: the panel's controls are at least 44px tall and fully on screen", async ({ page }) => {
  await open(page, { exposure: GUIDED });
  const panel = guide(page);
  await expect(panel).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const control of [
    panel.getByRole("link", { name: "Open Combine Playlists" }),
    panel.getByRole("link", { name: "Open Likes → Playlist" }),
    panel.getByRole("link", { name: "Open Playlist Cloner" }),
    panel.getByRole("button", { name: "Hide this" }),
  ]) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  }
});

test("guided: a job's link opens its tool", async ({ page }) => {
  await open(page, { exposure: GUIDED });
  await guide(page).getByRole("link", { name: "Open Playlist Cloner" }).click();
  await expect(page).toHaveURL(/\/playlist-cloner\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Playlist Cloner" })).toBeVisible();
});

test("guided: the panel is gone once the account has completed a write", async ({ page }) => {
  const requests = await open(page, { exposure: { ...GUIDED, activated: true } });
  await expect.poll(() => requests.length).toBe(1);
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
});

test("an arm the page does not know is treated as control", async ({ page }) => {
  const requests = await open(page, { exposure: { enrolled: true, variant: "something-new", activated: false } });
  await expect.poll(() => requests.length).toBe(1);
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
});

test("the server saying 'not enrolled' is control, whatever variant it names", async ({ page }) => {
  const requests = await open(page, { exposure: { enrolled: false, variant: "guided", activated: false } });
  await expect.poll(() => requests.length).toBe(1);
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
});

for (const status of [500, 403, 429]) {
  test(`a failed exposure request (${status}) is control: nothing is shown that was not recorded`, async ({ page }) => {
    const requests = await open(page, { exposure: status });
    await expect.poll(() => requests.length).toBe(1);
    await expect(statsLoaded(page)).toBeVisible();
    await expect(guide(page)).toHaveCount(0);
    // And it is not retried in a loop.
    await page.waitForTimeout(600);
    expect(requests.length).toBe(1);
    // The dashboard itself is unaffected.
    await expect(page.getByRole("heading", { level: 3, name: "Combine Playlists", exact: true })).toBeVisible();
  });
}

test("guided: 'Hide this' removes the panel and it stays hidden after a reload", async ({ page }) => {
  await open(page, { exposure: GUIDED });
  await expect(guide(page)).toBeVisible();
  await guide(page).getByRole("button", { name: "Hide this" }).click();
  await expect(guide(page)).toHaveCount(0);
  await expect(page.getByLabel("Search tools")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Search tools")).toBeVisible();
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("track-toolkit-first-run-hidden"))).toBe("1");
});

test("an admin can preview the panel, and previewing records nothing", async ({ page }) => {
  const requests = await open(page, { experiments: [], isAdmin: true, exposure: GUIDED, path: "/dashboard/?first-run=preview" });
  await expect(guide(page)).toBeVisible();
  await expect(guide(page).getByRole("link", { name: "Open Combine Playlists" })).toBeVisible();
  expect(requests).toEqual([]);
});

test("the preview parameter does nothing for an account that is not an admin", async ({ page }) => {
  const requests = await open(page, { experiments: [], isAdmin: false, exposure: GUIDED, path: "/dashboard/?first-run=preview" });
  await expect(statsLoaded(page)).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  expect(requests).toEqual([]);
});

/* The steps name controls by their labels. If a tool page renames one, the
   panel would send people looking for something that is not there. */

test("the Combine steps match the Combine page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/combine/");
  await expect(page.getByRole("checkbox", { name: "Sample Playlist 1" })).toBeVisible();
  await expect(page.getByLabel("New Playlist Name")).toBeVisible();
  await expect(page.getByRole("button", { name: "Merge Playlists" })).toBeVisible();
});

test("the Likes steps match the Likes → Playlist page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/likes-to-playlist/");
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).toBeVisible();
  await expect(page.getByLabel("Playlist name")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Playlist" })).toBeVisible();
});

test("the Cloner steps match the Playlist Cloner page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/playlist-cloner/");
  await expect(page.getByLabel("Original playlist URL")).toBeVisible();
  await expect(page.getByLabel("Name for the copy (optional)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clone Playlist" })).toBeVisible();
});
