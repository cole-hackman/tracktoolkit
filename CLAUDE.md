# CLAUDE.md — Track Toolkit Project Brief

## Project Overview

Track Toolkit (formerly SoundCloud Toolkit — SoundCloud's API Terms of Use forbid "SoundCloud" in an app's name or its domain) is a full-stack web application for SoundCloud power users who need bulk management capabilities the official platform doesn't provide. It solves the 500-track playlist limit with automatic playlist splitting, enables batch operations (bulk unlike, bulk unfollow, bulk repost removal, playlist merging), converts liked tracks or activity feeds into playlists, resolves SoundCloud URLs to structured metadata, and provides a playlist health checker. The backend acts as a secure OAuth2 proxy—all SoundCloud API calls flow through it so credentials never reach the browser.

---

## Tech Stack — what the manifests don't say

The three `package.json` files (root, `server/`, `frontend-UI/`) are the
dependency list. What they do not tell you:

- Production database is **Azure Database for PostgreSQL Flexible Server**
  (`tracktoolkit-pg`, PG 17), since the 2026-09-20 cutover in
  `docs/internal/MIGRATION.md`. Neon is the legacy database, left intact as the
  rollback until decommission — nothing reads or writes it (it is unused, not
  set read-only).
- **Tailwind CSS 3.4** with `frontend-UI/tailwind.config.ts` — **not v4**. Colors
  are `hsl(var(--token))` against the tokens in `src/app/globals.css`; every
  pair the app relies on is checked by `npm run contrast`, which exits 1 below
  its threshold. Nothing runs it automatically — it is a manual pre-merge step,
  not part of `next build` and not in the deploy workflow.
- The frontend is a Next.js static export (`output: 'export'`,
  `trailingSlash: true`) built to `frontend-UI/out/` and served by the Express
  backend from one origin on **Azure App Service**.
- The Playwright + axe e2e suite (`frontend-UI/e2e/`) runs against the built
  export at 1280/430/390/360, asserting zero serious or critical axe
  violations, no horizontal overflow, and the keyboard behaviour of the shared
  primitives.
- **No third-party scripts and no analytics.** No Google Analytics, no Vercel
  Analytics or Speed Insights, no tag manager, no widget CDN, no external font
  host. The CSP in `server/middleware/security.js` names no third-party script,
  style or font source (only SoundCloud, in `connectSrc`), and
  `tests/security-headers.test.js` fails if one is added back

---

## Where things live that you would not guess

- `docs/internal/` — STATE.md (session state + decisions — read first),
  MIGRATION.md, ANALYSIS.md, DATA-COLLECTION.md, NOTES.md, TERMS-CHECK.md.
- `server/routes/` is **six** files, not one: `api.js`, `growth.js`,
  `admin.js`, `auth.js`, `feedback.js` (which also holds the retired rebrand
  vote) and `stats.js` (the public README-badge figures).
- `server/lib/pacing.js` — shared `sleep()` + `SC_WRITE_PACING_MS` (300ms), the
  single source for write pacing.
- `server/lib/auth-cache.js` — 30s memo of user + **decrypted** tokens (see
  Landmines in `docs/internal/STATE.md`).
- `frontend-UI/src/lib/support.ts` — `SUPPORT_EMAIL`, the one definition;
  never hardcode the address.
- `frontend-UI/src/lib/nav.ts` — the tool list behind the sidebar, the
  dashboard and the FAQ.
- Per-route metadata: every page is `"use client"`, so a **public** route's
  `<title>`/description/canonical go in a sibling server `layout.tsx`. Inside
  `(app)` (whose layout sets `noindex`), `usePageTitle` sets the title at
  runtime.
- `app/terms/page.tsx` — `GOVERNING_LAW_STATE` is a `"[STATE]"` placeholder
  Cole must fill.
- `components/AppErrorFallback.tsx` — "Something went wrong"; what the e2e
  crash guard looks for.
- `.do/app.yaml`, `vercel.json` — **RETIRED** pre-cutover DigitalOcean and
  Vercel configs, kept as rollback until those accounts are decommissioned.
- `docs/api.json` is SoundCloud's upstream spec, not this app's (see API
  Endpoints).

---

## Architecture

### Request Flow

One origin. Express serves the static export **and** `/api` from the same
Azure App Service instance, so there is no browser hop between a frontend host
and a backend host and no cross-site request in the picture.

The retired hostnames (`www.tracktoolkit.com`, `soundcloudtoolkit.com`,
`www.`, `api.`) are bound to the same app and 301/308 to the apex from
`server/middleware/legacy-redirect.js`.

### Authentication & Session Flow (OAuth2 + PKCE)

`server/routes/auth.js` (login/callback) and `authenticateUser` in
`server/middleware/auth.js` are the flow. What the code does not make obvious:
the session lifetime is enforced **inside the signed payload** (`iat` +
`SESSION_TTL_MS`, 7 days), so a stolen cookie cannot outlive it by ignoring the
cookie's own `maxAge`. Token refresh happens on a 401 inside
`soundcloud-client.js` — read Account lifecycle below before touching it.

### Cookie Configuration

The cookie is **host-only**: `createSessionCookieOptions()` in
`server/lib/session.js` sets no `domain`, so it is scoped to
`tracktoolkit.com` and nothing else.

Production runs `SameSite=Lax`, set explicitly through
`SESSION_COOKIE_SAMESITE=lax`. It can, because the frontend and the API are
one origin — there is no cross-site request to carry the cookie on. The code
still defaults to `none` when the variable is unset, which is the split-host
value the app shipped with before the Azure cutover; the deployment sets `lax`
rather than relying on that default, so the value is visible in
`infra/main.cutover.bicepparam` instead of implied.

### CSRF & Origin Enforcement

`SameSite=Lax` is now the first line of defence, but it is not treated as the
only one — the value is an environment variable, and the two layers below were
built when it was `None`. Both stay:

1. **`rejectUntrustedOrigin`** (`server/middleware/security.js`, mounted on `/api`
   in `server/index.js`) rejects `POST`/`PUT`/`PATCH`/`DELETE` whose `Origin`
   header is present and not in the allowlist. Requests with no `Origin`
   (same-origin navigations, curl, server-to-server) pass.
2. **`express.json()` is deliberately the only body parser.** A cross-site HTML
   form posts `urlencoded`/`text-plain` with no preflight; those parse to an
   empty `req.body`, so every mutating route's validator fails closed. **Do not
   add `express.urlencoded()`** without revisiting `docs/SECURITY.md`.

Regression tests: `tests/routes/origin.test.js`, `tests/routes/feedback-authz.test.js`.

Known limitation: there is no server-side session revocation list. Logout clears
the cookie, but a previously exfiltrated cookie stays valid until its `iat` TTL
expires.

---

## Data Model

The schema (`prisma/schema.prisma`) has **18 models**, not two:

