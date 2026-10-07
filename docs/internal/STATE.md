# STATE

## Now
Overnight run 2026-10-07 → 08 (plan: `~/.claude/plans/pasted-content-id-407c-i-want-async-pumpkin.md`).
Five PRs (#63–#67) are open for Cole's review, plus this STATE.md PR. **None is merged: merging to `main` deploys.**
The downloads stack must merge in order: **#63 → #64 → #65 → #66**. Each PR's
base is the one before it; re-target to `main` as each lands. #67 is independent.
Two pieces of work are **local only** and were never pushed (see Waiting on Cole).

## Just done
- **#63** `fix/download-urn` (d1acaf3) — SoundCloud-native downloads were 100% broken in prod. `download_url` is now `/tracks/soundcloud:tracks:N/download`; the allowlist accepted numeric only.
- **#64** `feat/download-status` — honest per-track status (`lib/download-status.ts`): direct / gate / store / pre-order / none. A store link is never offered as a "Download".
- **#65** `feat/download-queue` — "Download all", paced and resumable. Adds `POST /api/downloads/links`, plus the server-side `requireCanDownload` (the allowlist used to be enforced by the page only).
- **#66** `feat/rekordbox-gap` — `/rekordbox-gaps`: a Rekordbox XML is parsed in the browser and matched to likes or a playlist; a shopping-list CSV comes out.
- **#67** `fix/sc-path-injection` — client cursors can only continue their own request; `/users/:userUrn/related` param validated.
- Local only: `feat/hypeddit-runner` (8592d96, `tools/hypeddit-runner`) and `~/Developer/tracktoolkit-extension-work` (extension repair, 7 commits).

## Next
1. Review and merge #63, then verify on the live site: `/downloads` → a "(free download)" track saves.
2. Merge #64 → #65 → #66 in order, re-targeting each to `main`. Run `/verify-deploy` after each merge.
3. Merge #67, then check Following Library pagination on the live site.

### Waiting on Cole
- **Extension and runner not pushed: the repo is public.** Pushing the extension import was refused in-session as an out-of-place publication (it carries the Hypeddit gate automation). The runner went unpushed for the same reason. Options: make `cole-hackman/tracktoolkit` private, or move both into a private repo, then push.
  - The extension repair is in `~/Developer/tracktoolkit-extension-work` (branch `fix/extension-domain`; its README says how to load it).
  - The runner is on local branch `feat/hypeddit-runner`.
- **Add the sideloaded extension's ID to `CHROME_EXTENSION_IDS`** (App Service). Without it the API refuses the extension.
- **Real Hypeddit run:**
  ```
  cd tools/hypeddit-runner && npm install && npm start -- --queue ~/Downloads/hypeddit-queue.json
  ```
  Get the queue from Downloads → Auto-Download → Export queue (JSON). Do the first real batch with `npm run run-queue -- --queue <file> --limit 5 --headed`. The SoundCloud and Instagram selectors for signed-in pages were only checked logged out. **Zero live gates were run tonight**: the runner profile is not logged in, and per instructions I didn't work around that.
- **Instagram/SoundCloud follows are now real.** The old extension clicked through without following. The runner follows for real and logs it. Say if you want the old skip-only behaviour back.
- **Rekordbox XML export.** `/rekordbox-gaps` was built against a synthetic fixture; the first real export is the real test.
- **Follow-gate (Q4): kept.** It was deliberate (15a074e, "follow-gated library browser"), and the 2026-08-25 review relies on it, with tests. It protects scope, not secrecy: it stops the OAuth app being used to crawl any account's library. To lift it, remove `assertFollowedUser` and update `tests/routes/followed-library-authz.test.js`.
- Carried over, not re-verified tonight: fill `GOVERNING_LAW_STATE` (`app/terms/page.tsx`), the Search Console change of address, and decommissioning Neon by the end of October.

## Decisions
- **Logo: the `claude-branding` shifted-bar mark** (2026-09-20). Three
  horizontal rounded bars of decreasing length, middle bar shifted right, flat
  `#FF5500`, no second tone in the mark; wordmark in Space Grotesk 600
  outlines. Chosen over the Codex split-bar candidate because three
  equal-length bars with a break reads as a hamburger-menu icon at sidebar
  size. Codex's set is archived on branch `codex-branding` (`docs/brand/`,
  see its `ARCHIVE.md`). Source of truth is `docs/brand/tools/mark-spec.cjs`;
  regenerate with `build-all.cjs`, never hand-edit the exports.
