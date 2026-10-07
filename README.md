# Track Toolkit

_Formerly SoundCloud Toolkit._ SoundCloud's API Terms of Use forbid
"SoundCloud" in an app's name or its domain, so the product renamed. Nothing
else changed: same tools, same accounts, same OAuth connection to SoundCloud.

Bulk library management for SoundCloud power users — the batch operations the
official site makes you do one click at a time.

[![Users, all-time](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Ftracktoolkit.com%2Fapi%2Fstats%2Fpublic&query=%24.formatted.lifetimeUsers&label=users%20all-time&color=ff5500&cacheSeconds=3600)](https://tracktoolkit.com/api/stats/public)
[![Tracks processed, all-time](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Ftracktoolkit.com%2Fapi%2Fstats%2Fpublic&query=%24.formatted.tracksProcessed&label=tracks%20processed&color=ff5500&cacheSeconds=3600)](https://tracktoolkit.com/api/stats/public)

The badges update daily. They read
[`/api/stats/public`](https://tracktoolkit.com/api/stats/public), which serves
two counters the production retention job recomputes every day:
**users** is everyone who has ever run an operation, and **tracks processed**
is the running total of tracks across every operation. Both are kept in the
`metrics` table so neither goes down when old `operation_logs` rows age out
(see `server/lib/retention.js`).

Live at [tracktoolkit.com](https://tracktoolkit.com). The old
`soundcloudtoolkit.com` hostnames 301/308 to it; what is left of the move is
listed under "Rebrand follow-ups" below.

<!-- SCREENSHOT: dashboard after login, showing the tool grid grouped as
Playlists / Likes & Social / Library & Export / Discovery & Links. A ~10s GIF
of a playlist merge completing (select playlists → merge → numbered output)
would do even more work here. Keep under 5MB. -->

## The problem

SoundCloud's site operates one item at a time. Unliking a track is one click;
so is unfollowing an account or removing a repost. Playlists hard-cap at 500
tracks, and dead tracks — private, DMCA'd, region-blocked — sit in playlists
silently. For DJs and collectors with libraries in the thousands, cleanup was
effectively impossible. The toolkit runs those operations in batches through
SoundCloud's OAuth API, and splits playlist output into numbered parts when it
hits the cap.

I built the first version for my own library — thousands of likes and playlists
sitting past the 500-track cap, with no way in the official site to clean any of
it up in bulk.

## How it works

Twenty tools hang off one dashboard, grouped as Playlists, Likes & Social,
Library & Export, and Discovery & Links. Underneath them:

- The frontend is a Next.js static export. One Express app on Azure App
  Service serves it and the API from the same origin, acting as an OAuth2 +
  PKCE proxy: the browser never sees SoundCloud tokens. Tokens are
  AES-256-GCM-encrypted at rest in Postgres, and every SoundCloud call is made
  server-side with the user's decrypted token. The page loads nothing from a
  third party — no analytics, no tag manager, no widget or font CDN — and the
  CSP names no third-party script, style or font source. The threat model,
  CSRF layering, and session-lifetime limitations are written up in
  [docs/SECURITY.md](docs/SECURITY.md).
- A request flows: HMAC-signed session cookie → user and token lookup → the
  SoundCloud client wrapper → SoundCloud's API, with automatic token refresh
  on 401 and backoff on 429.
- Bulk writes run sequentially in 100-track batches with ~300 ms delays.
  Merges dedupe by track ID, filter out blocked and non-streamable tracks, and
  split into numbered playlists at SoundCloud's 500-track cap.
- State lives in Postgres (Azure Database for PostgreSQL): users, encrypted
  tokens, a per-operation log, and follow-action history. URL-resolve caching
  and background-job tracking are in-memory, per-process.
- Rate limiting is the most common failure point — SoundCloud's limits are
  undocumented.

## Running it

Requires Node 18+, a Postgres database, and a SoundCloud OAuth app (client ID
and secret from developers.soundcloud.com). Production runs Azure Database for
PostgreSQL Flexible Server; any Postgres 14+ works for development.

    git clone https://github.com/cole-hackman/tracktoolkit
    cd soundcloud-toolkit
    npm install
    cp .env.example .env   # SoundCloud credentials, DATABASE_URL, generated secrets
    npx prisma db push     # create the schema
    npm run dev            # frontend on :3000, API on :3001

There is no mock mode: without real SoundCloud credentials and a database the
app does not run. Rate limiters are disabled in development.

## Scope and non-goals

**In scope:** batch operations on your own library — playlists, likes,
followings, reposts — plus browsing and cloning public content from accounts
you already follow.

**Not in scope:**

- Downloading tracks that aren't download-enabled. The download proxy accepts
  only SoundCloud's official per-track download endpoint and only redirects to
  SoundCloud's own CDNs.
- Follow automation. The discovery tool enforces hard server-side caps — 50
  follows per 24 hours with cooldowns — no matter what the client requests.
- Multi-account management.

## Tradeoffs

**Static-export frontend served by the Express API.** Express serves
`frontend-UI/out/` as static files and `/api` from the same Azure App Service
origin. What it bought: cheap hosting, no server rendering to operate, and a
same-site `Lax` session cookie. What it cost: Next.js API routes are
unavailable, so all server logic lives in Express. The earlier split — Vercel
for the frontend, DigitalOcean for the API — needed `SameSite=None` cookies
across the `www.` and `api.` subdomains with a strict CORS allowlist, and
getting those right was the most fragile part of that deployment.

**Server-enforced caps on the follow/discovery tool.** SoundCloud flags
aggressive follow activity. The caps live in the backend — 50 follows per 24
hours, 30-minute session cooldowns, 2–5 second jittered pacing between
follows — and reversing a follow doesn't refund the budget, because the write
still happened on SoundCloud's side. What it bought: users can't burn their
accounts by hammering the tool. What it cost: the feature is deliberately
slow, and that's the predictable complaint.

## Known limitations and failure modes

- SoundCloud's rate limits are undocumented. Requests back off on 429 and
  respect `Retry-After`, but bulk operations over a few hundred items still
  occasionally get throttled — and they're slow by design.
- Merges silently drop blocked and non-streamable tracks. The API response
  includes the counts, but the UI doesn't itemize what was filtered. Silent
  from the user's perspective.
- SoundCloud's v2 reposts endpoint sometimes returns zero for users who have
  reposts. A v1 fallback chain mitigates this at the cost of latency, and can
  still miss items.
- In-memory state (the resolve cache, the follow-job registry) is per-process
  and assumes the single-instance deploy. A restart loses running job state; a
  second instance would fork it.
- Schema management mixes `prisma db push` with migration files. A push from a
  branch whose schema is missing production tables would drop those tables —
  the sharpest foot-gun in the repo.
- Observability is application logs plus the in-database operation log. No
  metrics, no alerting, no error tracker. Scheduled automation is a GitHub
  Actions cron pinging `/health` every five minutes.
- The Jest suite (crypto, merge logic, validation, the follow engine, the API
  client wrapper, plus route-level authz/CSRF boundary tests under
  `tests/routes/`) runs in CI on every push to `main`, and a failure blocks
  the deploy. The frontend checks — `tsc`, `next lint`, the colour-contrast
  gate and the Playwright suite — are not in CI yet and are run by hand.

## What I'd do next

1. Surface what a merge filtered out. The counts already come back in the API
   response; the UI drops them on the floor.
2. Put the frontend checks in CI too. The backend suite gates the deploy; the
   Playwright/axe suite, `tsc`, lint and the contrast gate still depend on
   somebody remembering to run them.
3. Move background-job state from memory into Postgres so a restart doesn't
   orphan running follow sessions.
4. Finish the AI library chat on `feature/ai-library-chat` — the index tables
   are already in the production schema; the tool-calling chat loop isn't
   merged.

## Rebrand follow-ups

The code, copy, metadata and in-app announcements ship as Track Toolkit. What
is left is outside the repository and has to be done by hand, in this order:

1. ~~Register the new domain and point it at the app.~~ Done (2026-09-20):
   `tracktoolkit.com` and `www` serve the app from Azure App Service; the
   old `soundcloudtoolkit.com` hosts 301/308 to it (`docs/internal/MIGRATION.md`).
2. SoundCloud OAuth app registration: ~~redirect URI~~ done
   (`https://tracktoolkit.com/api/auth/callback`, 2026-09-20). Still to do:
   rename the app to "Track Toolkit" and upload
   `frontend-UI/public/brand/icon-512.png` as its icon so the authorize
   screen shows the new mark.
3. ~~Redraw the logo and icon artwork.~~ Done (2026-09-20): the new mark and
   wordmark live under `frontend-UI/public/brand/`, generated from
   `docs/brand/tools/mark-spec.cjs`. The legacy `SC Toolkit Icon*` and
   `sc toolkit transparent*` files now carry the same artwork and exist only
   because the Chrome extension points at them.
4. ~~Re-point `og-image.png`, the sitemap, `robots.txt` and the canonical URLs
   at the new domain, re-verify in Search Console~~ done (2026-09-20:
   `tracktoolkit.com` verified as a Domain property, sitemap submitted).
   Still to do: submit the change of address from the `soundcloudtoolkit.com`
   property. Also upload `og-image.png` as the GitHub repository's social
   preview.
5. Chrome extension (separate project): copy
   `docs/brand/extension/icon-{16,32,48,128}.png` into its icons folder,
   point `manifest.icons` and `action.default_icon` at them, rename the
   listing to Track Toolkit and re-publish. Only after the published
   extension no longer requests the legacy filenames may the two legacy
   image files be removed from `frontend-UI/public/`. The DigitalOcean app
   is not renamed; it is decommissioned after the Azure soak.

## Stack

Next.js 15 · React 18 · TypeScript · Tailwind CSS 3.4 · Express · Prisma ·
PostgreSQL (Azure Flexible Server) · Azure App Service

The frontend has a Playwright suite with `@axe-core/playwright`
(`frontend-UI/e2e/`): every user-facing page is audited for serious and
critical accessibility violations and for horizontal overflow at 1280, 430,
390 and 360 px. The admin console is not in it. Alongside that, a
colour-contrast gate over the design tokens (`npm run contrast`) — neither is
wired into CI yet, so both are run by hand before a merge.

## License

PolyForm Shield 1.0.0 — see [LICENSE](LICENSE). You may clone, run, modify
and contribute to this code for any purpose except providing a product or
service that competes with Track Toolkit. It is source-available, not
OSI open source. Releases before 2026-09-21 were MIT and remain so for the
copies obtained under it.