# Azure migration — working state

## CUTOVER DONE — 2026-09-20 (18:49–19:15 CEST window, redirects live 19:45)

Track Toolkit is served by Azure at https://tracktoolkit.com against the
Azure Postgres `tracktoolkit` database. Sequence as run:

1. 18:49 freeze: DigitalOcean `DATABASE_URL` hostname replaced (Option B);
   Neon pooled connections hit zero at 18:49:13.
2. 18:49–19:05 dump (230 s) → restore (692 s) → SQL → verify: all 16 tables
   identical (4,105 users, 578,450 tracks), 16 tables / 63 indexes / 13 FKs.
3. In parallel: PR #42 (`prep/domain-switch`) merged and deployed from main
   (e2d456c); cutover Bicep parameters applied (`APP_URL`,
   `SOUNDCLOUD_REDIRECT_URI`, legacy redirect hosts). Cole changed the
   SoundCloud OAuth redirect URI to `https://tracktoolkit.com/api/auth/callback`.
4. 19:05 Key Vault `database-url` → `tracktoolkit` DB; app healthy at 19:15
   (the parameter deploy had detached the custom-domain certificates at
   19:01; rebound by hand; template fixed so bindings reference the managed
   certificates).
5. Verified on tracktoolkit.com: login 302 → SoundCloud with the new
   callback; authenticated smoke test on Cole's account 200 (29 playlists);
   writes land in Azure (`operation_logs` 22,369 → 22,371).
6. 19:30 Cole repointed soundcloudtoolkit.com DNS (Namecheap): apex A,
   `www`/`api` CNAME, three `asuid` TXT. Hostnames bound, managed
   certificates issued; redirects verified: apex/www 301 with path+query,
   `api` POST 308, HTTP→HTTPS→301, one hop to a 200 on tracktoolkit.com.
   (Superseded: the domain is now at Spaceship and so is its DNS — see
   "Incident 2026-10-29" below.)

Rollback (until the old stack is decommissioned): restore DigitalOcean's
`DATABASE_URL`, point the old DNS back at Vercel/DigitalOcean, set the
SoundCloud redirect URI back to `https://api.soundcloudtoolkit.com/api/auth/callback`.
Writes made on Azure after 18:49 would need a reverse dump. Neon is intact.

7. 19:44 Cole logged in through the browser on tracktoolkit.com: OAuth code
   exchange with the new redirect URI succeeded (`auth-login` operation and a
   fresh `tokens` row at 17:44:13 UTC in the Azure DB), playlists loaded.
   **Migration verified end to end.**