| Model | Purpose |
|-------|---------|
| `User` | One row per SoundCloud account that has logged in |
| `Token` | AES-256-GCM-encrypted access + refresh token pair (one per user) |
| `OperationLog` | Per-operation analytics record — action, status, duration, track/playlist ids |
| `Track` / `Playlist` | Harvested music catalog (populated opportunistically from resolved/browsed content) |
| `GrowthAction` | Follow/like actions taken by the growth suite, plus follow-back outcomes |
| `Feedback` | In-app feedback form submissions — login-required, stored only here (no email, no webhook). `messageHash` (sha256 of the normalized message) backs a 24-hour per-user duplicate check; `status` is `new\|seen\|done\|spam` and `adminNote` is admin-only |
| `RebrandVote` | Rebrand name-vote responses — the vote is closed, rows retained read-only (`@@unique([userId, campaignId])`) |
| `BetaSignup` | The retired SongSwipe beta survey — retained read-only for history |
| `SurveyResponse` | The retired monetization survey — retained read-only for history |
| `chat_conversations` / `chat_messages` | AI library chat (owned by `feature/ai-library-chat`; declared here so `prisma db push` does not drop them) |
| `indexed_likes` / `indexed_playlist_tracks` / `library_snapshots` | Library indexing for that same feature — same db-push caveat |
| `LibraryCachePage` / `LibraryCacheState` | Persistent tier of the library cache — one row per 200-item page plus a sync-state row. **Not** the same thing as `library_snapshots` above |
| `Metric` | Counters that must outlive the rows they were computed from. `lifetime_distinct_users` (a high-water mark) plus `lifetime_tracks_processed` and its cursor `lifetime_tracks_processed_through` (a running total), all written at the start of every retention run — before any delete in that run. Deliberately **not** per-user, so it is absent from the deletion cascade by design |

`User.lastLoginAt` (stamped by the OAuth callback on every login; null on rows
predating the column, which fall back to `updatedAt`) drives the dormant-account
purge. `User.disconnectedAt` is set by `POST /api/auth/disconnect` or by
revocation detection and cleared on the next successful login. Both are indexed
so the daily retention sweep is a range scan rather than a full table scan.
Additive SQL: `docs/sql/2026-09-account-lifecycle.sql` (**not applied**).

---

## API Endpoints

The authoritative list is the source: `grep -n "router\." server/routes/*.js`.
Everything is under `/api/`, and everything except `/health`, `/` and the auth
redirects runs `authenticateUser`. What follows is only what the route code
does not make obvious.

### Public stats (`routes/stats.js`)

`GET /api/stats/public` is unauthenticated and serves the README badges
(shields.io dynamic-JSON badges): `lifetimeUsers`, `tracksProcessed`,
`updatedAt` and a `formatted` copy of both with thousands separators. It only
reads the `metrics` table — two primary-key rows, `Cache-Control: public,
max-age=3600` — so the figures move once a day, when the retention job writes
them. A counter not written yet is `null`, never 0. Anything added to this
response is published, so keep it to all-time aggregates.

The tracks total is **not** a high-water mark like the user count. Summing
`trackCount` over what the 365-day purge leaves would fall, and `max()` would
freeze it on the day the purge began, so each run adds only the rows created
since `lifetime_tracks_processed_through` (stopping 5 minutes behind now) and
writes total and cursor in one transaction.

### Auth

`POST /api/auth/disconnect` takes **no body**, so the empty-body fail-closed
CSRF layer has nothing to act on — `rejectUntrustedOrigin` is the whole guard.
`tests/routes/account-deletion.test.js` asserts a cross-site POST gets 403.

### Downloads

`GET /api/proxy-download` (one click, any user) and `POST /api/downloads/links`
(the queue: `authenticateUser, requireCanDownload, validateDownloadLinks,
downloadLinksLimiter` — ≤10 URLs per call, 60 calls/hour **per user**, paced
at `SC_WRITE_PACING_MS`, stops at the first 429 and returns the rest as
`rate_limited`). Both accept only SoundCloud's own track download URL —
numeric or `soundcloud:tracks:N` form (`isAllowedDownloadUrl`) — and hand back
a CDN link from the redirect allowlist; the server never touches the file.
`getDownloadLink` is the one SoundCloud call outside `scRequest()` (it needs
`redirect: 'manual'`). What a track's download situation *is* (direct / free
gate / store / pre-order / none) is decided only by
`frontend-UI/src/lib/download-status.ts`.

`GET /api/downloads/history` (`authenticateUser, adminAuth` — admin only by
decision) answers "have I already downloaded this?" **without a table of its
own**: it unnests `metadata.trackIds` from the caller's successful
`proxy-download` / `download-links` OperationLog rows. Two consequences: it
records that a download was *started*, not that the file is on disk, and it
lasts as long as OperationLog (365 days). It also depends on
`download-links` logging **only the tracks that got a link** — log a failed
track there and it shows up as downloaded.

### Growth & Discovery (`routes/growth.js`)

All `/growth/*` routes are `authenticateUser`; the write-heavy ones also carry
`heavyOperationRateLimiter`. Follow caps are enforced server-side (50/24h +
30-minute session cooldown) regardless of what the client requests.

**Genre focus** (`genre` on `POST /growth/discover`, one of
`GENRE_FOCUS_SLUGS` in `server/lib/genres.js`; the client list is
`frontend-UI/src/lib/genres.ts` and `tests/genre-list-parity.test.js` fails if
they drift). SoundCloud users have no genre field, so a candidate's genre is
only known after its `/users/:id/tracks` lookup. A focus therefore widens that
lookup from `limit` (default 50) to the top `GENRE_FOCUS_LOOKUP_MAX` (150)
candidates, keeps those whose recent `genre`/`tag_list` match the slug or an
alias as a whole word (`deep-house` matches `house`, `housewife` does not),
and returns the top `limit`. Candidates whose genre could not be established
are **excluded and counted**, never guessed. `stats` separates `genreChecked`
(lookups attempted), `genreUnknown` (attempted, no usable genre: failed, no
tracks, no genre metadata) and `genreSkipped` (the deadline passed before the
lookup ran). `stats.lookupsSkipped` is the same skipped count with or without a
focus (with no focus, skipped candidates are still returned, with a neutral
genre score), and `stats.crawlPartial` reports a cut-short seed crawl
separately (`partial` is kept for compatibility).

Cost: up to +100 track calls per scan inside the same 45 s budget; it is still
one request against the shared 20/hour `heavyOperationRateLimiter` budget
(shared with merge, clone and every bulk write), and follow caps are unchanged.
With no focus the call count is identical to before. The chosen `genre` is
recorded in the `OperationLog` metadata. `genre` validates `.isString()` first
(array bypass).

### Feedback (`routes/feedback.js`)

The live in-app "Send feedback" form. Login-required by decision, so every row
is attributable — which is what lets the write path get away with a honeypot
and a per-user limiter instead of a captcha. Storage is Postgres and nothing
else: no email delivery, no webhook, no third-party widget.

Not to be confused with the retired rebrand name vote, which lives in the same
route file under `/survey` and is documented further down.

**Middleware order is load-bearing**:
`authenticateUser, validateFeedback, feedbackHourlyLimiter, feedbackDailyLimiter, handler`.
The validator runs **before** the limiters, for the same reason
`validateRebrandVote` runs before the closed-campaign gate: a cross-site
form-encoded post parses to an empty `req.body` under `express.json()` and
dies at the validator with a 400. Putting the limiters first would also let a
forged request burn a real user's feedback budget.
`tests/routes/feedback.test.js` asserts that order directly.

