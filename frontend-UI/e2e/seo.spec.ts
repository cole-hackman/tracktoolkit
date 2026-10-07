import { expect, test } from "@playwright/test";

/**
 * Search-facing invariants of the static export, read from the raw HTML a
 * crawler gets (no JavaScript). Each one was wrong on the live site after the
 * tracktoolkit.com move: every public page carried the homepage's og:url, the
 * WebSite JSON-LD advertised a search the site does not have (Google crawled
 * the literal `/?q={search_term_string}`), the 404 emitted two contradictory
 * robots tags, and robots.txt disallowed the same pages that carry noindex, so
 * crawlers could never read the noindex.
 *
 * These are per-document facts, not layout ones, so they run once.
 */
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "per-document facts, not viewport ones");
});

const ORIGIN = "https://tracktoolkit.com";
const PUBLIC_PAGES = ["/", "/about/", "/faq/", "/privacy/", "/terms/", "/accessibility/"];

function metaContent(html: string, attr: "name" | "property", key: string): string[] {
  const re = new RegExp(`<meta[^>]*${attr}="${key}"[^>]*content="([^"]*)"`, "g");
  return [...html.matchAll(re)].map((m) => m[1]);
}

function canonical(html: string): string[] {
  return [...html.matchAll(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/g)].map((m) => m[1]);
}

for (const path of PUBLIC_PAGES) {
  test(`${path} describes itself, not the homepage`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const html = await res.text();

    expect(canonical(html)).toEqual([`${ORIGIN}${path}`]);
    expect(metaContent(html, "property", "og:url")).toEqual([`${ORIGIN}${path}`]);
    expect(metaContent(html, "name", "robots")).toEqual(["index, follow"]);

    const [title] = html.match(/<title>([^<]*)<\/title>/)?.slice(1) ?? [];
    expect(metaContent(html, "property", "og:title")).toEqual([title]);
  });
}

test("no JSON-LD advertises a site search", async ({ request }) => {
  for (const path of PUBLIC_PAGES) {
    const html = await (await request.get(path)).text();
    expect(html, path).not.toContain("SearchAction");
    expect(html, path).not.toContain("search_term_string");
  }
});

for (const path of ["/combine/", "/dashboard/", "/login/", "/extension/connected/"]) {
  test(`${path} carries exactly one robots tag, and it is noindex`, async ({ request }) => {
    const html = await (await request.get(path)).text();
    const robots = metaContent(html, "name", "robots");
    expect(robots).toHaveLength(1);
    expect(robots[0]).toMatch(/^noindex/);
  });
}

// Next always injects its own `noindex` into the not-found page, so one tag is
// not reachable from metadata. What matters is that nothing contradicts it:
// the root layout's `index, follow` used to sit beside it.
test("the 404 says noindex in every robots tag it has", async ({ request }) => {
  const res = await request.get("/no-such-page/");
  expect(res.status()).toBe(404);
  const robots = metaContent(await res.text(), "name", "robots");
  expect(robots.length).toBeGreaterThan(0);
  for (const value of robots) expect(value).toMatch(/^noindex/);
});

test("robots.txt blocks only the API and the admin console", async ({ request }) => {
  const body = await (await request.get("/robots.txt")).text();
  const disallowed = body
    .split("\n")
    .filter((line) => line.startsWith("Disallow:"))
    .map((line) => line.replace("Disallow:", "").trim());
  expect(disallowed).toEqual(["/api/", "/admin"]);
  expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
});

test("every sitemap URL is a public page this suite checks", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs).toEqual(PUBLIC_PAGES.map((p) => `${ORIGIN}${p}`));
});
