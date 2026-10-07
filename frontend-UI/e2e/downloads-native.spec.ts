import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures/api";
// The server's own gate, not a copy of it. The mock below answers exactly as
// /api/proxy-download would, so a fixture `download_url` in a shape the
// server refuses fails this spec — which is the check that was missing when
// SoundCloud moved download_url to `/tracks/soundcloud:tracks:N/download`
// and every native download in production answered 400.
import { isAllowedDownloadUrl } from "../../server/lib/download-utils.js";

const CDN = "https://cf-media.sndcdn.com/e2e-sample-track-1.mp3";

async function mockProxyDownload(
  page: import("@playwright/test").Page,
  answer: (downloadUrl: string) => { status: number; body: unknown },
) {
  const seen: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/proxy-download",
    (route) => {
      const downloadUrl = new URL(route.request().url()).searchParams.get("url") ?? "";
      seen.push(downloadUrl);
      if (!isAllowedDownloadUrl(downloadUrl)) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invalid download URL" }),
        });
      }
      const { status, body } = answer(downloadUrl);
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    },
  );
  return seen;
}

test("a free download sends the fixture's URN-form URL and opens the CDN link it gets back", async ({
  page,
  context,
}) => {
  await mockApi(page);
  await context.route(CDN, (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "audio" }),
  );
  const seen = await mockProxyDownload(page, () => ({ status: 200, body: { url: CDN } }));

  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download Sample Track 1 (free download)" }).click();
  const popup = await popupPromise;

  await expect.poll(() => popup.url()).toBe(CDN);
  expect(seen).toEqual(["https://api.soundcloud.com/tracks/soundcloud:tracks:100/download"]);
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});

test("a refused download is reported in its own row, named, and the empty tab is closed", async ({ page }) => {
  await mockApi(page);
  await mockProxyDownload(page, () => ({
    status: 404,
    body: { error: "SoundCloud has no download for this track. The artist may have turned downloads off." },
  }));

  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Download Sample Track 1 (free download)" }).click();
  const popup = await popupPromise;

  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toContainText("Sample Track 1: SoundCloud has no download for this track.");
  await expect.poll(() => popup.isClosed()).toBe(true);

  // In the row, not the page banner: the alert sits after the row's own
  // download control in document order.
  const row = page.getByRole("button", { name: "Download Sample Track 1 (free download)" });
  const alertAfterRow = await row.evaluate((button, alertEl) =>
    Boolean(button.compareDocumentPosition(alertEl as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    await alert.elementHandle(),
  );
  expect(alertAfterRow).toBe(true);
});
