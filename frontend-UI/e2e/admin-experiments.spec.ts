import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/** The admin console's Experiments tab, against canned /api/admin/experiments* answers. */

const KEY = "guided-first-run";

const EXPERIMENT_FLAG = {
  key: KEY,
  kind: "experiment",
  description: "Dashboard start-here panel for new users who have not completed a write",
  doc: "docs/experiments/2026-11-activation-guided-first-run.md",
  percent: 100,
  percentSource: "setting",
  killed: false,
  start: "2026-12-01T00:00:00.000Z",
  end: "2026-12-15T00:00:00.000Z",
  variants: [
    { name: "control", weight: 50 },
    { name: "guided", weight: 50 },
  ],
  newUsersOnly: true,
  guard: null,
  problems: [] as string[],
  gate: null,
};

/** A rollout flag, to show the gate column. None ships in the registry. */
const ROLLOUT_FLAG = {
  key: "sample-rollout",
  kind: "rollout",
  description: "A feature in staged rollout",
  doc: null,
  percent: 10,
  percentSource: "setting",
  killed: false,
  start: null,
  end: null,
  variants: null,
  newUsersOnly: false,
  guard: { actions: ["sample-apply"], maxErrorRatePct: 10, minOperations: 20, windowHours: 24 },
  problems: [] as string[],
  gate: { status: "halt", actions: ["sample-apply"], windowHours: 24, operations: 40, errors: 9, errorRatePct: 22.5, maxErrorRatePct: 10, minOperations: 20 },
};

const arm = (variant: string, over: Record<string, unknown> = {}) => ({
  variant,
  weight: 50,
  enrolled: 400,
  enrolledEver: 404,
  deletedSinceEnrolment: 4,
  windowComplete: 400,
  activated: 120,
  activationRate: 0.3,
  operations: 900,
  operationErrors: 45,
  operationErrorRate: 0.05,
  usersWithError: 30,
  usersWithErrorRate: 0.075,
  feedbackSubmissions: 6,
  feedbackUsers: 5,
  bugFeedbackUsers: 2,
  bugFeedbackUsersRate: 0.005,
  ...over,
});

const FINAL_READOUT = {
  key: KEY,
  config: EXPERIMENT_FLAG,
  windowDays: 7,
  generatedAt: "2026-12-23T00:00:00.000Z",
  status: "final",
  readyAt: "2026-12-22T00:00:00.000Z",
  variants: [
    arm("control"),
    arm("guided", { enrolled: 410, enrolledEver: 411, deletedSinceEnrolment: 1, windowComplete: 410, activated: 164, activationRate: 0.4, operations: 1100, operationErrors: 44, operationErrorRate: 0.04 }),
  ],
  srm: { basis: "enrolledEver", observed: [404, 411], expected: [407.5, 407.5], chi2: 0.06, pValue: 0.8063 },
  test: { controlRate: 0.3, treatmentRate: 0.4, difference: 0.1, z: 2.981, pValue: 0.0029, ci95: [0.0345, 0.1655] },
  guardrailTests: {
    usersWithError: { controlRate: 0.075, treatmentRate: 0.0707, difference: -0.0043, z: -0.234, pValue: 0.815, ci95: [-0.0402, 0.0316] },
    bugFeedbackUsers: null,
  },
};

const ENROLLING_READOUT = {
  ...FINAL_READOUT,
  status: "enrolling",
  variants: [arm("control", { windowComplete: 80, activated: 24 }), arm("guided", { windowComplete: 82, activated: 30, activationRate: 0.366 })],
  test: null,
  guardrailTests: null,
};

const NOT_STARTED_FLAG = { ...EXPERIMENT_FLAG, percent: 0, percentSource: "default", start: null, end: null };
const NOT_STARTED_READOUT = {
  ...FINAL_READOUT,
  config: NOT_STARTED_FLAG,
  status: "not-started",
  readyAt: null,
  variants: ["control", "guided"].map((variant) =>
    arm(variant, {
      enrolled: 0, enrolledEver: null, deletedSinceEnrolment: null, windowComplete: 0, activated: 0, activationRate: null,
      operations: 0, operationErrors: 0, operationErrorRate: null, usersWithError: 0, usersWithErrorRate: null,
      feedbackSubmissions: 0, feedbackUsers: 0, bugFeedbackUsers: 0, bugFeedbackUsersRate: null,
    }),
  ),
  srm: null,
  test: null,
  guardrailTests: null,
};