- **Name: Track Toolkit** (2026-09-10). Supersedes the live vote, which is now
  closed in code. SoundCloud references stay wherever they are factual — the
  platform, the OAuth connection, the API, the trademark position, "Continue
  with SoundCloud". Product-owned naming — titles, nav, metadata, marketing and
  legal copy, the playlist footer — is Track Toolkit.
- The headline is now "The Ultimate Track Toolkit" (2026-09-10). This replaces
  the 2026-07-08 decision to keep "The Ultimate SoundCloud Toolkit": that
  wording *was* the trademark problem, since it reads as the product's name.
  Structure and the `.text-gradient` treatment on "Toolkit" are unchanged.
- Domain references stay on `soundcloudtoolkit.com` until the new domain is
  registered and pointed (2026-09-10). Renaming them in the repo first would
  break the deployed product for no gain — the domain move is an external step,
  tracked in README.md.
- Logo and icon files keep their old paths (`/SC Toolkit Icon.png`,
  `/sc toolkit transparent .png`) (2026-09-10). The artwork still has to be
  redrawn; renaming the files without new art only breaks the paths the app and
  the Chrome extension already point at. Replace the images in place.
- `sc-toolkit-*` localStorage keys and the `sc-toolkit-*` postMessage types
  keep their names (2026-09-10). They are not user-visible, the postMessage
  types are a contract with the Chrome extension, and renaming the rest would
  silently reset every user's recent-tools list, sidebar state, growth risk
  acknowledgement and "What's new" dismissal. New rebrand keys use the
  `track-toolkit-` prefix.
- Rebrand announcements are localStorage-gated only, no DB (2026-09-10), same
  posture as "What's new". Order of precedence: rebrand modal, then "What's
  new", and the name vote is gone — never two at once.
- Headline "The Ultimate SoundCloud Toolkit" kept as-is — only subhead copy
  added around it (2026-07-08).
- Landing keeps exactly 3 animation components as signatures: FlickeringGrid
  (hero bg), WordRotate (hero), ShimmerButton (CTAs). Meteors, TypingAnimation,
  AnimatedShinyText, AnimatedGradientText, ShineBorder, GlareHover, TextAnimate
  removed from landing but component files kept (2026-07-08).