`feedbackHourlyLimiter` (5/hour) and `feedbackDailyLimiter` (20/24h) are the
only **per-user** limiters in `rateLimiter.js` — every other tier is per-IP.
They are built by `createUserLimiter()`, which keys on `req.user.id` and only
falls back to `req.ip`. That fallback is unreachable behind `authenticateUser`;
it exists so the key is never `undefined`. Mount one of these in *front* of
`authenticateUser` and it silently becomes a per-IP limiter again.

The honeypot answers **202**, not 400, so automation cannot learn which field
gave it away, and its counter is `logger.debug` (a no-op outside development)
so spam cannot fill the log in place of the table. The `message` and `email`
never appear in any log line.

Three details in `validateFeedback` that look incidental and are not:

- `page` and `email` use `optional({ nullable: true, checkFalsy: true })`, so
  an empty string means **absent**, not malformed. The form posts `''` for an
  input the user never touched; without `checkFalsy` that rejected an
  otherwise valid submission, and the route stores `null`.
- `message` runs `stripControlChars` as a `customSanitizer` **before**
  `.isLength({ min: 10 })`. Measuring first would let ten control characters
  satisfy the minimum and then collapse to an empty stored message. The route
  strips again as belt-and-braces; the function is idempotent and exported
  from `validation.js` so there is one definition, not two that drift.
- Every field leads with `.isString()`, including `type` and `email` where it
  looks redundant. express-validator 7 applies a validator **element-wise to
  an array**, so `{ type: ['bug'] }` satisfies `.isIn()` and
  `{ email: ['a@b.co'] }` satisfies `.isEmail()`; both then reach Prisma as
  arrays and 500. `.isString()` checks the value as a whole and is the only
  thing that closes that door.

### Admin (`routes/admin.js`)

Every admin route runs `authenticateUser` **then** `adminAuth`. `adminAuth`
fails closed: an unset or empty `ADMIN_IDS` 403s everyone.
`tests/routes/admin-auth.test.js` asserts both the boundary and that no route
is registered without the pair.

`/catalog/tracks` also accepts `access=not_playable` (blocked ∪ preview ∪ gone),
sorts on `duration`, `firstSeen` and `lastSeen`, and `format=csv` (the
current filter set, up to 10,000 rows, no COUNT query). The CSV writer and
the day-filling helpers (`periodDayCount`, `fillDays`) are shared by
`/daily` and `/catalog/daily`. `tests/routes/admin-catalog.test.js` covers
the re-resolve guards and the CSV contract.

**`/feedback/*` and `/feedback-items*` are different tables.** `/feedback/*`
is the retired SongSwipe beta survey (`BetaSignup`); `/feedback-items*` is the
live in-app feedback form (`Feedback`). The path spelling is the only thing
keeping them apart, so do not "tidy" one into the other.

**`/feedback-items.csv` guards against formula injection.** `message` and
`adminNote` are free text, and Excel / Sheets / LibreOffice execute a cell that
opens with `=`, `+`, `-`, `@`, tab or CR — so a report reading
`=HYPERLINK("http://evil...")` would fire when an admin opens the export. Cells
starting with any of those get a leading apostrophe, and `\r` is in the
quote-trigger class so a lone carriage return cannot split one report into two
rows. The older `feedback/beta-emails` export does **not** have this guard yet
(its fields are far less free-form) — that is a known follow-up.

The `PATCH` writes `status` and `adminNote` and nothing else — no admin action
can rewrite what a user said. An empty patch is refused rather than issued as a
no-op write, because `updatedAt` is `@updatedAt` and would move anyway, making
the row look freshly triaged. The list filters accept only the enumerated
`status`/`type` values; anything else is dropped rather than passed to Prisma,
so a typo returns everything instead of nothing.

The three `/feedback/*` routes serve the retired SongSwipe beta survey. The
console's Archive view reads `/feedback/summary` and links the beta-emails CSV;
the response list is reachable by URL only.

### Admin console (`frontend-UI/src/components/admin/`)

`/admin` is a tabbed console, not one scrolling page: **Overview** (alert
strip, KPI tiles, activity trend, outcome bar, feature usage/reach, errors),
**Operations** (the searchable log with an inspector drawer), **Performance**
(the `readLatency` p95 ranking and write health), **Catalog**, **Feedback**
(the live in-app inbox) and **Archive** (closed rebrand vote, retired beta
survey). The active view is the URL hash
(`/admin#operations`); keys 1–6 switch views. Catalog has its own sub-views
in the hash (`#catalog/tracks|playlists|artists|health`): the touches
time-series, genre/access bars that filter, Tracks with optional
duration/first-seen/last-seen columns and CSV export, Playlists, the Artists
roll-up (not-playable share per artist), and Health — the blocked / preview /
gone / pending / not-found lists with the console's only write, **Re-resolve**
(`POST /api/admin/catalog/re-resolve`, ≤200 ids per click). An expanded
track row (and each Health row) can mount SoundCloud's embed player on
demand, one at a time; it is a plain iframe on `w.soundcloud.com`, no
token involved. The `frame-src` allowance for it is scoped to the `/admin`
document only: `securityHeaders` in `server/middleware/security.js`
serves a second helmet instance for `isAdminPagePath` and the base policy
(`frame-src 'none'`) everywhere else — `tests/routes/csp-admin-frame.test.js`
pins that. Each view fetches only what it
needs through the hooks in `queries.ts` (react-query; live views re-poll every
30 s while the tab is visible and keep stale data on screen while refetching —
never a skeleton flash). Archive queries are all-time and never poll.

**Feedback is a view, not a panel in Archive.** `views/FeedbackView.tsx` reads
the four `/api/admin/feedback-items*` routes: status tabs (with counts from
`/summary`), a type filter, 25-per-page paging with the total, a clamped
message body that expands in place, the three triage buttons, an admin-note
field that saves on blur and skips a no-op write, the unread badge and the CSV
link. It takes **no period** — it is a queue, not a time series, and an
untriaged report from six weeks ago is still untriaged. Archive is closed,
read-only history; this is the console's one working queue.

The console uses the app's HSL tokens and `ThemeContext` (no private theme),
plus JetBrains Mono via `next/font` from `app/admin/layout.tsx` for readouts.
Access: `AdminConsole` gates on `user.isAdmin` from `/api/auth/me` before any
admin request is made; the sidebar shows an "Admin console" link only to
admins. Server-side `adminAuth` remains the real boundary.

### Account lifecycle & retention

There are three exits, not two. **Logout** forgets the session cookie and
nothing else — the encrypted token pair stays and the next login picks it back
up. **Delete** (`DELETE /api/auth/account`) is irreversible. **Disconnect**
(`POST /api/auth/disconnect`) is the middle: `disconnectUser()` in
[`lib/account-lifecycle.js`](server/lib/account-lifecycle.js) hands the grant
back via `signOut`, deletes the `Token` row, stamps `User.disconnectedAt`, and
drops every cache derived from that grant. The account survives — logging back
in clears the stamp — but the retention job deletes the row after 6 days.

