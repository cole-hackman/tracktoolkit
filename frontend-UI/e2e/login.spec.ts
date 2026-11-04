import { test, expect, type Page } from "@playwright/test";

/**
 * /login is one card: the logo and tagline come first at every width, and
 * nothing but the consent line sits with the button.
 */

async function signedOut(page: Page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }),
  );
  await page.route("**/health", (route) => route.fulfill({ status: 200, body: "{}" }));
}

test.beforeEach(async ({ page }) => {
  await signedOut(page);
  await page.goto("/login/");
  await expect(page.getByRole("button", { name: "Continue with SoundCloud" })).toBeVisible();
});

test("the logo and tagline stack above the button on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "side by side at 1280");

  const tagline = await page.getByText("Merge playlists, clean up likes").boundingBox();
  const button = await page.getByRole("button", { name: "Continue with SoundCloud" }).boundingBox();
  const logo = await page.getByRole("link", { name: "Track Toolkit home" }).boundingBox();

  expect(logo!.y + logo!.height).toBeLessThan(tagline!.y);
  expect(tagline!.y + tagline!.height).toBeLessThan(button!.y);
});

test("the button and consent text are side by side with the tagline on desktop", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop only");

  const tagline = await page.getByText("Merge playlists, clean up likes").boundingBox();
  const button = await page.getByRole("button", { name: "Continue with SoundCloud" }).boundingBox();

  expect(button!.x).toBeGreaterThan(tagline!.x + tagline!.width);
});

test("the card holds the button and the consent line and no other action", async ({ page }) => {
  const card = page.getByRole("region", { name: "Connect your account" });

  await expect(card.getByText("By connecting, you agree to our")).toBeVisible();
  await expect(card.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
    "href",
    /\/privacy\/?$/,
  );

  await expect(card.getByRole("button")).toHaveCount(1);
  await expect(card.getByRole("link")).toHaveCount(1);
});

test("Terms and Contact stay reachable from the page", async ({ page }) => {
  await expect(page.getByRole("link", { name: "Terms", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact", exact: true })).toBeVisible();
});