8. Search Console: `tracktoolkit.com` Domain property verified (DNS TXT),
   sitemap submitted. Change of address left for Cole (two clicks on
   Settings → Change of address in the soundcloudtoolkit.com property; the
   page's dropdown hangs the browser extension).

Still open: one-week soak, then decommission in this order — DigitalOcean
app (still running with a broken `DATABASE_URL`), Vercel project, Neon last
(keep a month) — then rotate the SoundCloud client secret at SoundCloud and
in Key Vault, retire `.do/app.yaml` and `vercel.json`, and add
`/og-image.png`.


Durable state for the DigitalOcean + Vercel + Neon → Azure move and the
tracktoolkit.com domain switch. A fresh session resumes from this file plus
`git log`. Companion documents: `infra/README.md` (operator reference),
`docs/azure-db-cutover.md` (the rehearsed database procedure).

Started 2026-09-19 (overnight run) on branch `azure/migration`, which is
branched from `claude/keen-newton-02qlh4` (the rebrand commit, draft PR #39).
Nothing here touches production: DigitalOcean, Vercel, Neon and DNS are
untouched and remain the rollback plan.

## Status at a glance

| # | Work item | State |
|---|---|---|
| 1 | Provision Azure in parallel, /health 200 | **done** — /health 200 on 2026-09-20 12:43 CEST after the secrets landed (B1 cleared) |
| 2 | Rehearse the database migration, write docs/azure-db-cutover.md | **done** — 16 min measured, `docs/azure-db-cutover.md` |
| 3 | Secrets reachable? decrypt round-trip | **done** — readable; 4089/4089 token rows decrypt with the DigitalOcean key |
| 4 | prep/domain-switch branch + 301 design | **done** (branch `prep/domain-switch`, 86b9d08, not merged, not pushed) |
| 5 | Verification (tests, tsc, lint, build, login redirect) | **done** — login 302s to secure.soundcloud.com with the Azure callback as redirect_uri (2026-09-20) |
| 6 | Fix CLAUDE.md cookie-domain error | **done** (commit on this branch) |

## Resources (Azure subscription "Azure subscription 1", 14ca6838-…)

| Resource | Name / host | Notes |
|---|---|---|
| Resource group | `rg-tracktoolkit` | `westus3` |
| App Service plan | `tracktoolkit-plan` | Linux B1, capacity 1 pinned |
| Web app | `tracktoolkit` → https://tracktoolkit.azurewebsites.net | Node 22 LTS, `node server/index.js`, health `/health` |
| Postgres | `tracktoolkit-pg.postgres.database.azure.com` | Flexible Server PG17, B1ms, admin `tracktoolkit_admin` (password in Key Vault `postgres-admin-password`) |
| Databases | `tracktoolkit` (empty, prod-to-be), `tracktoolkit-rehearsal` (throwaway) | |
| Key Vault | `tracktoolkit-kv` | RBAC; secret names listed in `infra/deploy.sh` |
| Log Analytics | `tracktoolkit-logs` | |
| Entra app for GitHub OIDC | `gh-tracktoolkit-deploy` (appId 8b48e1d8-…) | federated subject `repo:cole-hackman@83625748/tracktoolkit@1053639544:environment:azure` (GitHub now issues the subject with the owner and repository ids embedded, so it survives renames), Website Contributor on the RG |
| GitHub | environment `azure`; variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | |

Current production for reference: DigitalOcean app `sctoolkit-backend`
(69dbca20-…, region sfo, size apps-s-1vcpu-0.5gb, API-only — it does not
build the frontend), Vercel project `soundcloud-tool`, Neon project
`SoundCloud-Toolkit` (mute-recipe-09351558, PG 17.11, 485 MB, us-west-2).
Note `.do/app.yaml` says the app is called `soundcloud-toolkit-api`; the live
app is `sctoolkit-backend` with service `soundcloud-toolkit`.

## Work item 1 — Azure provisioning

### Decision: App Service, not Container Apps

App Service (Linux, B1, one instance) because:

- It matches what DigitalOcean App Platform does today: a Node runtime, a
  start command, a health check, no Dockerfile and no registry to maintain.
- **A single instance is the default, not something to defend.** Basic tier
  has no autoscale rules; `elasticScaleEnabled: false` keeps the newer
  automatic scaling off; `capacity: 1` is pinned in `infra/main.bicep` with a
  comment pointing at the invalidation-mark header in
  `server/lib/social-cache.js`. Container Apps scales on HTTP concurrency by
  default and would need `minReplicas = maxReplicas = 1` plus a note for
  anyone who "helpfully" raises it.
- Health-check restarts, managed TLS certificates for custom domains, Key
  Vault references in app settings and Log Analytics wiring are built in.
- Cost is comparable: B1 is about $13/month; a Container Apps replica held at
  one always-on instance lands in the same range and adds a registry.

What it costs: cold deploys take a minute or two to swap in, and the B1 box
has 1.75 GB RAM, so the frontend is built in GitHub Actions rather than on the
box (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`).

### Decision: same origin (Express serves `frontend-UI/out`), not Static Web Apps

`server/index.js` already serves the static export when the directory
exists, so this is zero code. What it buys:

- The session cookie can drop from `SameSite=None` to `Lax`
  (`SESSION_COOKIE_SAMESITE=lax`, added on this branch, default unchanged).
  The browser then never attaches it to a cross-site request, which removes
  the whole class of CSRF that `rejectUntrustedOrigin` and the JSON-only body
  parser currently defend against. Both defenses stay.
- The CORS / Origin allowlist collapses to one origin instead of five.
- The OAuth redirect URI loses the `api.` subdomain
  (`https://tracktoolkit.com/api/auth/callback`).
- One host, one certificate, one deploy.

The tradeoff: static assets are served by Express from the app box instead of
a CDN edge. For this traffic (thousands of users, not millions) that is fine;
`express.static` sends ETags and a one-day max-age. If it ever matters, Azure
Front Door in front of the same app fixes it without changing the origin
model. The personal Chrome extension (`CHROME_EXTENSION_IDS`) does credentialed
cross-origin fetches; under `Lax` those lose the cookie. It is sideloaded and
personal, so that is accepted and noted here rather than designed around.

### Region

`westus2` (closest to the current sfo/us-west-2 stack) has **no Burstable
Postgres capacity for this subscription** (`list-skus` returns an empty
version list). Everything was moved to `westus3`, which offers B1ms with PG
11–18. The first westus2 deployment was deleted and the soft-deleted vault
purged so the names could be reused.

### Deployment pipeline

`.github/workflows/azure-deploy.yml`, manual trigger. Builds on Linux (Prisma
engine must match the App Service image), runs `npm test`, builds the static
export, zips `server/ prisma/ node_modules/ frontend-UI/out` and ships it with
OIDC (no stored secret). When the cutover is done, add `push: [main]`.

### Verification (2026-09-19, 21:27–21:50 CEST)

- `infra/deploy.sh` (Bicep) succeeded in `westus3`: every resource in the
  table above exists. Deployment name `tracktoolkit-20260919212721`.
- Code deployed with `az webapp deploy --type zip` (44 MB: `server/`,
  `prisma/`, production `node_modules` installed in a `node:22-bookworm`
  **amd64** container so the Prisma engine is `debian-openssl-3.0.x`, and
  `frontend-UI/out` from a green `next build`). App Service deployment log:
  "Deployment successful. deployer = OneDeploy" at 19:49:24 UTC.
- `GET https://tracktoolkit.azurewebsites.net/health` → **500** with body
  `{"error":"Server configuration error","message":"Server is not properly configured. Check environment variables."}`.
  That body is `validateEnv` in `server/middleware/security.js`, and the
  App Service log stream shows `[ERROR] Environment variable validation
  failed` every 5 s from the health probe — so the deployed Express app is
  running the shipped code; it is refusing to serve because the Key Vault
  references resolve to nothing (Blocked B1). The moment the six secrets
  exist and the app restarts, this is a 200. I could not get there tonight.
- First attempt on a Docker arm64 image produced a `linux-arm64` Prisma
  engine, which would not load on App Service (x64); the `--platform
  linux/amd64` rebuild fixed it. The GitHub workflow builds on x64 runners
  and does not have this problem.

## Work item 2 — Database rehearsal

Source measurement (Neon, direct endpoint, `psql`, 2026-09-19 21:28 CEST):
PostgreSQL 17.11, 485 MB, row counts in 9 s:

| table | rows |
|---|---|
| beta_signups | 235 |
| chat_conversations | 19 |
| chat_messages | 75 |
| growth_actions | 6220 |
| indexed_likes | 1021 |
| indexed_playlist_tracks | 1242 |
| library_cache_pages | 901 |
| library_cache_states | 401 |
| library_snapshots | 1 |
| operation_logs | 22091 |
| playlists | 3882 |
| rebrand_votes | 378 |
| survey_responses | 320 |
| tokens | 4089 |
| tracks | 576427 |
| users | 4089 |

Rehearsal run (all steps timed; full procedure, commands and rollback in
`docs/azure-db-cutover.md`):

| step | measured |
|---|---|
| Neon row counts (psql, direct endpoint) | 9 s |
| `pg_dump -Fc` Neon → 145 MB archive (Docker `postgres:17`) | 219 s |
| `pg_restore -j 4` into `tracktoolkit-rehearsal` (B1ms) | 671 s, 0 stderr lines |
| `docs/sql/2026-library-cache.sql` | 3 s (no-op: the dump already carries both tables) |
| Azure row counts + diff + structure | ~10 s |
| **downtime window** | **~16 min measured; budget 25, announce 30** |

Row counts: 15 of 16 tables identical; `operation_logs` was 22092 on Azure
against 22091 counted on Neon eleven minutes earlier, and 22093 on a recount
afterwards — live production writing between count and dump, which is
exactly what the freeze step in the procedure prevents. Structure matches:
16 tables, 63 indexes, 13 foreign keys, 0 sequences on both sides. Restored
size 408 MB (Neon reports 485 MB including its own overhead).

Two operational findings worth knowing before the real run:

- The Homebrew `libpq@17` `pg_dump` on this Mac hangs forever in the libpq
  connection poll against Neon (direct and pooler, with and without channel
  binding / GSS), while `psql` from the same keg connects instantly. Root
  cause not chased; the procedure uses `docker run postgres:17` for every
  client command, which worked first time and pins the client version.
- `library_cache_pages` (901 rows of large JSONB) is the restore's long
  tail, not `tracks` (576 k rows). If the window ever needs shrinking,
  that table is also safe to leave behind: the app treats it as a cache and
  rebuilds it (`snapshot-cache.js` fails soft).

## Work item 3 — Secrets

**Readable.** The DigitalOcean MCP (`apps-get-info`) returns every env var
of `sctoolkit-backend` in plaintext, including `ENCRYPTION_KEY`,
`SESSION_SECRET`, `SOUNDCLOUD_CLIENT_SECRET` and the Neon `DATABASE_URL`.
They are not typed as `SECRET` in the DigitalOcean spec, which is why the API
hands them back. The values are **not** written anywhere in this repo; they
go into `tracktoolkit-kv` under the names in `infra/deploy.sh`, and the app
settings reference them, so nothing changes in code at cutover.

The root `.env` on this machine holds the same `DATABASE_URL` host and both
secrets by name; whether its values match production is settled by the
decrypt round-trip below, not by comparing files.

**Decrypt round-trip: passed.** Against the restored `tokens` table in
`tracktoolkit-rehearsal`, with `ENCRYPTION_KEY` set to the DigitalOcean
value:

| run | rows | decrypted | failed |
|---|---|---|---|
| sample, newest 100 rows | 100 | 100 | 0 |
| full table | 4089 | 4089 | 0 |
| negative control, all-zero key | 5 | 0 | 5 (GCM auth tag mismatch) |

AES-256-GCM authenticates every blob, so a key that is off by one byte fails
every row; 4089/4089 is proof the DigitalOcean value is the key that wrote
production. `SESSION_SECRET` cannot be proven the same way (there is no
stored artefact to verify against), but it comes from the same source.

Also checked: the root `.env` on this workstation carries byte-identical
`ENCRYPTION_KEY` and `SESSION_SECRET` to DigitalOcean (string compare; the
values were not printed). So the secrets exist in three places already:
DigitalOcean, the local `.env`, and — once B1 is cleared — Key Vault.

Wiring: `infra/main.bicep` app settings are Key Vault references by name
(`encryption-key`, `session-secret`, …). Nothing in code names a vault or a
value; cutover is "the secret exists in the vault".

## Work item 4 — Domain switch

Branch `prep/domain-switch` (commit 86b9d08, one commit on top of
`azure/migration` 5cb6a0d), committed, **not merged and not pushed**. Review
it with `git diff azure/migration..prep/domain-switch`.

Canonical origin is the apex, `https://tracktoolkit.com` (assumption: the
brief says "a switch to tracktoolkit.com"; `www.` redirects to the apex).

What it changes:

- Frontend: canonical, OpenGraph/Twitter URLs, `metadataBase`, JSON-LD
  (`StructuredData.tsx`), `robots.txt`, `sitemap.xml` (lastmod 2026-09-19),
  the hero mock URL bar → `tracktoolkit.com`.
- Server: `TRACK_TOOLKIT_PLAYLIST_SITE` (playlist footer) → `tracktoolkit.com`.
- `server/middleware/legacy-redirect.js` (new, mounted first in
  `server/index.js`): hosts listed in `LEGACY_REDIRECT_HOSTS` get a 301
  (GET/HEAD) or 308 (everything else, so stale API clients keep their method)
  to `APP_URL` + original path and query. Unset = no-op. Five tests in
  `tests/routes/legacy-redirect.test.js`.
- `infra/main.cutover.bicepparam`: `appUrl`/`appUrls`/`soundcloudRedirectUri`
  on tracktoolkit.com, the five hostnames bound to the app
  (tracktoolkit.com, www.tracktoolkit.com, soundcloudtoolkit.com,
  www.soundcloudtoolkit.com, api.soundcloudtoolkit.com), and the four
  non-canonical ones in `legacyRedirectHosts`.
- `keep-api-warm.yml` pings the new host; CLAUDE.md env table and Domain
  Strategy updated.
- Env values that move with it (all already parameters in Bicep, nothing in
  code): `SOUNDCLOUD_REDIRECT_URI=https://tracktoolkit.com/api/auth/callback`,
  `APP_URL=APP_URLS=https://tracktoolkit.com`.

### Where the soundcloudtoolkit.com 301 lives

In Express, on the same App Service, not in Front Door and not in a stub
app. Once DNS for the three old hosts points at `tracktoolkit.azurewebsites.net`
and they are bound (with managed certificates) to the app, the middleware
answers every request on those hosts with a redirect. Front Door Standard
costs more per month than the whole app and would exist only to emit one
header; a stub App Service would be a second thing to keep patched. The IaC
is in place and inert: `customHostnames` and `legacyRedirectHosts` are empty
in `main.bicepparam` and populated in `main.cutover.bicepparam`.

Cutover order for the domain (after the database cutover):
1. DNS for tracktoolkit.com / www → App Service (A + TXT `asuid` for the
   apex, CNAME for www).
2. Change the SoundCloud OAuth app's redirect URI to
   `https://tracktoolkit.com/api/auth/callback` (check-in-first item).
3. `infra/deploy.sh` with `main.cutover.bicepparam`, then managed certs
   (`infra/README.md`, "Custom domains").
4. Merge `prep/domain-switch`, deploy the code.
5. Repoint soundcloudtoolkit.com / www / api DNS at the App Service; the
   redirects start answering. Then retire DigitalOcean and Vercel.

Pre-existing gaps noticed on the way (not fixed): `/og-image.png` is
referenced by the OpenGraph and Twitter metadata but does not exist in
`frontend-UI/public`, so link previews are already broken today; the JSON-LD
`aggregateRating` (4.8 from 150) has no data behind it, which conflicts with
the "no fabricated social proof" decision in docs/internal/STATE.md; `vercel.json` still
rewrites `/api` to api.soundcloudtoolkit.com and is dead weight once Vercel
is gone.

## Work item 5 — Verification

On `azure/migration` (5cb6a0d + docs/internal/MIGRATION.md commits), 2026-09-19:

| check | result |
|---|---|
| `npm test` (root) | 45 suites, 395 tests, all passing |
| `npx tsc --noEmit` (frontend-UI, after `npm ci`) | exit 0 |
| `npx next lint` | no warnings or errors |
| `npm run build` (frontend-UI, static export) | exit 0, `out/` produced and shipped in the zip |
| Server boots on Azure | yes — see work item 1 (500 from validateEnv, not a crash) |
| `/health` = 200 on Azure | **not yet** — Blocked B1 |
| Login reaches SoundCloud authorize redirect | **not yet** — every request 500s until B1; the command to check is in B1 |
| Static frontend served by Express on Azure | **not yet** — same reason; `frontend-UI/out` is in the deployed package |

On `prep/domain-switch` (86b9d08): 46 suites, 400 tests passing; lint
clean; tsc clean once `@tanstack/react-virtual` is installed (it is in
`package.json`; a stale local `node_modules` lacked it).

## Work item 6 — CLAUDE.md cookie domain

Done. `createSessionCookieOptions()` sets no `domain`; the cookie is host-only
on `api.soundcloudtoolkit.com` and crosses to `www.` only through
`SameSite=None; Secure`. Both places in CLAUDE.md that claimed
`Domain=.soundcloudtoolkit.com` (the cookie table and "Domain Strategy") now
say so.

## 2026-09-20 session — merges, allowlist, smoke test, rotation, domain dry run

### PR #39 (rebrand) and PR #40 (azure/migration) are on main

- PR #39 reviewed by hand against the six load-bearing claims in its body,
  plus `npm test` (391/45), `tsc`, `next lint`, `next build` and a local boot
  serving `/health`; a diff-scoped security review found nothing. One
  comment-only fix (4a7c6bd). Review record posted as a PR comment. Merged
  as 8731b98.
- PR #40 (`azure/migration` → main): `git merge-tree` clean, merged as
  50b659e. The GitHub Actions deploy is dispatchable from now on (B2 cleared).
- `prep/domain-switch` stays unmerged; it merges cleanly onto the new main
  (`git merge-tree --write-tree origin/main origin/prep/domain-switch` exits
  0, no conflicts), 46 suites / 400 tests green on it.
- The `/code-review` tool, asked for PR #39, reviewed the whole
  `azure/migration` diff instead. Its three correctness findings are about
  code that reached main in #34–#37 and are listed under Follow-ups; none is
  a migration blocker.

### DOWNLOAD_ALLOWLIST (Part 1)

Read from the DigitalOcean app spec (3 ids), written to Key Vault
`download-allowlist` through `infra/deploy.sh`, reference status `Resolved`,
the running app sees 3 ids, `/health` still 200.

### Authenticated smoke test without a browser (Part 2) — the procedure

Proves session HMAC verification, the user lookup, AES-256-GCM decrypt under
the Azure `ENCRYPTION_KEY`, a live SoundCloud call, Key Vault reference
resolution and the Postgres cache tier — everything the browser test proves
except the OAuth code exchange. GET routes only; writes would hit the real
SoundCloud API. Use your OWN `soundcloudId` only.

```bash
S=$(mktemp -d) && chmod 700 "$S"
# 1. Your user row, from the database the app is pointed at.
docker run --rm postgres:17 psql "$DATABASE_URL" -Atc \
  'select row_to_json(u) from (select id, "soundcloudId", username, "avatarUrl", "displayName" from users where "soundcloudId"=<your id>) u' > "$S/me.json"
# 2. Mint the cookie with the app's own signer (repo root, SESSION_SECRET from the vault, never echoed).
cat > "$S/mint.mjs" <<'JS'
import { readFileSync, writeFileSync } from 'fs';
import { signSession } from './server/lib/session.js';
const u = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const data = { userId: u.id, soundcloudId: u.soundcloudId, username: u.username, avatarUrl: u.avatarUrl, displayName: u.displayName, iat: Date.now() };
writeFileSync(process.argv[3], 'session=' + signSession(JSON.stringify(data), process.env.SESSION_SECRET), { mode: 0o600 });
JS
cp "$S/mint.mjs" ./.mint.mjs && SESSION_SECRET="$(az keyvault secret show --vault-name tracktoolkit-kv --name session-secret --query value -o tsv)" node ./.mint.mjs "$S/me.json" "$S/cookie.txt"; rm ./.mint.mjs
# 3. Exercise the app.
H=https://tracktoolkit.azurewebsites.net
for p in /api/auth/me /api/playlists "/api/likes/paged?limit=5" "/api/library/audit?limit=5"; do
  printf '%-32s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -H "Cookie: $(cat "$S/cookie.txt")" "$H$p"; done
# (send it as a header: `curl -b <file>` expects a Netscape cookie jar and silently sends nothing for a plain session=... line)
# 4. Destroy the cookie.
rm -rf "$S"
```

Expect 200 on all four. Run on 2026-09-20 16:01 UTC against main
(50b659e) on the Azure app, own account only:

| route | status | time |
|---|---|---|
| `/api/auth/me` | 200 (userId, soundcloudId, username, isAdmin, canDownload…) | 0.9 s |
| `/api/playlists` | 200, 29 playlists | 3.4 s |
| `/api/likes/paged?limit=5` | 200, 5 items, `next_href` present | 1.0 s |
| `/api/library/audit?limit=5` | 200 (`summary`, `playlists`, `failed`, `page`) | 2.2 s |
| `/api/auth/me`, last signature byte altered | 401 "Invalid session" | |

The cookie file was deleted afterwards. The side effect below DID happen:
the copied access token had expired, the app refreshed it, and the
rehearsal `tokens` row for this account now has `updatedAt` 16:01:28 UTC,
`expiresAt` 17:01 UTC. Note the side effect: if the copied access token
has expired, the app refreshes it through SoundCloud and stores the new pair
in the database it is pointed at; SoundCloud refresh tokens are single-use,
so the OTHER stack (DigitalOcean, still on Neon) loses the ability to refresh
that one account until its owner logs in again. Only your own account is
affected, which is why the test is restricted to it.

### ENCRYPTION_KEY rotation script (Part 3)

`server/scripts/rotate-encryption-key.js` (+ `tests/rotate-encryption-key.test.js`,
7 tests). Exercised against `tracktoolkit-rehearsal` on 2026-09-20 with a
throwaway 32-char key, then rotated back so the database still matches the
Azure app's key:

| step | result |
|---|---|
| `--dry-run` current → throwaway | scanned 4089, would rotate 4089, 0 undecryptable, nothing written |
| real run current → throwaway | rotated 4089 / 4089 |
| decrypt round-trip, throwaway key | 4089 / 4089 |
| decrypt round-trip, current key | 0 / 4089 (every row fails, as it must) |
| re-run current → throwaway | skipped 4089, rotated 0 (idempotent) |
| real run throwaway → current | rotated 4089 / 4089 |
| decrypt round-trip, current key | 4089 / 4089 |

`changedUnderneath` stayed 0 throughout (no token refresh landed mid-run).
Timing: each real pass over 4089 rows took roughly 10–15 minutes from this
workstation because every row is one guarded `UPDATE` inside the batch
transaction and the round trip to `westus3` is ~150 ms; the same pass from a
box inside Azure would be seconds. Plan the production rotation
(post-cutover, once DigitalOcean is gone) from an Azure-side shell or accept
the window. Never run it against production while both stacks are live: the
old stack would lose the ability to decrypt.

### Domain-switch dry run (Part 4)

- `prep/domain-switch` (86b9d08): 46 suites / 400 tests green; merges cleanly
  onto main at 50b659e (`git merge-tree` exit 0, no conflicts).
- Deployed to the parallel Azure app via the workflow, `LEGACY_REDIRECT_HOSTS`
  set to `legacy.example.test`, then exercised. App Service routes by `Host`
  and answers 404 itself for a hostname that is not bound to the app, so a
  raw `Host:` header never reaches Express; behind `trust proxy`, Express's
  `req.hostname` reads `X-Forwarded-Host`, which the platform passes through:

  | request | result |
  |---|---|
  | GET `/about/?x=1`, forwarded host listed | 301 → `https://tracktoolkit.azurewebsites.net/about/?x=1` |
  | POST `/api/x`, forwarded host listed | 308 → `https://tracktoolkit.azurewebsites.net/api/x` |
  | GET, forwarded host `LEGACY.Example.TEST` | 301 (case-insensitive) |
  | GET, canonical host | 200, no redirect |
  | GET, unlisted forwarded host | 200, no redirect |
  | `/health` | 200 |

  Matches `tests/routes/legacy-redirect.test.js`. Setting reverted to empty,
  main redeployed afterwards. At cutover the retired hostnames are real
  bindings on the app, so the platform routes them in and `Host` is what the
  middleware sees; the forwarded-header path was only the way to test it
  before DNS exists.
- `SESSION_COOKIE_SAMESITE` is `lax` on the live app, from the Bicep default
  and `main.bicepparam`; there are no deployment slots and no other setting
  touches it.

### Domain bound (2026-09-20, evening)

tracktoolkit.com registered at Spaceship (nameservers launch1/launch2).
DNS: apex A → 20.118.138.138, `www` CNAME → tracktoolkit.azurewebsites.net,
`asuid` and `asuid.www` TXT → the app's customDomainVerificationId. Both
hostnames bound (`Verified`) and carrying App Service managed certificates
(DigiCert, valid to 2027-03-20); `https://tracktoolkit.com/health` and
`https://www.tracktoolkit.com/health` return 200, HTTP 301s to HTTPS. Done
with `az webapp config hostname add` / `ssl create` / `ssl bind`; the
cutover Bicep params re-declare the same bindings idempotently. No traffic
is routed yet: the OAuth redirect URI, `APP_URL` and the old domain's DNS
are unchanged, and the app still uses `tracktoolkit-rehearsal`.

## Incident 2026-09-21 — admin dashboard 500s (Prisma pool exhaustion)

Symptom: `/admin` requests 500 after ~10 s; `/api/auth/me` too during the
burst. Not the old database: the app was (and is) on `tracktoolkit-pg` /
`tracktoolkit`. Container log: Prisma `P2024` "Timed out fetching a new
connection from the connection pool (pool timeout: 10, connection limit: 3)".

Cause: Prisma sizes its pool at `cpus*2+1`; the B1 App Service has one vCPU
→ 3 connections. The admin page fires 7 requests at once, `/admin/stats`
alone issues 12 queries, and two catalog queries are slow on B1ms
(`/admin/catalog/summary` 5.5 s, `/admin/catalog/tracks` 13.5 s measured
alone) — everything queued behind them past the 10 s pool timeout.
Reproduced with a concurrent burst (all requests ~8 s), so the previous
report at 15:47 UTC simply crossed the line.

Fix (config only): Key Vault `database-url` now ends
`?sslmode=require&connection_limit=10&pool_timeout=30` (server max 50, one
app instance). After the re-resolve nudge the same 8-request burst, run
twice: all 200; the five aggregate endpoints and `/api/auth/me` in 0.7–1.5 s,
the two catalog endpoints at their own ~7.5 s cost; zero `P2024` since.

Catalog queries (done 2026-09-21, same day): profiled with EXPLAIN ANALYZE
on the Azure database. Two causes, two fixes:
- No visibility map / hint bits after `pg_restore`: the genre breakdown was
  an 11.8 s seq scan dirtying pages. `VACUUM (ANALYZE) "tracks",
  "operation_logs"` → 0.48 s (index-only scan). Added as step 4b of
  `docs/azure-db-cutover.md`.
- `docs/sql/2026-catalog-admin-indexes.sql`, applied `CONCURRENTLY`: a
  partial index on `operation_logs("createdAt") WHERE metadata ? 'trackIds'`
  (touches CTE 666 → 443 ms; it no longer reads the 79 % of rows it
  discarded) and an expression index on
  `COALESCE("artistId"::text, "artistName")` (distinct-artist count 2.1 s →
  0.7 s warm; a cold reading right after the build was 5.2 s, which is why
  it was briefly dropped and re-added). Neither can be declared in
  `schema.prisma`, so a `prisma db push` would drop them — the file header
  says so.
- Endpoints after: `/admin/catalog/summary` 5.5 → 2.6 s, `/admin/catalog/tracks`
  13.5 → 4.6 s alone; in the dashboard burst the worst request went from
  8.3 s to about 6 s and nothing else exceeded 1.2 s. The remaining cost is
  the touches aggregation itself (381 k array elements → 214 k track ids,
  computed once per parallel worker) and would need a query change
  (`MATERIALIZED` CTE, or a materialised touches table) or a larger tier. Also: while investigating, an Azure Monitor query with
`--interval PT1M` returned future buckets as `is_db_alive=0`; the server was
never down — read metric timestamps against `date -u`.

## 2026-09-21 — repository cleanup

- PRs: #44 (post-cutover docs/SQL), #46 (`llms.txt`), #47 (`llms.txt`
  rewritten for Track Toolkit / tracktoolkit.com — the salvaged file still
  said "SC Toolkit" and pointed at the old domain) merged; #27 (planning)
  closed. #28 (Rekordbox sync, draft, 124 commits behind) left open.
- Remote branches deleted after verifying each was an ancestor of main:
  `azure/migration`, `prep/domain-switch`, `claude-branding`,
  `claude/keen-newton-02qlh4`, `claude/cache-serving-races`,
  `claude/fix-snapshot-invalidation-races`,
  `claude/rebrand-survey-names-3ue8dk`; plus `initialized` and
  `backup-remote-main` (2025 history with no relation to main).
- Kept: `feature/ai-library-chat` (130 commits; owns the `chat_*`,
  `indexed_*`, `library_snapshots` tables the production schema declares),
  `codex-branding` (archived runner-up identity, per the logo decision),
  `claude/modest-thompson-pukoby` (not created by this work).
- This file and the other internal documents moved to `docs/internal/`.
  The Azure work is finished; further changes branch from `main`.

## 2026-09-21 — repository renamed to cole-hackman/tracktoolkit

GitHub redirects the old slug, but the Azure OIDC federated credential is
matched on the token subject, which carries the current repo name. Updated
`gh-env-azure` on app `gh-tracktoolkit-deploy`. The plain
`repo:cole-hackman/tracktoolkit:environment:azure` form still failed
(AADSTS700213): GitHub now issues the subject with ids embedded,
`repo:cole-hackman@83625748/tracktoolkit@1053639544:environment:azure`.
That exact string is the credential now; deploy run 35659806107 passed
login, deploy and smoke test. It survives future renames. Local remote and README clone URL updated;
`.do/app.yaml` and the DigitalOcean guides still say the old slug and are
left as retired history.

## Incident 2026-10-29 — soundcloudtoolkit.com stopped resolving

Symptom: the legacy redirect was down. `soundcloudtoolkit.com`, `www.` and
`api.` returned no A or CNAME at all; tracktoolkit.com was unaffected.

Cause: the domain is registered at Spaceship (the registry's last update on
it is 2026-09-26 05:17 UTC, which looks like when it moved), but its
delegation still named Namecheap's `dns1/dns2.registrar-servers.com`. Those
servers answer REFUSED for the zone: Namecheap dropped the records that step
6 of the cutover created there. With no DNS, requests never reached the
Express middleware. The App Service bindings and certificates were intact
throughout. The outage start is not established; it was noticed on
2026-10-29.

Fix (DNS only, no deploy):
- Spaceship → soundcloudtoolkit.com → Nameservers: Spaceship nameservers
  (`launch1/launch2.spaceship.net`), no auto-import (the old servers had
  nothing to import). The `.com` delegation picked it up within minutes.
- Spaceship Advanced DNS, the same records as before: apex A →
  20.118.138.138, `www` and `api` CNAME → tracktoolkit.azurewebsites.net,
  `asuid`, `asuid.www`, `asuid.api` TXT → the app's
  customDomainVerificationId. TTL 30 min.

Verified the same day over HTTPS: all three hosts 301 to
`https://tracktoolkit.com/` with the path kept (`/faq` → `/faq/` in one
hop), `api` POST 308, HTTP 301s to HTTPS, and 8.8.8.8 / 1.1.1.1 resolve
every record. The managed certificates on all three are valid to
2027-03-20. They renew only while DNS points at the app, so this would
have broken them at the next renewal.

Both domains now use Spaceship as registrar and as DNS. None of this app's
DNS is served from Namecheap any more.

## Blocked

### B1. Key Vault secret writes — CLEARED 2026-09-20

Cole granted his user Key Vault Secrets Officer and approved the writes. Done
in that session:

- Postgres admin password rotated (the original had been exposed in a tool
  output): 40-char alphanumeric, applied with
  `az postgres flexible-server update`, stored as `postgres-admin-password`.
  Never printed.
- The six app secrets written via `infra/deploy.sh` from the root `./.env`
  (the production file: Neon host, 32-char key, 57-char session secret;
  `server/.env` is the localhost mock). `DOWNLOAD_ALLOWLIST` is not in
  `./.env`, so the vault holds `"0"` for now — production DigitalOcean has a
  real list; copy it before cutover. `database-url` points at
  `tracktoolkit-rehearsal`, not `tracktoolkit`.
- Decrypt round-trip re-run with the rotated password: 200/200 rows.
- Verified on https://tracktoolkit.azurewebsites.net: `/health` 200,
  `/api/auth/login` 302 → `secure.soundcloud.com/authorize?...&redirect_uri=https%3A%2F%2Ftracktoolkit.azurewebsites.net%2Fapi%2Fauth%2Fcallback`,
  `/` serves the Track Toolkit static export, `/api/auth/me` → 401.

Two things that bit, both now handled in the IaC:

1. **Duplicate role assignment.** The portal grant of Secrets Officer to the
   same user/scope made the Bicep-named assignment fail with
   `RoleAssignmentExists`. `main.bicep` now has `assignDeployerKvRole`, and
   `deploy.sh` sets it false when an equivalent assignment already exists.
2. **Key Vault references do not re-resolve on `az webapp restart`.** After
   the secrets were written, a restart left every reference at
   `SecretNotFound` and the app kept 500ing on `ENCRYPTION_KEY` /
   `DATABASE_URL`. Platform logs showed the managed-identity sidecar
   "terminated during site startup". Changing any app setting
   (`KV_RESOLVE_NUDGE=<epoch>`) forced re-resolution: all six flipped to
   `Resolved` and the container was recreated healthy within a minute.
   `deploy.sh` now touches that setting instead of only restarting. The
   stray setting is harmless and the next Bicep deploy removes it (which is
   itself a settings change, so references re-resolve again).

Still to do before cutover (not blockers): `SESSION_SECRET` matches the
DigitalOcean value by string compare but cannot be cryptographically
verified; `DOWNLOAD_ALLOWLIST` real value.

### B2. GitHub Actions deploy cannot be dispatched until the workflow is on `main`

`gh workflow run azure-deploy.yml --ref azure/migration` → 404: GitHub only
exposes `workflow_dispatch` for workflow files that exist on the default
branch. Tonight's code deploy therefore went through `az webapp deploy` with a
zip built locally in a `node:22-bookworm` container (identical contents to
what the workflow produces). After `azure/migration` merges, the workflow is
dispatchable and this blocker disappears. Nothing for you to do beyond the
merge.

## Follow-ups (not done tonight, deliberately)

- From the automated review of the main codebase (2026-09-20), pre-existing,
  not migration-related: `countScCall()` in `soundcloud-client.js` also
  counts oEmbed fetches, so `avgScCalls` overstates SoundCloud round trips
  on `/resolve`; `retries401` in `paginate()` resets per page instead of per
  crawl, so a dead refresh token can attempt many exchanges on a long crawl;
  `MAX_INVALIDATION_MARKS` eviction in `social-cache.js` lets a crawl that
  started before an evicted mark republish pre-mutation data. Plus small
  cleanups (dead `deadlineAt` null checks, duplicated map lookup, an
  unreachable guard in `auth-cache.js`).
- `frontend-UI` `npm run lint` shells out to `bunx`, which is not installed
  on this machine or the GitHub runner image; the deploy workflow runs
  `next build` (which lints) and tsc separately, so nothing is skipped, but
  the script itself should drop the `bunx` prefix.

- **DigitalOcean env vars are readable through the API.** Every secret on
  `sctoolkit-backend` is a plain env, not `type: SECRET`. Anyone with the
  DigitalOcean token can read the token-encryption key. Mark them SECRET (or
  just decommission the app after cutover) and rotate `SOUNDCLOUD_CLIENT_SECRET`
  at SoundCloud once the old stack is gone.
- `.do/app.yaml` drifted from the live app (name, service name, missing
  `DOWNLOAD_ALLOWLIST`, `ADMIN_IDS`, `NODE_ENV`). Irrelevant after cutover.
- `DOWNLOAD_ALLOWLIST` and `ADMIN_IDS` exist in production but
  `DOWNLOAD_ALLOWLIST` is undocumented in CLAUDE.md's env table.
- Postgres reachability is public + "Allow Azure services" firewall rule.
  Move to a private endpoint / VNet integration once live.
- `.github/workflows/keep-api-warm.yml` pings the DigitalOcean host every 5
  minutes; retire or repoint after cutover (App Service `alwaysOn` makes it
  unnecessary).
- README says the catalog holds 2,032,233 tracks; the live `tracks` table has
  576,427 rows. Re-measure before quoting it again.