**It must call `invalidateCachedAuth`.** `lib/auth-cache.js` memoizes the
*decrypted* token pair for 30 seconds; without that call a request inside the
window would keep working against tokens that no longer exist. Same landmine
as the refresh path. It runs in a `finally` immediately after the token
delete, so no later failure in the teardown can leave the memo holding
credentials whose row is already gone.

**Revocation is detected, not merely handled — but only when the user comes
back.** A user revoking the app from SoundCloud's own settings never tells this
service, and nothing here asks: detection happens inside a token refresh, which
happens only when a request the user made comes back 401. Someone who revokes
and never returns is never detected, and their rows live until the 24-month
dormancy sweep. A proactive sweep is the fix and is a known follow-up
(`docs/internal/TERMS-CHECK.md`, finding B, item 4).

`refreshTokensAndPersist` — the single refresh choke point — treats exactly two
response shapes as candidates for revocation and runs the teardown with
`reason: 'revoked'`: `invalid_grant` in a JSON body on a 400/401, and a 401
with an **empty** body. **A 401 with a non-empty non-JSON body does not count**
— that shape is an HTML error page from a proxy or WAF far more often than a
revocation, and acting on it would destroy a live user's tokens over someone
else's infrastructure. 429, every 5xx, timeouts and network errors are excluded
for the same reason. The thrown error is unchanged, so callers still see the
generic "Token refresh failed".

**`invalid_grant` alone is NOT enough, and this is the landmine.** SoundCloud
rotates the refresh token on every exchange, so a token that has already been
spent is refused with exactly the same `invalid_grant`. A route captures
`req.accessToken`/`req.refreshToken` once and hands that same pair to every
`scRequest` it makes (only `paginate` rotates its local copy), so at an hourly
access-token expiry the second call in any two-call route — the merge loop, a
fan-out dashboard read — re-presents a token the first call consumed. Reading
that as revocation deletes a live user's freshly rotated pair and starts the
six-day account-deletion clock.

Two things stop it. They are **not** equal partners:

- **`_resolveInvalidGrant` is the correctness mechanism.** It re-reads the
  stored pair before believing the error. If the stored refresh token is still
  the one presented, nothing rotated it and the grant really is gone →
  teardown. If the database has moved on, it is a spent token → hand the
  caller the current pair so its retry succeeds, disconnect nothing. If the
  row cannot be read at all — missing, or the database is down — the answer is
  "do not know", and "do not know" never means revoked. Neutering only this
  and keeping the memo still tears users down; neutering only the memo tears
  nobody down. **Do not remove it as redundant.**
- **The rotation memo is an optimisation.** `rememberRotation` /
  `readRecentRotation` keep the last exchange's result for 60s
  (`SC_ROTATION_MEMO_TTL_MS`) keyed by the refresh token it spent, so the
  second call is answered without a network round trip at all. The in-flight
  mutex beside it only collapses refreshes that *overlap*; this covers the
  sequential case, which is the common one. It holds plaintext tokens, so it
  is dropped by `disconnectUser` and by `DELETE /api/auth/account`, exactly
  like the auth memo. The recovery path deliberately does **not** write it: its
  database read and its return are separated by an await, so a write there
  could land after a disconnect had already forgotten it.

**Every SoundCloud call must run inside a token context**, or the same teardown
arrives by a different door. `authenticateUser` opens one with
`runWithTokenContext`; anything that runs from a timer has to open its own.
`growth-scheduler.js` did not, so its daily crawl refreshed with no `userId`,
rotated the token upstream, and — having nowhere to store the replacement —
left the row holding a token SoundCloud had already spent. The user's next
request presented exactly that token, the comparison above correctly found it
equal to the stored one, and the account was torn down. `_refreshAndPersistNow`
now **refuses** a context-free exchange instead of rotating and discarding, so
a caller that forgets fails loudly rather than costing somebody their account.

**One worker is a correctness constraint here, not a performance one.** Inside
one process the in-flight map holds its entry until the persist completes, so a
second caller either joins that promise or reads the rotated row. Across
processes there is no such ordering: two instances present the same token, the
loser reads the row before the winner's `token.update` lands, finds it still
equal to what it presented, and disconnects a live user. `infra/main.bicep`
pins `numberOfWorkers: 1`. Raising it needs a database-side guard first — a
compare-and-swap on `refresh`, or a `rotatedAt` the loser can compare against.

`tests/routes/token-refresh.test.js` covers all of this against a mock
SoundCloud that rotates and refuses spent tokens the way the real one does;
`tests/growth-scheduler.test.js` covers the scheduler's context.

**Retention** ([`lib/retention.js`](server/lib/retention.js)) runs 10 minutes
after boot and then every `RETENTION_INTERVAL_MS`. A snapshot step plus eight
purges, each one bulk statement, each isolated — a step that throws is logged
(`[retention] <step> removed N`) and the rest still run; `runRetentionOnce()`
never rejects, so the interval cannot die. It is exported for tests and for a
REPL.

| # | Step | Window |
|---|------|--------|
| 0 | Lifetime-user snapshot → `Metric.lifetime_distinct_users`, then the tracks total → `Metric.lifetime_tracks_processed` | every run, **first** |
| 1 | `LibraryCachePage` (by `createdAt`) + `LibraryCacheState` (by `updatedAt`) | `CACHE_TTL_DAYS` (7) |
| 2 | Users still stamped `disconnectedAt` | 6 days (constant, see below) |
| 3 | Dormant users (`lastLoginAt`, or `updatedAt` when null) | `INACTIVE_MONTHS` (24) |
| 4 | `OperationLog` purge | `OPLOG_RETENTION_DAYS` (365) |
| 5 | `GrowthAction` | 365 days |
| 6 | `Feedback` (guarded on `prisma.feedback`) | 730 days |
| 7 | `BetaSignup.email` → null | every run |
| 8 | Catalog `gone` rows lose their metadata | every run |

Three things that look arbitrary but are not:

- **Step 0 runs first, before any delete in the run — not merely before the
  log purge.** The user sweeps at steps 2 and 3 cascade into `operation_logs`
  too, so snapshotting after them would drop exactly the departing users the
  all-time figure exists to remember. It is `SELECT COUNT(DISTINCT "userId")`
  via `$queryRaw` (one row out of Postgres, matching the admin aggregates),
  monotonic — a run only ever raises it — and admin `/stats` surfaces it as
  `lifetimeUsers` (null before the first run).
  Every user delete also logs `[retention] <step> will remove N users` before
  it runs. That is useful while a sweep is happening, but it is **not a
  preview** — the line lands microseconds before the delete it describes, in
  the same pass. To see the numbers before anything is destroyed, set
  `RETENTION_DRY_RUN=true`: the job runs on its normal schedule, performs
  every count, logs the same `will remove N users` lines plus a
  `would remove N` per step, and issues no write at all.
  `RETENTION_ENABLED=false` is **not** the way to do this — it schedules
  nothing, so it produces silence, which reads exactly like "there was nothing
  to delete". `tests/retention-dry-run.test.js` mocks the client with a Proxy
  that records any `delete*`/`update*`/`upsert`/`create*`, plus `$executeRaw`
  and `$transaction`, on **any** delegate — including ones that file has never
  heard of — and fails if the set is non-empty under the flag. It is worded
  that way because the first version listed nine method names, and a rogue
  `user.delete` or `$executeRaw DELETE` left it green.
