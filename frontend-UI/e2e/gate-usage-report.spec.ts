import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * The page forwards how each extension gate ended to /api/downloads/gate-results.
 * The extension is played by this test: it dispatches the same
 * `sc-toolkit-progress-update` event its content script does.
 */

async function open(page: Page, { canDownload = true } = {}) {
  const posts: Array<{ runId: string; results: Array<Record<string, unknown>> }> = [];
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: false, canDownload }),
    }),
  );
  await page.route((url) => url.pathname === "/api/downloads/gate-results", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ logged: 1, duplicates: 0 }) });
  });
  await page.goto("/dashboard/");
  // Let the layout mount and read auth before the extension "speaks".
  await page.waitForLoadState("networkidle");
  return posts;
}

const progress = (items: unknown[]) => ({ version: 2, runId: "run-e2e-1", total: items.length, items });
const send = (page: Page, detail: unknown) =>
  page.evaluate((d) => window.dispatchEvent(new CustomEvent("sc-toolkit-progress-update", { detail: d })), detail);

test("finished gates are reported once, and a repeat of the same progress sends nothing more", async ({ page }) => {
  const posts = await open(page);
  const p = progress([
    { id: 11, site: "hypeddit", title: "One", artist: "A", status: "done", actions: ["follow"] },
    { id: 12, site: "droploud", title: "Two", artist: "B", status: "failed", reason: "Auto-Allow is off" },
    { id: 13, site: "cobrand", title: "Three", artist: "C", status: "running" },
  ]);
  await send(page, p);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].runId).toBe("run-e2e-1");
  expect(posts[0].results.map((r) => [r.id, r.site, r.status])).toEqual([[11, "hypeddit", "done"], [12, "droploud", "failed"]]);
  expect(posts[0].results[1].reason).toBe("Auto-Allow is off");

  await send(page, p);
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(1);

  // The third finishes: only it goes out.
  await send(page, progress([...p.items.slice(0, 2), { id: 13, site: "cobrand", title: "Three", artist: "C", status: "done" }]));
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].results.map((r) => r.id)).toEqual([13]);
});

test("a tab opened after the run finished reports what the stored progress holds, on any app page", async ({ page }) => {
  const posts: unknown[] = [];
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: false, canDownload: true }) }),
  );
  await page.route((url) => url.pathname === "/api/downloads/gate-results", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ logged: 1, duplicates: 0 }) });
  });
  await page.addInitScript((stored) => {
    if (!localStorage.getItem("sc-toolkit-hypeddit-progress")) localStorage.setItem("sc-toolkit-hypeddit-progress", stored);
  }, JSON.stringify(progress([{ id: 21, site: "hypeddit", title: "Late", artist: "A", status: "done" }])));
  await page.goto("/playlist-health-check/");
  await expect.poll(() => posts.length).toBe(1);
  // And a reload does not send it again: the sent set is kept in storage.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(1);
});

test("an account without download access sends nothing", async ({ page }) => {
  const posts = await open(page, { canDownload: false });
  await send(page, progress([{ id: 31, site: "hypeddit", title: "x", artist: "y", status: "done" }]));
  await page.waitForTimeout(400);
  expect(posts).toHaveLength(0);
});

test("a payload from an old extension (no per-track items) sends nothing", async ({ page }) => {
  const posts = await open(page);
  await send(page, { total: 3, index: 3, completed: 2, failed: 1, active: false });
  await page.waitForTimeout(400);
  expect(posts).toHaveLength(0);
});