- Color system: all UI colors via HSL tokens in globals.css; hardcoded hex
  Tailwind classes are not allowed except intentional brand gradients
  (from-[#FF5500] to-[#E64A00]) and the Buy Me a Coffee button (2026-07-08).
- Dashboard tools grouped under: Playlists / Likes & Social / Library &
  Export / Discovery & Links (2026-07-08).
- Auth funnel naming: nav "Get started" → landing "Connect with SoundCloud"
  → login page "Continue with SoundCloud" (2026-07-08).
- No fabricated social proof: testimonials[] and HERO_SHOT default empty/null
  so nothing fake or broken ships; both are opt-in via real content (2026-07-09).
- Growth follows are capped server-side (50/24h + 30-min cooldown) and paced;
  auto-like is opt-in; genre affinity outranks follow-back ratio in scoring —
  the feature is positioned as scene discovery, not follow-churn (2026-07-09).
- "What's new" announcement modal is localStorage-gated only (no DB), keyed by
  `WHATS_NEW_VERSION` in lib/whatsNew.ts; bump that string to re-announce. Shows
  once on the dashboard after login, dismiss = never again, and takes priority
  over the survey so the two never stack in one session (2026-07-09).
- Public numbers must be traceable to the production operation_log. The landing
  says "3,500+ SoundCloud users" against a real 3,570; README carries the exact
  figures plus their source. Never round up past the measurement (2026-08-25).
- CLAUDE.md is the single authoritative project brief; AGENTS.md is only a
  pointer at it. Do not re-fork the two (2026-08-25).
- `express.json()` stays the ONLY body parser — it is load-bearing CSRF defense.
  Adding `express.urlencoded()` breaks the fail-closed invariant that
  tests/routes/feedback-authz.test.js guards (2026-08-25).
- Session lifetime is enforced inside the signed payload via `iat` +
  `SESSION_TTL_MS`, not by cookie maxAge alone. There is deliberately no
  server-side revocation list — documented as a known limitation, not a bug
  to "fix" with a session table unless that tradeoff is revisited (2026-08-25).
- ~~Licensed MIT, © 2026 Cole Hackman (2026-08-25).~~ Relicensed to
  PolyForm Shield 1.0.0 (2026-09-21): anyone may clone, run, modify and
  contribute, but not use the code to provide a product or service that
  competes with Track Toolkit. Not OSI open source. Copies obtained under
  MIT before this date remain MIT for those copies; the license does not
  protect the idea, only the code.
- Internal working documents live in `docs/internal/`, never the repo root;
  the root is what a visitor sees first (2026-09-21).

- Azure target is App Service (Linux B1, one instance, pinned) serving the
  API and `frontend-UI/out` from ONE origin; session cookie goes to
  `SameSite=Lax` via `SESSION_COOKIE_SAMESITE`. Not Container Apps, not
  Static Web Apps (2026-09-19).
- New canonical origin is the apex `https://tracktoolkit.com`; www and all
  soundcloudtoolkit.com hosts 301/308 from Express (`LEGACY_REDIRECT_HOSTS`),
  no Front Door, no stub app (2026-09-19).
- Secrets on Azure are Key Vault references by name (`infra/deploy.sh`
  header); `ENCRYPTION_KEY` / `SESSION_SECRET` carry over byte-identical
  from DigitalOcean, never regenerated (2026-09-19).
- Database client commands for the cutover run in `docker run postgres:17`,
  not the Homebrew libpq (its `pg_dump` hangs against Neon) (2026-09-19).

### From `feat/trust-and-mobile` (2026-09-22)
- **No third-party scripts and no analytics. At all.** Not Google Analytics,
  not Vercel Analytics or Speed Insights, not a tag manager, not a widget CDN,
  not an external font host. The privacy policy says so in plain words, the
  CSP is the enforcement, and `tests/security-headers.test.js` fails if a host
  is added back. Measuring usage happens in `OperationLog`, which is ours and
  is disclosed.
- **Feedback lives at `/feedback` and is stored in Postgres and nowhere else.**
  No email delivery, no webhook, no third-party form widget. It requires login
  by decision, which is what lets the write path use a honeypot and a per-user
  limiter instead of a captcha, and what makes every row attributable.
- **Primary buttons are dark text on `#FF5500`**, not white. White on the
  brand orange is 3.29:1; the dark navy `--primary-foreground` is 5.45:1. This
  is the most visible single consequence of the AA work and it is deliberate —
  do not "fix" it back to white.
- **The light-mode gradient stops are darkened** (`#e04000`/`#f04a00`/
  `#ff5500`) so the headline clears 3:1 on the cream background as large text.
  The earlier stops did not. Do not lighten them again.
- **`OperationLog` is kept 12 months, with a lifetime snapshot underneath it.**
  The row-level detail ages out; `Metric.lifetime_distinct_users` is
  snapshotted as the first step of every retention run — before any delete in
  that run — so the all-time user figure is never silently rewritten downward
  by its own purge.
- **Inactive accounts are deleted after 24 months** of no login
  (`INACTIVE_MONTHS`, calendar months in UTC).
- **The music catalog is kept and disclosed.** `Track` and `Playlist` rows
  harvested from resolved and browsed content stay; the privacy policy says
  they exist and why. Rows marked `gone` lose their metadata on every
  retention run.
- **GDPR is treated as not applying** — Cole operates as an individual, not as
  a business targeting the EU, and there is no EU representative line anywhere.
  Export, deletion and a contact address are built for **everyone** regardless,
  because they are the right thing to offer, not because a statute compels them.
- **The old names are allowed in the FAQ page title and meta description**
  (and in structured-data `alternateName`), so someone searching "SoundCloud
  Toolkit" finds the rebrand explanation. That is the one place product-owned
  naming may carry the old name; nowhere else.

### From the 2026-10-07 downloads work
- **Only two paths move a file**: SoundCloud's own `/download` (artist-enabled) and an artist's free gate. Stores, pre-orders and other links are "where to get it", never a download (2026-10-07).
- **"Select to Remove" stays on /downloads**: blocked tracks keep their row for removal (PR #60) (2026-10-07).
- **The Hypeddit runner is local-only and unattended**, and Cole keeps the Spotify connect, email and Instagram follow. It acts only on gates it queued, approves only Hypeddit's own SoundCloud consent, logs every action per run, and marks captchas, login walls and unknown gates as "needs manual" with no retry. Nothing of it goes in `server/` or the deployed app (2026-10-07).
- **Follow-gate on other users' libraries kept** (`assertFollowedUser`). Lifting it is Cole's call (2026-10-08).

## Landmines
- **The retention job deletes users by `disconnectedAt` and `lastLoginAt`.**
  `server/lib/retention.js` step 2 deletes every user still stamped
  `disconnectedAt` after 6 days, and step 3 deletes users whose `lastLoginAt`
  (or `updatedAt`, when null) is older than `INACTIVE_MONTHS`. Both cascade
  through every per-user table. **Never reuse either column for a soft-disable,
  a suspension, a "needs re-auth" flag or anything else.** Writing
  `disconnectedAt` to mean "paused" would delete those accounts in under a
  week, silently, with no user-facing signal.
- **`RETENTION_ENABLED=false` is not a preview.** It schedules nothing, so it
  logs nothing, and "no counts appeared" is indistinguishable from "there was
  nothing to delete" — follow that as a dry run and you will enable the job
  believing it is inert. `RETENTION_DRY_RUN=true` is the preview: it runs,
  counts everything, logs every line a real sweep would, and issues no write.
  It accepts exactly `true`; `1` and `yes` are refused on purpose, because a
  dry run that silently became real is the failure that matters here.
- **A portal-set `RETENTION_DRY_RUN` does not survive `infra/deploy.sh`.**
  `infra/main.bicep` declares `appSettings` as a complete list with no
  parameter for the flag, and ARM replaces the list wholesale, so an infra
  redeploy ends the dry run with no signal beyond the next boot line. Zip
  deploys (the GitHub workflow) leave settings alone. Anything else the
  operator sets by hand on the App Service has the same exposure.
- **The 6-day disconnect window is a constant on purpose, and
  `RETENTION_INTERVAL_MS` is clamped to 24h in code.** SoundCloud's terms give
  7 days; the sweep is daily, so the real worst case is the window plus up to
  one interval. At 7 days that was up to 8 — past the ceiling. Neither number
  may be raised from a deployment dashboard. See
  `docs/internal/TERMS-CHECK.md` finding B.
- **`Field` / `Dialog` / `IconButton` are the only sanctioned way to build a
  form control, an overlay or an icon-only button.** A hand-rolled
  `<label>`+`<input>` loses the `htmlFor` association, a hand-rolled `fixed
  inset-0` div is not a dialog (no focus trap, no Escape, no accessible name),
  and a bare `<button>` with a glyph has no name. Each of those was a real
  axe violation on this branch; the primitives are what closed them, and the
  e2e suite passes because pages go through them.
- **The two SQL files in `docs/sql/` must run before the branch is deployed.**
  `2026-09-feedback.sql` and `2026-09-account-lifecycle.sql`. Prisma queries
  against the `feedback` table, `users."lastLoginAt"`, `users."disconnectedAt"`
  or `metrics` return a 500 until they have. Both are re-runnable, both target
  **Azure**, and `main` deploys on push — so "after the merge" is too late.
- **`.superpowers/` is git-ignored scratch**, not part of the repo. The task
  briefs, reports and review diffs for this branch live there. Nothing in it
  ships, nothing in it is authoritative, and it is not on any other machine.
- The Azure app (and any stack pointed at a COPY of the tokens table) will
  refresh SoundCloud tokens on use; refresh tokens are single-use, so the
  other stack loses that account until its owner logs in again. Do not run
  authenticated smoke tests with anyone's account but your own while both
  stacks are alive.
- `frontend-UI/src/components/brand/Logo.tsx` is GENERATED by
  `docs/brand/tools/build-components.cjs` from `public/brand/mark.svg` and
  `wordmark.svg`. Hand edits get overwritten; change `mark-spec.cjs`, run
  `build-all.cjs` then `build-components.cjs`. The wordmark text is
  `currentColor`, so wherever it is placed needs a `text-*` color class.
- `validateEnv` in `server/index.js` is global: with Key Vault references
  unresolved, `/health` returns 500 too. On Azure that is "secrets missing",
  not "app down" — check the body before debugging the box. References
  re-resolve on an app-settings change, not on `az webapp restart`;
  `infra/deploy.sh` nudges a setting for that reason.
- `PRISMA_CLI_BINARY_TARGETS` does not change the generated client. Build
  the deploy zip on linux/amd64 (the GitHub workflow, or Docker with
  `--platform linux/amd64`); an arm64 Docker build silently ships the wrong
  engine.
- `westus2` has no Burstable Postgres capacity for this subscription; the
  stack lives in `westus3`. Don't "fix" the region.
- The rebrand banner publishes its height as `--announcement-h` and the two
  `position: fixed` headers (landing nav in `app/page.tsx`, mobile header in
  `AppShell.tsx`) read it as their `top`. If you add another fixed element
  anchored to the top of the viewport, give it the same offset or it will sit
  underneath the banner. The variable is declared `0px` in `globals.css`, so
  everything is correct when there is no banner.
- The rebrand modal is mounted by `(app)/layout.tsx`, the banner by the root
  layout, so acknowledging the modal reaches the banner only through
  `REBRAND_STATE_EVENT`. A `storage` event will not do it — that one fires in
  other tabs, not this one.
- `validateRebrandVote` must stay AHEAD of the closed-vote 410 in
  `routes/feedback.js`. That POST is what
  `tests/routes/feedback-authz.test.js` uses to prove a cross-site
  form-encoded body fails closed at the validator; a gate in front of it would
  answer 410 and the invariant would go untested.
- `npm test` is self-contained again: `tests/setup-env.js` supplies dummy
  SoundCloud credentials via jest `setupFiles`, because five suites validate
  them at module scope and otherwise fail to LOAD on a fresh clone — which
  looks like a broken suite. It uses `||=`, so a real `server/.env` still wins.
  Don't remove it without re-checking a clean `npm test`.
- The auth memo (`server/lib/auth-cache.js`) holds **decrypted tokens** in
  process memory for 30s. It is invalidated at the single token-refresh choke
  point (`refreshTokensAndPersist`) and on account deletion. If you add another
  path that rotates or revokes tokens, it must call `invalidateCachedAuth` or
  users will be served a dead refresh token until the TTL expires.
- **There is a second token memo, with the same rule.** The rotation memo in
  `server/lib/soundcloud-client.js` (`rememberRotation`/`readRecentRotation`)
  holds the last refresh's **plaintext** pair for 60s, keyed by the refresh
  token that exchange spent, so a route's second SoundCloud call is not told
  its already-spent token means "revoked". Any path that rotates or destroys
  tokens must call `forgetRecentRotation` as well as `invalidateCachedAuth` —
  `disconnectUser` and `DELETE /api/auth/account` both do, and both are
  asserted through the route. TTL is `SC_ROTATION_MEMO_TTL_MS`.
- **Every SoundCloud call must run inside a token context.** `authenticateUser`
  opens one with `runWithTokenContext`; anything running from a timer has to
  open its own (`growth-scheduler.js` does). Without it a 401 refresh has no
  `userId`, so the rotated pair cannot be stored — and the row is left holding
  a token SoundCloud has already spent, which the revocation classifier then
  correctly reads as a revocation on the user's next request and deletes their
  tokens for. `_refreshAndPersistNow` now **refuses** a context-free exchange
  rather than rotating and discarding, so this fails loudly; do not "fix" that
  by removing the guard. Grep old production logs for
  `Token refresh completed without user context` — every hit is a user who was
  stranded by this on `main`.
- Snapshot invalidation marks rows **stale** rather than deleting them, and a
  stale snapshot is still served while it refreshes. If you add a mutation that
  changes likes/playlists/followings/followers/reposts, route its invalidation
  through `invalidateUserCollections` (not `invalidateUserNamespaces`) or the
  Postgres tier will keep serving pre-mutation data for up to its TTL.
- `library_cache_*` are NOT `library_snapshots`. The latter belongs to the
  AI-library-chat branch and stores a projected shape. Do not merge them.
- **PR #29 logs every user out once on deploy.** Legacy session cookies have no
  `iat` and are treated as expired. Expected, one-time, no data loss — but it
  will look like an outage if you forget.
- `prisma db push` from ANY branch syncs prod to that branch's schema and will
  DROP tables not present in it. Prod has cross-branch tables (AI chat +
  library indexing); main's schema declares them so push is safe. Any other
  branch doing db push without those models would drop ~2,350 rows.
- Growth engagement job registry and the resolve cache are in-memory
  (single-instance assumption). A second backend instance forks both.
- Jest fake-timer tests in tests/soundcloud-client.test.js must use
  `advanceTimersByTimeAsync` and attach `.rejects` handlers BEFORE advancing —
  `fetchWithTimeout` adds a microtask hop that broke the old tick-counted flushes.
- `next.config.js` rewrites/headers warnings under `output: export` are
  pre-existing and expected (dev-only rewrites).
- Landing gradient text uses `.text-gradient` — do not lighten end stops
  past #ff8a3d; earlier #ffd28f failed contrast on the cream background.
- `frontend-UI` logo assets have spaces in filenames ("/sc toolkit
  transparent .png") — referenced verbatim in code; renaming breaks pages.
- CI runs `npm test` on every push to `main` (`.github/workflows/azure-deploy.yml`),
  and a failure blocks the deploy. It does **not** run the frontend checks —
  `tsc`, `next lint`, `npm run contrast` and `npm run test:e2e` are still
  manual, from `frontend-UI`. The workflow also skips entirely for pushes that
  only touch `**.md`, `docs/**`, `infra/**`, `.gitignore` or `LICENSE`, so a
  docs-only push is never "verified by CI".
- Survey localStorage keys are namespaced by `SURVEY_CAMPAIGN_ID`. Deploying a
  new survey while the old campaign id is still set in the environment means
  anyone who hit "Don't show again" on the previous survey never sees the new
  one. Bump or unset it with every survey swap.
- Additive schema changes go in as raw SQL against **Azure Postgres** (see
  `docs/sql/`; each file names the database and the command), generated with
  `prisma migrate diff` and then made re-runnable. Not Neon — Neon is the
  legacy database and nothing reads it. This sidesteps the `db push` drop
  hazard above entirely: SQL cannot drop what it does not mention. It does
  leave Prisma's migration history and the database out of step, which is
  inert while this project uses `db push` (no migration table) and would only
  matter on a switch to `prisma migrate`. Keep the generated form exactly —
  an `@updatedAt` column gets `TIMESTAMP(3) NOT NULL` with **no** default,
  and adding one makes a later diff report drift.
- Forced-choice + favourites-on-top is a known bias in the live vote: people
  who just want the modal gone click the top option, which is exactly what the
  result is meant to test. Read the top-two margin as soft. Randomising option
  order per user would fix it without giving up mandatory.
- **`download_url` comes in URN form** (`/tracks/soundcloud:tracks:N/download`). E2e fixtures must use the real shape; `e2e/downloads-native.spec.ts` runs the server's own `isAllowedDownloadUrl`, so a wrong fixture fails.
- **Downloads queue: one helper tab.** Files go through a single tab opened in the Start/Resume click, 3 s apart. Opening a tab per file after an `await` is a blocked popup.
- **A client `next` cursor must go through `cursorEndpoint`** (`lib/sc-cursor.js`). Never send a client-supplied path to SoundCloud raw.
- **The Rekordbox XML never leaves the browser**, and the parser drops `Location` (file paths). Keep it that way.
- **The extension's gate stepper no longer matches live Hypeddit**: it clicks `#skipper_sc`, and today's gates use per-action buttons. The runner is the maintained path.
- **`.next/types` survives a branch switch.** After checking out a branch without a page, run `npm run build` before `npm run lint`, or tsc fails on a stale route type.

