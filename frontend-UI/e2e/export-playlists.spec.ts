import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

test("export/playlists: the picker searches, stays after a choice, and switching resets the card", async ({ page }) => {
  await mockApi(page);
  await page.goto("/export/playlists/");

  const search = page.getByRole("searchbox", { name: "Search playlists" });
  await expect(search).toBeVisible();
  await search.fill("playlist 2");
  await expect(page.getByText(/^Showing \d+ of \d+ playlists$/)).toBeVisible();

  await search.fill("");
  await page.getByRole("radio", { name: /Sample Playlist 1/ }).check();
  await page.getByRole("button", { name: "Load playlist tracks" }).click();
  await expect(page.getByText(/^[\d,]+ tracks? ready$/)).toBeVisible();
  // The picker is still there beside the export card.
  await expect(search).toBeVisible();

  await page.getByRole("radio", { name: /Sample Playlist 2/ }).check();
  await expect(page.getByRole("radio", { name: /Sample Playlist 2/ })).toBeChecked();
  await expect(page.getByText(/^[\d,]+ tracks? ready$/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load playlist tracks" })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