- **The disconnect window is 6 days, and a constant, not an env var.** The
  SoundCloud terms' deletion deadline is *7* days; the window is one day short
  of it on purpose, because the sweep is daily and the real worst case is the
  grace period plus up to one `RETENTION_INTERVAL_MS`. At 7 that worst case was
  up to 8 days — past the ceiling. At 6 it is ≈7 and inside it. It is a
  constant so it cannot be pushed past the deadline from a deployment
  dashboard, and `RETENTION_INTERVAL_MS` is clamped to 24h in code for the same
  reason — it would otherwise spend the margin the sixth day buys, from an env
  var and with no signal. See `docs/internal/TERMS-CHECK.md` finding B.
- **`INACTIVE_MONTHS` is calendar months in UTC.** Local-time `setMonth` shifts
  the cutoff by an hour across a DST boundary, making the same input produce
  different cutoffs depending on host timezone and time of year.

`GET /api/auth/export` is the read side of the same story: every row keyed to
the caller, as a dated JSON attachment. The `Token` record contributes
`expiresAt` only — `encrypted` and `refresh` are excluded at the `select`, so
the ciphertext never leaves Postgres. Note that `req.user` is the full row
**with its `tokens` relation included**, which is why the route names fields
explicitly instead of spreading it.

**"Every row keyed to the caller" is an invariant, not a description.** The
policy and the account page both promise exactly that, so a per-user table
missing from the export makes a published statement false — which is how the
four cross-branch tables (`chat_conversations` with its `chat_messages`,
`indexed_likes`, `indexed_playlist_tracks`, `library_snapshots`) came to be
absent for a while. `tests/routes/export.test.js` now derives the per-user
model list from `prisma/schema.prisma` the way
`tests/account-deletion-cascade.test.js` does and fails naming any model that
is neither queried nor on the explicit `EXPORT_EXCEPTIONS` list (today: `Token`,
which is exported as expiry only). A model whose delegate is absent from the
generated client contributes an empty array rather than a 500. `schemaVersion`
is `2` since those four were added.

> `docs/api.json` is **SoundCloud's own OpenAPI spec** (68 upstream paths under
> `https://api.soundcloud.com`), kept as a reference for what the upstream API
> offers. It documents none of this app's endpoints and is not an inventory of
> them. The authoritative list of what this server exposes is the source:
> `grep -n "router\." server/routes/*.js`.

### Rebrand announcements (and the retired name vote)

The product renamed from **SoundCloud Toolkit** ("SC Toolkit" in the UI) to
**Track Toolkit**, because SoundCloud's API Terms of Use forbid "SoundCloud" in
an app's name *or* its domain. References to SoundCloud that describe the
platform, the OAuth connection, the API or the trademark position stay — only
product-owned naming moved. **The domain has moved**: `tracktoolkit.com` is
canonical since 2026-09-20, and the remaining `soundcloudtoolkit.com`
references are the legacy hostnames bound to the same app for the 301 (see
Domain Strategy below) plus the historical record in
`docs/internal/MIGRATION.md`.

Two announcements carry the change, both gated in **localStorage only** — no
server call, no table, same posture as `lib/whatsNew.ts`:

| Surface | File | Gate |
|---------|------|------|
| Site-wide banner | [`RebrandBanner.tsx`](frontend-UI/src/components/RebrandBanner.tsx) | `track-toolkit-rebrand-banner` |
| One-time modal | [`RebrandAnnouncementModal.tsx`](frontend-UI/src/components/RebrandAnnouncementModal.tsx) | `track-toolkit-rebrand-ack` |

Both keys are namespaced by `REBRAND_ANNOUNCEMENT_VERSION` in
[`lib/rebrand.ts`](frontend-UI/src/lib/rebrand.ts); bump it to re-announce.
Acknowledging the modal also settles the banner, and
`REBRAND_STATE_EVENT` is what tells the banner (mounted by the root layout)
that the modal (mounted by the `(app)` layout) was acknowledged in this tab.

**Banner layout contract.** The banner sits in normal flow, sticky at `top: 0`
with `z-40`, and publishes its measured height as `--announcement-h` on the
document element. The two `position: fixed` headers that would otherwise sit
under it — the landing nav in `app/(home)/page.tsx` and the mobile header in
`AppShell.tsx` — read that variable as their `top`. It is declared `0px` in
`globals.css`, so both are correct before the banner mounts and after it is
dismissed. `z-40` is deliberate: above page content, below the mobile drawer
(z-50) and every modal (z-70).

**Modal ordering — nothing stacks.** The rebrand modal is mounted by the
protected route group's layout, so it fires on first arrival anywhere in the
app, not only on the dashboard. The dashboard's "What's new" effect returns
early while `isRebrandAcknowledged()` is false, so the two never appear
together; "What's new" simply waits for the next visit.

**The name vote is closed.** Track Toolkit won (48/165), and
`REBRAND_VOTE_CONCLUDED` in [`routes/feedback.js`](server/routes/feedback.js)
retires the write path in code rather than by environment variable:
`GET /api/feedback/survey/status` reports `{ enabled: false, concluded: true,
decidedName }` and `POST /api/feedback/survey` answers **410**. The client
modal, `SurveyContext` and `survey-storage` are deleted.

Note the middleware order on that POST: `validateRebrandVote` still runs
*before* the closed-campaign check. That is what keeps a cross-site
form-encoded post failing with a 400 at the validator — the fail-closed CSRF
invariant `tests/routes/feedback-authz.test.js` guards. Putting the gate first
would retire that coverage along with the vote.

Nothing collected is deleted. `RebrandVote` rows stay, and the admin read
paths still serve the full tally and both write-in fields.

