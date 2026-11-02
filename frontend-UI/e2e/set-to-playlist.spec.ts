import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";
import { parseSetlist } from "../src/lib/setlist";

/**
 * /set-to-playlist end to end, against the copied text of a real set
 * (fixtures/setlists/head-trip-2026-10-10.txt) and a mocked match API.
 *
 * The mock answers each line with an upload named after that line, except:
 * - line 3 (KMA Productions) — nothing found;
 * - line 9 (Joy Orbison - FELTTTT) — only a 30-second preview, never pre-picked;
 * - line 16 (… (ID Remix)) — only the original, a different version, never pre-picked.
 * At create time the server reports line 4 (CASSIMM) as no longer playable.
 */

const TEXT = fs.readFileSync(path.join(__dirname, "fixtures", "setlists", "head-trip-2026-10-10.txt"), "utf8");
const ENTRIES = parseSetlist(TEXT).entries;
const SOURCE = "https://www.1001tracklists.com/tracklist/23pzf2u1/peggy-gou-four-tet-head-trip-united-states-2026-10-10.html";
const trackId = (position: number) => 5000 + position;

function candidatesFor(position: number) {
  const entry = ENTRIES[position - 1];
  const base = { id: trackId(position), user: { username: entry.artist }, duration: 200000, access: "playable", permalink_url: null, artwork_url: null };
  if (position === 3) return [];
  if (position === 9) return [{ ...base, title: entry.title, access: "preview" }];
  if (position === 16) return [{ ...base, title: "The Funk Phenomena" }];
  return [{ ...base, title: entry.title }];
}

async function open(page: Page) {
  await mockApi(page);
  const created: { body?: { title: string; sourceUrl: string | null; tracks: Array<{ id: number; label: string }> } } = {};
  await page.route((url) => url.pathname === "/api/setlists/match", async (route) => {
    const { entries } = route.request().postDataJSON() as { entries: Array<{ position: number }> };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: entries.map((e) => ({ position: e.position, candidates: candidatesFor(e.position) })) }),
    });
  });
  await page.route((url) => url.pathname === "/api/setlists/playlist", async (route) => {
    created.body = route.request().postDataJSON();
    const tracks = created.body!.tracks;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playlist: { id: 77, title: created.body!.title, permalink_url: "https://soundcloud.com/testuser/sets/head-trip" },
        added: tracks.length - 1,
        missing: [{ id: trackId(4), label: "CASSIMM - Love Desire" }],
        duplicates: [],
        descriptionOmitted: 0,
      }),
    });
  });
  await page.goto("/set-to-playlist/");
  return created;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("paste → review → create: set order, nothing dropped silently", async ({ page }) => {
  const created = await open(page);
  const main = page.locator("main");

  await page.getByRole("textbox", { name: "Tracklist", exact: true }).fill(TEXT);
  await expect(main.getByText(/Found 27 lines: 22 to look up, 5 unidentified \(ID\), and 1 community guess under an ID/)).toBeVisible();

  await page.getByLabel("1001Tracklists link (optional)").fill(SOURCE);
  await expect(page.getByLabel("Playlist name")).toHaveValue("Peggy Gou Four Tet Head Trip United States 2026-10-10");

  await page.getByRole("button", { name: "Find on SoundCloud" }).click();
  await expect(main.getByText("19 will be added · 1 not found · 2 need a pick or are left out · 5 unidentified")).toBeVisible();

  // The preview and the other version wait for the user.
  await expect(page.getByRole("combobox", { name: /^Match for line 9:/ })).toHaveValue("skip");
  await expect(page.getByRole("combobox", { name: /^Match for line 16:/ })).toHaveValue("skip");
  await expect(page.getByRole("combobox", { name: /^Match for line 4:/ })).toHaveValue(String(trackId(4)));

  // The user accepts the preview for line 9.
  await page.getByRole("combobox", { name: /^Match for line 9:/ }).selectOption(String(trackId(9)));
  await expect(main.getByText(/^20 will be added/)).toBeVisible();

  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await noHorizontalOverflow(page);

  await page.getByRole("button", { name: "Create playlist with 20 tracks" }).click();
  await expect(page.getByRole("heading", { name: "Created “Peggy Gou Four Tet Head Trip United States 2026-10-10”" })).toBeVisible();

  // Sent in set order, with the labels as matched; unidentified, not-found and skipped lines are not sent.
  const sent = created.body!;
  expect(sent.sourceUrl).toBe(SOURCE);
  expect(sent.tracks).toHaveLength(20);
  const positions = sent.tracks.map((t) => t.id - 5000);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(positions).not.toContain(3);
  expect(positions).not.toContain(16);
  expect(sent.tracks.find((t) => t.id === trackId(4))?.label).toBe("CASSIMM - Love Desire");

  // Everything left out is listed, with why.
  const notAdded = main.locator("section", { has: page.getByRole("heading", { name: "Not added (8)" }) });
  await expect(notAdded.getByText("No longer playable on SoundCloud")).toHaveCount(1);
  await expect(notAdded.getByText("Unidentified on the tracklist (ID)")).toHaveCount(5);
  await expect(notAdded.getByText("No match found on SoundCloud")).toHaveCount(1);
  await expect(notAdded.getByText("Left out at review")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Open on SoundCloud/ })).toHaveAttribute("href", "https://soundcloud.com/testuser/sets/head-trip");

  const axeAfter = await new AxeBuilder({ page }).include("main").analyze();
  expect(axeAfter.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await noHorizontalOverflow(page);
});

test("a link that is not 1001Tracklists is refused before anything is sent", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Tracklist", exact: true }).fill("Calyx - House Breaker");
  await page.getByLabel("1001Tracklists link (optional)").fill("https://evil.example/tracklist/x.html");
  await expect(page.getByText("Paste a 1001tracklists.com tracklist link, or leave this empty.")).toBeVisible();
});

test("a rate-limited match says so and keeps what was matched", async ({ page }) => {
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/setlists/match", (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests. Try again later." }) }),
  );
  await page.goto("/set-to-playlist/");
  await page.getByRole("textbox", { name: "Tracklist", exact: true }).fill("Calyx - House Breaker\nRova - Eyes On Me");
  await page.getByRole("button", { name: "Find on SoundCloud" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Too many requests" })).toContainText("0 of 2 lines were matched before it stopped");
});