/** The per-arm table, as opposed to the flag list above it. */
const arms = (main: Locator) => main.getByRole("region", { name: "Results by arm" });

async function open(page: Page, { flags, readout }: { flags: unknown[]; readout: unknown }) {
  const seen: string[] = [];
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "cole", displayName: "Cole", avatarUrl: null, isAdmin: true, canDownload: true }) }),
  );
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route((url) => url.pathname === "/api/admin/experiments", (route) => { seen.push(new URL(route.request().url()).pathname); return route.fulfill(json({ generatedAt: "2026-12-23T00:00:00.000Z", flags })); });
  await page.route((url) => url.pathname === `/api/admin/experiments/${KEY}/readout`, (route) => { seen.push(new URL(route.request().url()).pathname); return route.fulfill(json(readout)); });
  await page.goto("/admin/#experiments");
  await expect(page.getByRole("tab", { name: /Experiments/ })).toHaveAttribute("aria-selected", "true");
  return seen;
}

test("as shipped: the flag is listed at 0% from its default, and the readout has not started", async ({ page }) => {
  const seen = await open(page, { flags: [NOT_STARTED_FLAG], readout: NOT_STARTED_READOUT });
  const main = page.getByRole("tabpanel");
  const flagRow = main.getByRole("row", { name: /guided-first-run/ }).first();
  await expect(flagRow).toContainText("experiment");
  await expect(flagRow).toContainText("0% · default");
  await expect(main.getByText("Not started", { exact: true })).toBeVisible();
  await expect(main.getByText("Nothing to check yet.")).toBeVisible();
  await expect(main.getByText(/Withheld until the readout is final/)).toBeVisible();
  expect(seen).toContain("/api/admin/experiments");
  expect(seen).toContain(`/api/admin/experiments/${KEY}/readout`);
});

test("while enrolling: per-arm counts and guardrails are shown and the comparison is withheld", async ({ page }) => {
  await open(page, { flags: [EXPERIMENT_FLAG], readout: ENROLLING_READOUT });
  const main = page.getByRole("tabpanel");
  await expect(main.getByText("Enrolling", { exact: true })).toBeVisible();
  await expect(main.getByText(/These numbers are interim/)).toBeVisible();
  const guided = arms(main).getByRole("row", { name: /^guided/ });
  await expect(guided).toContainText("36.6%");
  await expect(main.getByText(/Withheld until the readout is final/)).toBeVisible();
  await expect(main.getByText(/two-sided p/)).toHaveCount(0);
});

test("final: enrolled, activated, the rate and the guardrails per arm, then the test", async ({ page }) => {
  await open(page, { flags: [EXPERIMENT_FLAG, ROLLOUT_FLAG], readout: FINAL_READOUT });
  const main = page.getByRole("tabpanel");

  await expect(main.getByRole("row", { name: /guided-first-run/ }).first()).toContainText("100% · setting");
  await expect(main.getByText("Final", { exact: true })).toBeVisible();

  const control = arms(main).getByRole("row", { name: /^control/ });
  await expect(control.getByRole("cell").nth(0)).toHaveText("400");
  await expect(control.getByRole("cell").nth(1)).toHaveText("404(4 deleted)");
  await expect(control.getByRole("cell").nth(2)).toHaveText("400");
  await expect(control.getByRole("cell").nth(3)).toHaveText("120");
  await expect(control.getByRole("cell").nth(4)).toHaveText("30.0%");
  await expect(control.getByRole("cell").nth(5)).toHaveText("900");
  await expect(control.getByRole("cell").nth(6)).toHaveText("5.0%(45)");
  await expect(control.getByRole("cell").nth(7)).toHaveText("30(7.5%)");
  await expect(control.getByRole("cell").nth(8)).toHaveText("6(5 people)");
  await expect(control.getByRole("cell").nth(9)).toHaveText("2(0.5%)");

  const guided = arms(main).getByRole("row", { name: /^guided/ });
  await expect(guided.getByRole("cell").nth(0)).toHaveText("410");
  await expect(guided.getByRole("cell").nth(3)).toHaveText("164");
  await expect(guided.getByRole("cell").nth(4)).toHaveText("40.0%");

  await expect(main.getByText("30.0% → 40.0% · +10.0 pts (95% CI +3.5 pts to +16.6 pts)")).toBeVisible();
  await expect(main.getByText("z = 2.981 · two-sided p = 0.0029")).toBeVisible();
  await expect(main.getByText("404 / 411 against an expected 407.5 / 407.5")).toBeVisible();
  // A guardrail with no test says so instead of showing a blank.
  await expect(main.getByText(/No test: an arm is empty/)).toBeVisible();

  // The rollout flag's gate reads the feature's own error rate against its threshold.
  const rollout = main.getByRole("row", { name: /sample-rollout/ });
  await expect(rollout).toContainText("10% · setting");
  await expect(rollout.getByText("Halt", { exact: true })).toBeVisible();
  await expect(rollout).toContainText("9 of 40 failed in 24h (22.5%) · halt over 10% with 20+");
});