These four are the **closed vote**, not the live feedback form — that is
`POST /api/feedback` and `GET /api/feedback/mine`, documented under
[Feedback](#feedback-routesfeedbackjs) above. Both live in
`routes/feedback.js`; only the vote is retired.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/feedback/survey/status` | `{ enabled: false, concluded, decidedName, campaignId, submitted, submittedAt }` |
| `POST` | `/api/feedback/survey` | 400 on an invalid body, otherwise **410 Gone** — the vote is closed |
| `GET` | `/api/admin/rebrand/summary` | Admin-only tally by `nameChoice`, plus write-in and feature-request counts |
| `GET` | `/api/admin/rebrand` | Admin-only paginated vote list with user info and both write-in fields |

`REBRAND_NAME_ORDER` in the admin page is frozen as the order voters actually
saw; the slugs still match `REBRAND_NAME_SLUGS` in
[`validation.js`](server/middleware/validation.js), which the stored rows were
validated against. The retired SongSwipe beta survey (`BetaSignup`) and the
monetization survey before it (`SurveyResponse`) sit in the same read-only
posture.

---

## Keyword Search & Bulk Playlist Edits

**User-facing**: Search track titles and artist names across playlists by
keyword, then remove the matches in bulk or copy them into another playlist.

**Backend**: `GET /api/playlists/search-tracks` fetches a page of playlists with
their full track lists and matches them via `lib/playlist-search.js`. A match is
one *occurrence* — `(playlistId, trackId, position)` — so the same track in
three playlists yields three rows, which is what makes "remove from everywhere"
possible, and two copies inside one playlist yield two rows. The removal path
can only name track ids (the write replaces a playlist's whole list), so the UI
selects duplicate copies as a unit and says so. Results are capped at 2,000
matches; over that the response carries `capped: true`.

`POST /api/playlists/tracks/bulk-remove` re-PUTs each playlist's surviving track
list (SoundCloud has no per-track delete). It reads every playlist first, with
`mapWithConcurrency` at `SC_READ_CONCURRENCY`, then writes sequentially with
`SC_WRITE_PACING_MS` **between** writes — not after skipped rows, failed reads,
or the last write. Per-playlist status is returned so a partial failure is
visible. `POST /api/playlists/tracks/bulk-add` appends to one target, skipping
tracks already present and stopping at 500.

**Every full-list write goes through `readPlaylistForRewrite`**
(`lib/playlist-transfer.js`). These endpoints replace a playlist's entire track
list, and `extractOrderedTrackIds` drops entries whose id is unusable — so a
read that came back short of the playlist's own `track_count` would silently
delete the difference. A mismatch throws `PlaylistReadIncompleteError`:
bulk-remove reports that playlist as an error row and continues; bulk-add,
`PUT /api/playlists/:id`, merge-into-existing, from-likes-into-existing, the
followed-likes append (`createOrAppendTrackIds`) and transfer-track return 409.
Playlists with no `track_count` are not guarded.

**Append writers never write less than the existing list.** Merge-into-existing,
from-likes-into-existing and `createOrAppendTrackIds` grow the target through
`writeGrowingPrefix` with `floor = existingIds.length`: every PUT is a prefix of
`[...existing, ...new]`, so it contains the whole existing list, and a later
write that fails (429 after retries, 5xx, timeout) leaves the target with all its
old tracks plus some new ones. The route still answers an error, and nothing
claims success. A target that already holds more than 500 tracks is refused with
409 before any write (`assertAppendable`, `PlaylistTooLargeError`), because
rewriting it at 500 would drop the rest. `tests/routes/playlist-append-truncation.test.js`
pins both.

**Rewrite reads are all-access, because SoundCloud's default hides blocked
tracks.** `GET /playlists/{id}` defaults `access` to `playable,preview`, so a
default read omits blocked tracks while `track_count` still counts them — which
made the guard refuse every playlist containing one (101 of 148 PUTs in
production). `readPlaylistForRewrite` therefore always calls
`getPlaylistWithTracks(..., { allAccess: true })` (`&access=playable,preview,blocked`).
Everything else keeps the default: the merge's *source* reads still filter
blocked tracks out of what gets merged in. A short read that survives all-access
means entries SoundCloud will not return at any level (deleted/private); that
is still refused, and logs `[playlist-rewrite] refused short read`.
`GET /api/playlists/:id?access=all` returns the same all-access read for the
pages that write back; without the parameter the response is unchanged.

**`PUT /api/playlists/:id` takes a client-declared `remove: number[]`
(≤500 positive ints; an id in both `tracks` and `remove` is a 400).** The guard
compares the *server's* read to `track_count`; it never compared the *client's*
list to the server's read, so once blocked tracks were readable a client that
had not loaded them would have deleted them. Now a track can leave a playlist
only if the client named it: after the guarded read, any id the server read that
is in neither `tracks` nor `remove` is **undeclared** and the write is refused
with 409 `{ code: 'PLAYLIST_OUT_OF_SYNC', error, undeclared }`. A short read is
409 `{ code: 'PLAYLIST_READ_INCOMPLETE', error, seen, expected }`. Ids in
`tracks` the server did not read are appends and allowed; ids in `remove` it did
not read are ignored. The comparison is count-aware: if the server read more
copies of an id than `tracks` carries and the id is not in `remove`, it is
undeclared (an id in both lists is a 400, so deliberately dropping one copy of
a duplicate is not expressible and is simply refused). The five pages that PUT
(health-check, activity-to-playlist, recently-played, downloads,
playlist-modifier) read with `allAccess` and show the server's `error` text via
`readApiErrorMessage`. health-check, downloads and playlist-modifier send
`remove`; activity-to-playlist and recently-played are append-only and send
none. On a 409 the pages show the server's message first and then invalidate
the playlist caches so "reload and try again" fetches fresh data. The one
exception is playlist-modifier, which reads the body's `code` (via
`errorMessageFromBody`): only `PLAYLIST_OUT_OF_SYNC` refetches and resets its
list and shows fixed text saying the playlist was reloaded and unsaved edits
were dropped; `PLAYLIST_READ_INCOMPLETE` and any other failure show the
server's own text and keep the user's edits.

**Both `/api/library/audit` and `/api/playlists/search-tracks` page by `offset`
against the cached playlist list, not against SoundCloud.** `/me/playlists`
declares only `show_tracks`, `linked_partitioning` and `limit`, and marks the
shared `offset` parameter deprecated — sending one returned page 1 on every
page while the UI claimed "playlists 21-40". `lib/playlist-pages.js` slices the
list `loadCachedPlaylists` already crawls by cursor for `GET /api/playlists`, so
the order is SoundCloud's own, `total` and `hasMore` are exact, and a page walk
costs one crawl rather than one query per page. The page object also carries
`stale` and `truncated` from the cache tier, and `failed[]` names the playlists
whose track fetch did not come back.

Both routes are on `libraryReadRateLimiter` (60/hour), not
`heavyOperationRateLimiter`: they are bounded reads (≤50 SoundCloud calls per
page) and were otherwise spending the 20/hour write budget shared with merge,
clone, and every bulk write.

---

## Environment Variables

### Server (`server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SOUNDCLOUD_REDIRECT_URI` | Yes | Must match the SoundCloud app registration. Production: `https://tracktoolkit.com/api/auth/callback` |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Production reads it from Key Vault `tracktoolkit-kv/database-url` (Azure Flexible Server, `?sslmode=require&connection_limit=10&pool_timeout=30`) |
| `APP_URL` | Yes | Canonical origin, and the target of the legacy-host redirects. Production: `https://tracktoolkit.com` |
| `APP_URLS` | Yes | Comma-separated CORS allowlist. Production is the single origin `https://tracktoolkit.com` — the app is same-origin, so there is nothing else to allow |
| `SURVEY_ENABLED` | No | Kill switch for a **future** in-app survey. It no longer affects the rebrand name vote, which is closed in code (`REBRAND_VOTE_CONCLUDED`) and cannot be switched back on from the environment |
| `SURVEY_CAMPAIGN_ID` | No | Campaign identifier for the (closed) vote, default `2026-rebrand-name-v1`. Only the admin read paths use it now; it no longer gates any prompt |
| `GROWTH_AUTOCHECK` | No | Set to `false` to disable the daily growth follow-back scheduler |
| `ADMIN_IDS` | No | Comma-separated SoundCloud numeric user IDs allowed into `/api/admin/*`. Unset or empty = **nobody** (fails closed) |
| `DOWNLOAD_ALLOWLIST` | No | Comma-separated SoundCloud numeric user IDs (plus every admin) that get `canDownload`: the Downloads page's "Download all" queue and Hypeddit tools, and `POST /api/downloads/links`. One definition, `server/lib/download-access.js`, backs both `/api/auth/me` and `requireCanDownload`. Unset = admins only |
| `SC_ROTATION_MEMO_TTL_MS` | No | How long the refresh-rotation memo in `soundcloud-client.js` keeps the last exchange's plaintext pair (default `60000`). It exists so a route's second SoundCloud call is not told its already-spent refresh token means "revoked". Lowering it costs an extra refused exchange per multi-call request at a token boundary; raising it keeps decrypted tokens in memory longer. It is **not** the safety net — `_resolveInvalidGrant` is — so a wrong value here degrades latency, not correctness |
| `CHROME_EXTENSION_IDS` | No | Comma-separated extension IDs allowed as credentialed origins (CORS + `rejectUntrustedOrigin`) |
| `SESSION_COOKIE_SAMESITE` | No | `lax`, `none` or `strict` for the session cookie. Unset keeps the historical default (`none` in production). Same-origin hosting sets `lax` |
| `LEGACY_REDIRECT_HOSTS` | No | Comma-separated hostnames Express redirects to `APP_URL` (301 GET/HEAD, 308 otherwise). Unset disables the middleware |
| `RETENTION_ENABLED` | No | Set to `false` to disable the daily retention purge. **Defaults to on** — a retention policy that is off by default is not a policy. Do not use this to preview a sweep: it schedules nothing, so it logs nothing, and the silence is indistinguishable from "nothing to delete". Use `RETENTION_DRY_RUN` |
| `RETENTION_DRY_RUN` | No | Exactly `true` (case-insensitive, trimmed; `1` and `yes` are deliberately **not** accepted) makes each scheduled run count everything and write nothing — every step logs `would remove N`, the user sweeps still log `will remove N users`, and no delete, update or upsert is issued. Intended for the first deploy after a retention change: read the counts, satisfy yourself, then remove the variable. **Set it in the App Service configuration, not in Bicep** — `infra/main.bicep` declares `appSettings` as a complete list with no parameter for this flag, and ARM replaces the whole list, so any `infra/deploy.sh` run silently ends the dry run. Code deploys are safe: the GitHub workflow is a zip deploy and does not touch settings |
| `RETENTION_INTERVAL_MS` | No | Sweep period (default 24h), **clamped to a 24h maximum in code** (`resolveIntervalMs`) and logged when a larger value is refused. First run is always 10 min after boot. Compliance-relevant, not a tuning knob: a longer period would eat the day of margin the 6-day disconnect window buys against the terms' 7-day deletion deadline, so it is enforced rather than documented. Lowering it is always allowed |
| `INACTIVE_MONTHS` | No | Dormant-account window in **calendar months** (default `24`) |

`NEXT_PUBLIC_API_BASE` (`frontend-UI/.env.local`, dev only) — e.g.
`http://localhost:3001`; omit in prod, where the API is same-origin.

---

## Development Commands

### Frontend

```bash
cd frontend-UI
npm run dev          # Next.js dev server with turbopack
npm run build        # Static export → frontend-UI/out/
npm run lint         # ESLint (npx tsc --noEmit && next lint)
npm run contrast     # Colour-token gate — exits 1 if any pair is under threshold
npm run test:e2e     # Playwright against out/ — run `npm run build` first
```

The full check before claiming a change is done: `npm test` at the repo root,
then from `frontend-UI` `npm run lint`, `npm run build`, `npm run contrast`,
`npm run test:e2e`. `test:e2e` runs against `out/`, so a stale build tests
stale code.

**E2E port, and the orphan that eats an afternoon.** The harness serves
`frontend-UI/out/` on `E2E_PORT` (default 4173), and `webServer` is configured
with `reuseExistingServer: true` so a hand-started server survives a run. That
flag adopts *anything* already listening — an aborted run's leftover, or
another worktree's harness serving a different checkout's `out/`. Such a server
answers `/` with a healthy 200, so Playwright is satisfied, and the whole suite
then runs against someone else's HTML and fails in ways that describe code you
are not editing.

`e2e/global-setup.mjs` refuses to start in that case: the static server exposes
`/__e2e/identity` carrying the absolute `out/` path it is serving, and the run
aborts unless that matches this checkout. The message names the command:

```bash
lsof -nP -iTCP:$E2E_PORT -sTCP:LISTEN   # find the process holding the port
E2E_PORT=4211 npm run test:e2e          # or just use another port
```

Two checkouts running the suite at once need different `E2E_PORT` values.

---

## Patterns & Conventions

### UI Primitives — the sanctioned way to build a control

These are not suggestions. Every page on `feat/trust-and-mobile` was converted
to them, the axe suite passes because of them, and a hand-rolled equivalent
re-introduces the defect the primitive exists to prevent.

- **Forms use `Field`** (`components/ui/Field.tsx`) — it owns the `<label
  htmlFor>` association, the error text and the `aria-describedby` wiring.
  `Field labelHidden` when a visible label genuinely does not fit (the three
  toolbar search boxes); never a placeholder as the only label. Raw
  `<select>` → `Select`.
- **Overlays use `Dialog`** (`components/ui/Dialog.tsx`, `variant="sheet"` /
  `"drawer"`) — focus trap, Escape, focus return, `aria-modal` and an
  accessible name from the heading. `ConfirmDialog` wraps it for the
  destructive-confirm case.
- **Icon-only controls use `IconButton`** with a `label` — never a bare
  `<button>` with a glyph, and never `title` as the accessible name.
- **Announce async results with `useAnnounce`** — it writes into the single
  `LiveRegion` mounted by `AppShell`, outside `<main>` so a route change
  cannot unmount it mid-announcement. Long operations also render a
  `ProgressBar` when there is something determinate to count.
- Errors are `InlineAlert variant="error"` (already `role="alert"`); lists of
  selectable things are `SelectableRow`/`SelectableList` (a real checkbox,
  `min-w-0` on the root); page chrome is `PageContainer` + `PageHeader`, which
  owns the single `h1`.

Colours go through the HSL tokens in `globals.css` — never a raw hex (except
the brand gradient) and never an alpha-modified text colour
(`text-muted-foreground/70`); use `text-muted-foreground-subtle`. `*-text`
tokens (`primary-text`, `destructive-text`, `success-text`, `warning-text`,
`info-text`) are the ones safe for small text; the plain `--primary`,
`--destructive` and `--chart-*` are surfaces and graphics.

### SoundCloud calls and write pacing

Every SoundCloud call goes through `scRequest()` in `soundcloud-client.js`
(401 refresh, 429 backoff). A loop that writes to SoundCloud paces with
`sleep(SC_WRITE_PACING_MS)` from `server/lib/pacing.js` — don't hardcode a
delay.

### Error Sanitization

`server/middleware/rateLimiter.js` and the global error handler both strip patterns like `token=`, `secret=`, `password=`, `encryption_key=` from error messages and JSON responses before they reach the client.

### Login Pre-warming

Before the OAuth redirect, the frontend pings `/health` (with a 1.2s timeout) to
warm the backend and reduce OAuth callback latency. It was written for a
free-tier dyno that slept; App Service has `alwaysOn`, so it now buys much
less — the timeout means it costs nothing either way, so it stays.

---

## Known Limitations & Edge Cases

1. **500-Track Playlist Cap**: SoundCloud enforces this server-side. Auto-splitting creates multiple playlists (e.g., "My Mix (1/3)"). Users must manage multiple playlists instead of one.

2. **Rate Limiting (429)**: SoundCloud's limits are undocumented. The app uses 300–500ms delays between API calls and respects `Retry-After` headers. Large bulk operations (unlike 1000+ tracks) will be slow and may still occasionally 429.

3. **Token Refresh Timing**: Tokens are only refreshed on-demand when a 401 occurs. There's no proactive refresh daemon. If a token expires mid-session, the next request triggers a refresh and retry — transparent to the user, but adds latency.

4. **Reposts API Inconsistency**: SoundCloud's V2 reposts endpoint is unreliable (sometimes returns 0 even when the user has reposts). The multi-fallback chain mitigates this but adds latency and complexity.

5. **Session cookie lifetime, not cross-origin**: the cross-site cookie
   requirement is gone — production is one origin with `SameSite=Lax; Secure`.
   What remains is that there is **no server-side session revocation list**:
   logout clears the cookie, but a previously exfiltrated cookie stays valid
   until its signed `iat` passes `SESSION_TTL_MS` (7 days). The `none` default
   in `resolveSessionSameSite` is still in the code for a split-host
   deployment, so `SESSION_COOKIE_SAMESITE=lax` is set explicitly rather than
   left implied. Local dev uses `Lax` over HTTP with the `next.config.js`
   rewrites.

6. **In-Memory URL Cache**: The `/api/resolve` cache is per-process and resets on restart. Not shared across multiple server instances. Cache TTL is 5 minutes. (The *library* cache — likes/playlists/followings/followers/reposts — is different: since the 2026-09 performance work it has a Postgres tier underneath that survives restarts. See `docs/performance-audit-2026-09.md`. Its invalidation marks are per-process, though: with more than one worker a second instance can republish a pre-mutation snapshot as `complete`, so the durable tier is only safe single-instance — which is why `infra/main.bicep` pins `capacity: 1` and `numberOfWorkers: 1`. See the header comment in `server/lib/social-cache.js`.)

   **The single worker is now load-bearing for more than the cache.** The
   revocation classifier (`_resolveInvalidGrant` in
   `server/lib/soundcloud-client.js`) decides whether a grant is gone by
   comparing the refresh token presented against the one in the row. Within one
   process the in-flight refresh map guarantees the row has been updated before
   any second caller reads it; across processes it does not, so two instances
   presenting the same token at a 401 can have the loser read a pre-update row,
   find it equal to what it presented, and **disconnect a live user**. The
   worst case of scaling out is therefore a destroyed account, not a stale
   list. Before raising `numberOfWorkers`, put a database-side guard on the
   rotation — a compare-and-swap on `tokens.refresh`, or a `rotatedAt` the
   loser can compare against.

7. **Static Export Limitation**: `next export` doesn't support Next.js API routes. All server logic must live in the Express backend. The frontend is pure client-side React.

8. **Bulk Operation Limits**: Bulk unlike and bulk unfollow are capped at 100 IDs per request (validated by middleware). Clients must chunk larger operations.

9. **SoundCloud Track Filtering**: Blocked (`blocked_at` set) and non-streamable tracks are silently excluded from merges. Users won't see an explicit count of what was filtered (only `acceptedTotal` vs `fetchedTotal` in the stats).

10. **Playlist Verification**: After creating a merged playlist, the app re-fetches it to verify the track count. If SC returns a lower count than expected (e.g., due to SC-side deduplication or delayed indexing), this is reported in stats but not retried.

---

## Deployment

### Architecture

One app, one origin. The Vercel + DigitalOcean + Neon split was retired at the
2026-09-20 cutover; `docs/internal/MIGRATION.md` is the record of it and
`infra/README.md` is the operator reference.

| Component | Platform | Notes |
|-----------|----------|-------|
| Frontend + backend | **Azure App Service** (`tracktoolkit`, Linux B1, Node 22) | One Express process serves `/api` and `frontend-UI/out/`. **One worker, pinned** — `capacity: 1` on the plan and `numberOfWorkers: 1` on the site (`infra/main.bicep`), because the library cache's invalidation marks are per-process (see `server/lib/social-cache.js`) |
| Database | **Azure Database for PostgreSQL Flexible Server** (`tracktoolkit-pg`, PG 17, Burstable B1ms) | `DATABASE_URL` comes from Key Vault `tracktoolkit-kv` |
| Secrets | **Azure Key Vault** (`tracktoolkit-kv`) | RBAC; the app reads by reference, so no secret is in the App Service config |
| Infrastructure | **Bicep** (`infra/main.bicep`, `infra/deploy.sh`) | `infra/main.cutover.bicepparam` is the live parameter set |

Retired, kept only as rollback until decommission: the DigitalOcean app
(`.do/app.yaml`), the Vercel project (`vercel.json`) and the Neon database.
None of the three is in the serving path.

### Domain Strategy

- One origin, `https://tracktoolkit.com` — the apex is canonical.
- `www.tracktoolkit.com`, `soundcloudtoolkit.com`, `www.soundcloudtoolkit.com`
  and `api.soundcloudtoolkit.com` are bound to the same app and 301/308 to the
  apex via `server/middleware/legacy-redirect.js` (`LEGACY_REDIRECT_HOSTS`).
  301 for `GET`/`HEAD`, 308 otherwise, path and query preserved.
- Session cookie is host-only and `SameSite=Lax` (`SESSION_COOKIE_SAMESITE=lax`);
  the OAuth redirect URI is `https://tracktoolkit.com/api/auth/callback`.
- Each of the five hostnames has an App Service managed certificate.

### CI/CD

**`main` deploys itself.** `.github/workflows/azure-deploy.yml` runs on every
push to `main` (PR #52, 2026-09-22, which replaced DigitalOcean's
`deploy_on_push`). It builds on Linux so the Prisma engine matches the App
Service image, runs the Jest suite, builds the Next.js static export, and
ships one zip. Oryx is disabled on the app
(`SCM_DO_BUILD_DURING_DEPLOYMENT=false`), so what the workflow zips is exactly
what runs.

Two consequences worth holding onto:

- **Merging to `main` is deploying.** Anything that has to happen before the
  code runs — the two unapplied files in `docs/sql/`, an App Service setting —
  has to happen *before* the merge, not after it.
- Pushes that only touch `**.md`, `docs/**`, `infra/**`, `.gitignore` or
  `LICENSE` skip the run. Infrastructure changes go through `infra/deploy.sh`
  instead, and manual `workflow_dispatch` stays for redeploys and for
  deploying a non-`main` ref.

Auth is OIDC through the `azure` GitHub environment: `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` are repository *variables*, not
secrets — they are identifiers, and there is no long-lived credential.

`.github/workflows/keep-api-warm.yml` curls `https://tracktoolkit.com/health`
every five minutes. It existed to keep a free-tier dyno awake and is redundant
now that App Service has `alwaysOn`; it is kept as an external uptime probe
and is marked for retirement in its own header.

The frontend has no separate pipeline: it is built inside that same workflow
and served by Express. There is no Vercel deployment any more.
