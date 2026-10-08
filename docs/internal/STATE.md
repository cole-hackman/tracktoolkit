# STATE

## Now
Nothing is in flight. On 2026-10-08 every open PR was reconciled: #76, #78,
#80, #74, #67 and #66 merged and verified live; #82 and #77 (docs) merged;
#28 and #68 closed as superseded. Branches that hold commits found nowhere
on `main` are listed under Next, 2026-10-08, and are **kept until Cole
decides**. **Still unproven live:** the SoundCloud `access` default behind #60
(see Next 1, 2026-10-07).

## Just done
- 2026-10-08 reconciliation (plan: the session's pasted brief; no plan file).
  Each code PR got the full check on a tree merged with the then-current
  `main` before it merged. "Live" means the deploy run succeeded, the App
  Service restarted after it (`Server running` in the docker log), and the
  check below passed against tracktoolkit.com.
  - `ac4b6ff` — #76: a page navigation to `<route>/index.txt` 302s to
    `<route>/`. Live: `Sec-Fetch-Dest: document` → 302 `/dashboard/`, and
    `RSC: 1` → 200 `no-cache`. Signed in (Cole's browser), "Get started" →
    `/dashboard/`, no console errors, no `index.txt` navigation. **Why it sat
    unmerged:** nothing blocked it. Auto-merge is disabled on the repo, there
    is no branch protection, and CodeRabbit (the only status) was green.
    Nobody pressed merge.
  - `685ad48` — #78 (SEO P1, now including #9): per-page canonical/og:url,
    robots.txt down to `/api/` + `/admin`, no `SearchAction`, legacy hosts
    one hop, `/404.html` and `/404/` → 404, `<route>/index.html` → 301. Every
    redirect built from the request path now goes through `sameSitePath()`.
    #76's redirect turned `//evil.example/index.txt` into
    `Location: //evil.example/` on bare Express. It did **not** reproduce live
    (Azure's front end collapses `//` and `\`), so this is defence in depth.
    The server half took about a minute longer than the files to go live:
    zip deploy swaps the files before the process restarts.
  - `3dcc4cc` — #80: a partly created followed-user clone is shown, not
    hidden. Live: the new copy is in the served `following-library` chunk,
    `api.js` on App Service carries "Nothing was changed", and there were no
    errors after the restart. A real clone was not run (it writes playlists).
  - `39c5175` — #74, rebuilt: its server half had shipped as #72, and its
    downloads half (stop after the 2nd file until Chrome's multiple-downloads
    prompt is answered) had only ever been committed on a local `main`. The PR
    now carries that commit alone. Live: `track-toolkit-multi-download-ok` is
    in the served Downloads chunk, and the page renders signed in. No queue was
    run (it downloads files).
  - `7bc45c0` — #67 (security, rebased): a pagination cursor can only
    continue its own request; `userUrn` is validated. Live, signed in:
    `/api/likes/paged` with a genuine `next_href` → 200; with a
    `/me/followings` cursor → 400 "Invalid next cursor";
    `/api/users/me%3Fx%3D1/related` → 400.
  - `b3fdba5` — #66 (rebased twice, retargeted from the merged
    `feat/download-queue`): `/rekordbox-gaps`. Its live result is under Next.
  - `fa531a8` #82, `94c4e78` #77: docs only, no deploy.
- `f03bbdf` + `c9c3b21` — #75 and #81 merged and live: README usage figures
  are now shields.io badges reading the unauthenticated
  `GET /api/stats/public` (`server/routes/stats.js`), with a note that they
  update daily. Users = `lifetime_distinct_users` (3,119); tracks = the new
  running total `lifetime_tracks_processed` (2,746,090 on its first run,
  14:51 UTC), advanced by a cursor key, `lifetime_tracks_processed_through`.
  Verified: endpoint 200, the retention log line, and both badges rendering on
  the GitHub README (screenshot). #81 changed the badges' cache key — see
  Landmines.
- `6b08284` — #70 merged and live: SoundCloud errors now carry `status`
  (messages unchanged); GET is retried once on 502/503/504; merge answers 409
  `PLAYLIST_NOT_FOUND` / 502 `SOUNDCLOUD_UNAVAILABLE` instead of 500, and
  `GET /api/playlists/:id` answers 404/502. Prompted by the merge 5xx
  investigation: 56/295 merges 500'd (37 SoundCloud outage 502/504 on
  09-25/26, 15 deleted-but-cached source playlists, 6 our 30 s timeout).
  Plan: `~/.claude/plans/merge-5xx-error-mapping.md`.
- `d896e61` — #59 merged and live: genre focus on Grow your network (Nick).
  It was rebased onto #60/#61 and re-checked: 792 tests, e2e 594 passed /
  0 failed.
- `5487d01` — #61 merged and live: appends never shrink an existing playlist;
  targets over 500 are refused with 409.
- `73f410e` — #60 merged and live: playlist rewrites read blocked tracks and
  require declared removals (Steve). Before it, the short-read guard refused
  **101 of 148** playlist PUTs, because SoundCloud's `access` defaults to
  `playable,preview`.
- `67c5443` — #58 merged and live: `POST /api/growth/reverse` 500'd on every
  call (`SC_WRITE_PACING_MS` was not imported).
- Plan: `~/.claude/plans/pasted-content-id-9479-two-pieces-streamed-abelson.md`.

## Next
### 2026-10-08
1. **Recorded, not fixed (Cole's instruction):**
   - **Flaky e2e:** the downloads "Download all" queue test fails about 3 in
     10 runs when the suite runs in parallel, and can fail an otherwise good
     run (reported by the #80 session). #74 changed those tests (the queue
     tests now start as an "already allowed" browser, with a 400 ms file gap),
     so re-measure on current `main` before deciding a fix. In this session's
     five full e2e runs it did not fail.
   - **Followed-clone follow-ups from #80:**
     (a) a create response with no playlist id still triggers a save;
     (b) a rate-limited (429) save during a clone answers 500;
     (c) the title prefix is HTML-escaped, so "A & B" becomes "A &amp; B".
2. **Branches with commits on no `main` — kept until Cole decides:**
   - `codex-branding` (local + remote): the archived Codex brand candidate.
     It is referenced by the logo decision below, so it is probably keep-forever.
   - `feat/hypeddit-runner` (local only, `8592d96`): never push. The repo is
     public (memory: extension-and-runner-location).
   - `origin/claude/rekordbox-soundcloud-sync-75ej4r`: #28, closed as
     superseded by #66.
   - `origin/claude/track-toolkit-planning-a5wq94`: #27 (closed), the
     2026-08-10 planning docs.
   - `origin/feature/ai-library-chat`: #11 (closed). Its 23 commits are on
     no `main`; the schema still declares its tables.
   - `docs/state-2026-10-08` (local + remote): #68 (closed), the stale
     overnight handoff. What was still open in it is item 3 below.

   Everything else was deleted on 2026-10-08: 56 local branches (including
   ~25 `worktree-agent-*`) and 26 remote branches, each checked to add
   nothing to `main` (`git merge-tree --write-tree origin/main <branch>` gives
   main's own tree), plus 17 clean worktrees.
3. **Carried from #68 (closed), still open:**
   - The extension repair (`~/Developer/tracktoolkit-extension-work`, branch
     `fix/extension-domain`) and the Hypeddit runner are unpushed because the
     repo is public. Make the repo private, or move both to a private repo.
   - Add the sideloaded extension's ID to `CHROME_EXTENSION_IDS` (App
     Service). Until then the API refuses the extension.
   - First real Hypeddit run:
     `cd tools/hypeddit-runner && npm install && npm run run-queue -- --queue <file> --limit 5 --headed`
     (queue from Downloads → Auto-Download → Export queue). No live gate has
     been run, and the signed-in selectors were only checked logged out. The
     runner follows for real on Instagram/SoundCloud, where the old extension
     only clicked through.
   - `/rekordbox-gaps` was built against a synthetic XML fixture. The first
     real Rekordbox export is the real test.
   - The follow-gate on the followed-library routes stays. It was deliberate
     (15a074e) and protects scope: it stops the OAuth app being used to crawl
     any account. To lift it, remove `assertFollowedUser` and update
     `tests/routes/followed-library-authz.test.js`.
4. `csvEscape` in `frontend-UI/src/lib/csv.ts` does not treat a leading `\r`
   as dangerous, which the admin feedback CSV does. Low risk; noted while
   reviewing #66.

### This session (2026-10-07)
0. **README badges follow-ups (Cole):** the users badge says 3,119 (people
   who have run an operation), but the landing page says "3,500+ SoundCloud
   users" (registered). That breaks the "never round up past the
   measurement" decision, so the landing copy needs a decision. Separately,
   `lifetime_distinct_users` is a high-water mark and will stop rising from
   about 2027-03-19, when the 365-day oplog purge starts. It needs a
   cursor-style fix like the tracks total, plus a "seen before" check.
1. **On Cole's own account only:** open a playlist that has a blocked track
   in the health check. The Blocked row should show; remove it, and SoundCloud
   should lose exactly that track. This is the first live confirmation of the
   `access` default. A few days later, rerun the `AppServiceHTTPLogs` query
   (`PUT /api/playlists/:id` by status): the 409 share should collapse. Count
   `[playlist-rewrite] refused short read` lines to decide design B (cleaning
   up deleted/private entries no read returns).
2. Watch whether merge, from-likes and the followed-likes append now return
   409 on targets with deleted/private entries. That is new, deliberate
   behaviour from #60 (it used to silently delete tracks).
3. **About a week after 2026-10-07:** rerun the merge 5xx query
   (`AppServiceHTTPLogs`, `POST /api/playlists/merge` by status, plus
   `Merge playlists error` in `AppServiceConsoleLogs`). SoundCloud 404s and
   502/504s should now be 409/502, leaving 500 for the genuinely unexpected.
4. Follow-ups with evidence, none started:
   - Clone, compare and from-likes still map SoundCloud errors to 500; they
     can now use `classifyScError` (`server/lib/sc-errors.js`).
   - A SoundCloud failure right after a token refresh still has no `status`
     (fixing it means touching the 401 path) — stays a 500.
   - `/dashboard/summary`, `/playlists/:id` and the followers/followings
     paged routes return 5xx on 3–6% of calls.
   - The PUT title branch never sets the title.
   - `paginate` does not flag a 429-deadline break as truncated.
   - Audit and keyword search still read with the default `access`.
   - `/users/{id}/related` is not in SoundCloud's spec.

### Carried over from the previous handoff (status not verified this session)

1. **Apply the two SQL files to Azure Postgres BEFORE merging.** `main`
   deploys on push, so the merge ships the code that reads these:
   `docs/sql/2026-09-feedback.sql` (the `feedback` table) and
   `docs/sql/2026-09-account-lifecycle.sql` (`users."lastLoginAt"`,
   `users."disconnectedAt"`, the `metrics` table). Both are re-runnable. Both
   files now name the database and the command. **Not Neon** — Neon is the
   legacy database and nothing reads it.
2. **Set `RETENTION_DRY_RUN=true` BEFORE the merge is pushed.** This is an
   ordering instruction, not a suggestion, and the window is ten minutes.

   Merging to `main` deploys, the App Service restarts, and the retention
   job's first sweep runs **10 minutes after that boot**. A setting added
   after the deploy finishes does not take effect until the *next* restart —
   so if the flag arrives late, the first sweep is real and there is no
   preview of it.

   That first sweep is also the largest this job will ever perform.
   `users."lastLoginAt"` is a brand-new column, so on the first run every
   existing row has it as NULL and the dormancy rule falls back to
   `updatedAt`. Every account with no activity in 24 months goes in one pass,
   cascading across every per-user table, irreversibly. It is the one sweep
   that most needs looking at before it happens, and the only one that cannot
   be looked at afterwards.

   So: set the flag, confirm the boot line below, then merge — or at the very
   latest set it the moment the merge is pushed and confirm
   `[retention] Daily purge scheduled in DRY RUN mode` in the log stream
   well inside the ten minutes. If that line does not say DRY RUN, the setting
   did not reach this boot: restart the App Service before the ten minutes are
   up.

   Not `RETENTION_ENABLED=false` — that schedules nothing, so it logs nothing,
   and the silence reads exactly like "there was nothing to delete". (An
   earlier draft of this list said to do that. It would have produced no
   counts, and the first real sweep would then have deleted as it logged.)

   **Set it in the Azure portal, on the App Service** (Settings →
   Environment variables → App settings), *not* in Bicep.
   `infra/main.bicep` declares `appSettings` as a complete list with no
   parameter for this flag, and ARM replaces the whole list on deploy — so
   **any `infra/deploy.sh` run silently ends the dry run** and the next sweep
   is real. Code deploys are safe: the GitHub workflow is a zip deploy
   (`azure/webapps-deploy@v3`) and does not touch settings. If an infra change
   is needed while the dry run is up, re-add the setting straight afterwards
   and check the boot line below before trusting it.

   With the flag set, the job runs on its normal schedule — first run 10
   minutes after boot — performs every count, and writes nothing at all. The
   boot line names the mode, so it is checkable at a glance:
   `[retention] Daily purge scheduled in DRY RUN mode`. In the App Service log
   stream, look for:

   ```
   [retention] DRY RUN (RETENTION_DRY_RUN=true) — counting only, nothing is written
   [retention] disconnected-users will remove N users
   [retention] inactive-users will remove N users
   [retention] operation-logs would remove N
   ...
   [retention] DRY RUN complete — no rows were deleted or updated
   ```

   The `will remove N users` lines are word-for-word what a real sweep prints,
   so the numbers need no translation. Satisfy yourself they are what you
   expect — the user sweeps cascade across every per-user table and are
   irreversible — then delete the variable and let the next run do it for
   real. `tests/retention-dry-run.test.js` is what asserts the flag issues no
   write: it mocks the client with a Proxy that records any
   `delete*`/`update*`/`upsert`/`create*` call, plus `$executeRaw` and
   `$transaction`, on **any** delegate — including ones the test has never
   heard of — and fails if the set is non-empty.
3. **Fill `GOVERNING_LAW_STATE` in `frontend-UI/src/app/terms/page.tsx`.** It
   ships as the literal string `[STATE]` and is visible on the page. Only Cole
   can decide it.
4. Search Console → soundcloudtoolkit.com property → Settings → Change of
   address → tracktoolkit.com → Validate & update (Cole; still outstanding
   from the cutover).
5. **Decommission Neon by the end of October.** The privacy policy tells users
   their data is deleted on the stated schedule, and a full copy of the old
   database sitting in a second vendor is a promise not kept. DigitalOcean and
   Vercel go first; Neon last.
6. Branding leftovers outside the web app (Cole): SoundCloud OAuth app name
   "Track Toolkit" + `frontend-UI/public/brand/icon-512.png` as its icon;
   Chrome extension icons from `docs/brand/extension/` + listing renamed —
   only then may the two legacy icon files go.

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
  Since 2026-10-07 the README figures are live shields.io badges reading
  `/api/stats/public` (lifetime users + lifetime tracks processed from the
  `metrics` table, refreshed daily by the retention job) instead of hand-copied
  numbers.
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


### From the 2026-10-07 feedback session
- **SoundCloud errors are classified by `status`, never by message, in new
  code** — but every existing message stays byte-identical, because older
  routes still match on text (`includes('404')`, `shouldRetryPublicly`).
  Only GET is retried, once, on 502/503/504; POST/PUT/DELETE never are
  (a duplicated create or rewrite is worse than an error) — 2026-10-07 (#70).
- **Merge only says "Nothing was changed" when no write was attempted.** The
  `writeAttempted` flag is set *before* each create/PUT, because a write that
  times out may still have landed upstream — 2026-10-07 (#70).
- **Playlist rewrite reads ask for `access=playable,preview,blocked`, and
  `PUT /api/playlists/:id` only drops ids the client names in `remove`**
  (count-aware). The short-read guard is never loosened. Deleted/private
  entries that no read returns stay refused (design B deferred until the warn
  log shows how common they are) — decided by Cole, 2026-10-07.
- **Appends never write a prefix shorter than the existing playlist; a target
  already over 500 is refused with 409** — 2026-10-07.
- **Genre focus filters during the scan, never before it** (users carry no
  genre; candidates' genre comes from their tracks). Up to 150 lookups with a
  focus; no focus = identical calls to before — decided by Cole, 2026-10-07.

## Landmines
- **README badges cache whatever shields.io first sees.** GitHub renders the
  README at merge time, before the deploy is up, so a badge pointing at a new
  endpoint gets a 404, and shields kept serving "resource not found" to
  GitHub's image proxy for 2.5 h+, past `cacheSeconds`, without re-fetching
  us. Purging camo (`curl -X PURGE <camo url>`) does not help. Ship the
  endpoint before the README points at it, or change the badge URL afterwards
  (#81).
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
  `position: fixed` headers (landing nav in `app/(home)/page.tsx`, mobile header in
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
- **The server has no lint.** A deleted `mergeBatchSize` passed `npm test`
  and `npm run lint` and would have broken every overflowing merge. Before
  pushing a server change that removes an identifier, run `node --check` and
  a throwaway `no-undef` ESLint over the touched files.
- **The `access` default is from SoundCloud's spec, not yet seen live.** If
  `track_count` turns out to exclude blocked tracks, the all-access read comes
  back LONGER than `track_count` and the guard refuses every such playlist.
- **Read the Playwright summary for `failed`, not just `passed`.** Failing
  test names print *above* the `N passed` line. A `tail` that shows only the
  last lines of the summary can miss them; that is how #59 was first reported
  as "560 passed" with 4 failures. Check the exit code and grep for
  `^\s+[0-9]+ failed`.
- **`Select`'s third naming arm is satisfied only by Field's
  `data-field-labelled` render prop.** A bare `<Select id>` is a type error on
  purpose; do not "fix" it by loosening the union.
- **Upstream SoundCloud errors now carry `status`, so `status === 403` no
  longer means "not followed".** `assertFollowedUser` marks its refusal with
  `code: 'NOT_FOLLOWED'`; check the code, never the status. Any new
  `err.status`-based branch must assume the status may be SoundCloud's.
  `DELETE /api/playlists/:id` deliberately passes it through (#70).