test("a killed flag, a refused setting and a sample-ratio mismatch are each called out", async ({ page }) => {
  await open(page, {
    flags: [{ ...EXPERIMENT_FLAG, killed: true, percent: 0, percentSource: "invalid", problems: ["FLAG_GUIDED_FIRST_RUN_PERCENT is not a whole number from 0 to 100; treated as 0"] }],
    readout: { ...ENROLLING_READOUT, status: "maturing", srm: { basis: "enrolled", observed: [400, 520], expected: [460, 460], chi2: 15.652, pValue: 0.00008 } },
  });
  const main = page.getByRole("tabpanel");
  await expect(main.getByText("Killed", { exact: true })).toBeVisible();
  await expect(main.getByText(/PERCENT is not a whole number from 0 to 100/)).toBeVisible();
  await expect(main.getByText("Maturing", { exact: true })).toBeVisible();
  await expect(main.getByText(/MISMATCH: assignment or exposure logging is wrong/)).toBeVisible();
  await expect(main.getByText(/p = < 0\.0001/)).toBeVisible();
});

test("a readout that fails to load offers a retry", async ({ page }) => {
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "cole", displayName: "Cole", avatarUrl: null, isAdmin: true, canDownload: true }) }),
  );
  await page.route((url) => url.pathname === "/api/admin/experiments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ generatedAt: "", flags: [EXPERIMENT_FLAG] }) }),
  );
  let failing = true;
  await page.route((url) => url.pathname === `/api/admin/experiments/${KEY}/readout`, (route) =>
    failing
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to fetch the experiment readout" }) })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FINAL_READOUT) }),
  );
  await page.goto("/admin/#experiments");
  const main = page.getByRole("tabpanel");
  // The query retries once on its own before it reports the failure.
  await expect(main.getByText("Could not load the readout.")).toBeVisible({ timeout: 15_000 });
  // The flag list above it loaded, and stays.
  await expect(main.getByRole("row", { name: /guided-first-run/ }).first()).toContainText("100% · setting");
  failing = false;
  await main.getByRole("button", { name: "Retry" }).click();
  await expect(main.getByText("Final", { exact: true })).toBeVisible();
});

test("the Experiments tab sits between Downloads and Feedback, under the number it prints", async ({ page }) => {
  await open(page, { flags: [NOT_STARTED_FLAG], readout: NOT_STARTED_READOUT });
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText([
    "1Overview", "2Operations", "3Performance", "4Catalog", "5Downloads", "6Experiments", "7Feedback", "8Archive",
  ]);
  await expect(page.getByText("Press 1–8 to switch sections")).toBeVisible();
  // The number keys index the same list, so 6 is this tab.
  await page.locator("body").press("6");
  await expect(page.getByRole("tab", { name: /Experiments/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/#experiments$/);
});

test("no serious a11y violations and no horizontal overflow", async ({ page }) => {
  await open(page, { flags: [EXPERIMENT_FLAG, ROLLOUT_FLAG], readout: FINAL_READOUT });
  await expect(page.getByRole("tabpanel").getByText("Final", { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500); // reveal animations
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
