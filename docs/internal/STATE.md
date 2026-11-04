# STATE

## Now
Nothing is mid-flight. Droploud and Cobrand gates are merged and live
(2026-11-04): web PR #107 (`cf8efaa`) deployed and verified on
`/downloads/` (Droploud and Cobrand rows get checkboxes with the new
extension; the confirmation names what each site does; Cancel sends
nothing). The extension's PR #1 is merged into `fix/extension-domain`
(`6b917ca`) in the private repo, and Cole's folder is on that branch.

## Just done
- **Gate sites live run** (2026-11-04). All five gates downloaded on the
  final code: Droploud *Never Walk Alone* (.wav), *Dynamite* (.mp3),
  *Confession* (.aiff, on retry: no second comment, no second grant), Hypeddit
  *Dreamin* in a mixed queue, Cobrand *Spaceship* (artist's Dropbox .wav).
  One "fire" comment per track, reposts in place, no tab left open. The first
  run failed all four on wrong guesses in the handoff's fixtures; fixed with
  captured live HTML (see Landmines). Reviews: extension 12 findings and web
  5 findings, all fixed.
- **Extension moved to a private repo** (2026-11-04):
  `cole-hackman/tracktoolkit-extension`, verified `PRIVATE`; `main` (original
  import `d5cd89b`), `fix/extension-domain` (`d6573ed`) and `feat/gate-sites`
  (`a8eae33` fixtures, `dd4a5db` plan + handoff, `ae5afa2` README) pushed.
  The local folder stays on `fix/extension-domain`, so the loaded extension
  and its ID are unchanged. Investigation behind the plan: 99 Droploud gates
  read, 7 tested live, 2 run to a file; 4 Cobrand links (2 real gates), 1
  signup run. Existing 22 extension tests pass (the suite takes about 3 min).
- `0e39d6a` — sidebar scrolls itself and the account block moved to the top.
  The desktop `<aside>` is sticky and viewport-tall, so the nav list scrolls
  inside it instead of the page; profile, theme, log out and Support Me sit
  above the list (`SidebarAccount` in `AppShell.tsx`, also at the top of the
  mobile drawer). Support Me uses `AnimatedShinyText` (black at 75%, black
  sweep). `drawer.spec.ts` now treats Accessibility as the last drawer link.
  Live 2026-11-04: page scrolled 400 px, sidebar stayed at top 0, nav list
  scrolled on its own (1338 px of content in 606). Not checked live: the
  mobile drawer, and the shimmer animation itself. `npm run contrast` not run.
- The deploy of `6731ad9` (PR #99, uptime worker) failed: OneDeploy Gateway
  Timeout 504 after 13 min. `0e39d6a` deployed fine and includes its files.
  Likely tied to the unexplained node kills in Next item 0.
- **Uptime monitor deployed 2026-11-04** (`tools/uptime-worker/`, PR #99; the
  Worker was deployed by hand with wrangler, not by CI). Status page:
  https://tracktoolkit-uptime.tracktoolkit-uptime-worker.workers.dev/ — runs
  every 5 minutes at about :30 past the 5-minute mark, 11/11 ok. **Drill:**
  `DRILL_HOST=monitor-drill.tracktoolkit.com` deployed 13:11:14 UTC, first
  failure 13:15:30, marked down 13:20:30 and the alert arrived on Discord
  (Cole saw it): 9m16s here, up to about 10 minutes for an NXDOMAIN host.
  Other 11 checks stayed green; removing the drill host sent no UP. Real DNS
  breakage is slower because resolvers serve cached records until TTL expiry:
  about 40 minutes at Spaceship's 30-minute TTL. Delete
  `keep-api-warm.yml` after 7 days with no false alert (from 2026-11-11).
- `3452e59` — #101 live: every automatic download in the `/downloads/` list has
  a checkbox, with a sticky "Download N selected" bar. Hypeddit picks go to the
  extension, direct ones to the queue. Live: 137 boxes, none ticked; a ticked
  Hypeddit track queued alone. Full check: 1066 Jest, 823 e2e, 1 flaky failure
  (`growth-genre.spec.ts:35`, passed 3 reruns; see Next, Recorded).
- `3062144` — #100 live: folder mode fetches each link just before its file
  (`FOLDER_BATCH_SIZE = 1`, links die after about 90 s) and adds Retry failed.
  Cole's own retry of that folder is unconfirmed.
- `011c7a2`, `756d5d8` (extension) — the stepper reads the current slide, runs
  on every Hypeddit tab, and one gate saves one file. Live: a 5-track queue
  finished 5/5 with one download per track, in about 3.5 minutes.
- `3280829`, `0bd641a`, `5b41ebd` (extension) — a page load no longer resends
  the last queue; a queue with nothing to run no longer stops a running one;
  gate steps open as background tabs. Live: Terminal stayed in front for a
  70 s run, and Get Lucky completed end to end with one file. Note `0bd641a`
  also carries the worker's once-per-submit `ts` check.
- `d6573ed`, `67b273d` (extension) — step tabs are recorded when opened and
  closed on load, gate end or deadline (not yet seen live); an unpacked copy
  reloads itself when its files change (seen working).

## Next
### 2026-11-04 (clone-private, PR #103)
0. Merged after the gate work; verify on a real private playlist on the live
   site: it resolves, the tracks arrive, the copy is private, and the
   description has no `s-` token. If `/resolve` rejects a secret link,
   resolve the playlist another way.
1. Try "Clone someone's likes" on a profile with over 500 likes and confirm
   the parts are titled `(1/n)`. A crawl cut short shows a warning
   (`stats.truncated`, 120 s crawl budget).
2. No test calls SoundCloud for real; add one if secret links misbehave.

### 2026-11-04
0. **Node exit 137 kills: cause unknown, quiet since #105, not proven fixed.**
   27 kills on 11-04 and 85 since 10-08 (the earliest logged); the last was
   11-04 15:59:53 UTC. `/health` gaps on 11-04 reached 3-9 minutes each.
   - **Shipped:** #105 went live about 15:41 UTC after #105's own deploy hit an
     Azure 409 and a manual dispatch of `main` succeeded. `/me/playlists` now
     sends `show_tracks=false`. Largest `/api/playlists` response: 4.41 MB
     compressed before, 0.67 MB after, but see the next point.
   - **The quiet period is not a test yet.** The two heaviest clients made 34
     `/api/playlists` requests in the 3 days before the fix and none after. Do
     not call this fixed until a week passes with no kills and those clients
     have returned. Check the App Service logs for `Killed`, not only Discord:
     the monitor needs two failed runs, so a short restart can raise no alert
     (the 15:59:53 kill raised none). The last `[library-load] start` line
     shows which load was running.
   - **Memory is not established as the cause.** Node reached 954 MB before
     the fix, but the 15:59:53 kill came on the new code with Node at about
     124 MB, plan memory 75% and CPU 35%. Plan memory also sat at 97% from
     15:43 to 15:51 while Node reported 0 MB, so high plan memory can be a
     result of restarts. A spike between 1-minute samples is not excluded.
   - **Timing lead:** 53 of 58 kills came within 15 minutes of "Site started",
     peaking broadly at 3-7 minutes. That suggests work resuming after a
     restart rather than a timer. Unproven.
   - **Ruled out:** the retention job (the 15:57:02 run finished in 1 s,
     removed nothing) and the follow-back scheduler (`GROWTH_AUTOCHECK=false`
     in production, so it never runs).
   - **Monitor record:** Discord shows five incidents on 11-04, first failure
     at 13:40:30, 14:30:30 (home and two redirects only), 14:55:30, 15:20:30
     and 15:40:30 UTC, and no DOWN after that.
   - **Measuring trap:** `curl` from a dev machine timed out around 16:00 while
     the monitor's six requests reached the app in the 15:55, 16:00 and 16:05
     buckets. Trust the monitor and App Service logs over a local probe.
   - **Open options, not done:** B2 (the plan is still B1) to separate memory
     pressure from a platform fault, and invalidating old oversized `playlists`
     snapshots, which is a production write. Both wait for the next kill.
   - Also logged: `ERR_ERL_INVALID_IP_ADDRESS` on a port-suffixed `req.ip`,
     which plan task B2 covers.
1. On Cole's next queue: confirm no step tabs stay open and Chrome stays behind
   his app at the end of each gate. If a tab stays, its site is the clue.
2. Tick one SoundCloud direct download on `/downloads/` and confirm it queues
   alone (only the Hypeddit half was run live).
3. ~~Move the extension to a private repo~~ Done 2026-11-04 (see Just done).
   The Hypeddit runner (`feat/hypeddit-runner`, local branch of this repo) is
   still local and unpushed.
4. **Gate sites:** done (see Now). Open follow-ups: decide whether the
   extension's debug mirror (`sc-toolkit-ext-debug`) stays; Cobrand files
   keep the artist's upload name, not "Artist - Title".

### 2026-10-08
0. ~~After #89 and #92 merge~~ **Done 2026-10-08 (see Just done).** What
   remains is a real folder-mode run by Cole: pick a folder in the native
   dialog, confirm the names land on disk, and re-download *SION - FADE*
   (its history row exists without a file). Original steps, still valid: on Chrome, Downloads → a
   source with 3+ direct downloads → "Download all" with the box ticked. Expect
   a folder picker, then files landing as "Artist - Title.wav/.mp3" with no
   Chrome prompt and no check; the panel reads "N saved". Then untick the box
   and run again in a browser without `track-toolkit-multi-download-ok`:
   file 1, Chrome's prompt in the helper tab, file 2, "Did X save?" as a
   dialog on the page and in the helper tab; Yes continues the rest.
   Watch for: a wav whose first bytes are not RIFF (named .mp3 by the
   fallback), and link expiry inside a batch of five large wavs (a `failed`
   row saying the link expired — Resume re-asks).
0b. **Download filenames — decided 2026-10-08: option (b), shipped as #92.**
   Kept for the record: Two real options:
   (a) stream the file through the server with our own
   `Content-Disposition: "Artist - Title.ext"` (`original_format` is on the
   track object) — kills the posture "the server never touches the file",
   costs App Service egress (~3 GB per 46 wavs), only for the allow-listed
   queue; (b) the page fetches each file and writes it with the File System
   Access API into a folder the user picks once — fixes the name **and**
   removes Chrome's multiple-downloads prompt (so the check goes away), but
   Chrome-only and needs two unknowns: CSP `connect-src` for
   `*.cloudfront.net`/`*.sndcdn.com` (ours) and CORS headers on the CDN
   (SoundCloud's; untested — the page could not fetch it under the current
   CSP). Test first: `curl -sI "<cdn link>" | grep -i access-control`. A
   rename-after script is not viable as-is: the page never learns the saved
   name (it would need a server-side HEAD per link to capture it).
1. **Recorded, not fixed (Cole's instruction):**
   - **Flaky e2e:** the downloads "Download all" queue test fails about 3 in
     10 runs when the suite runs in parallel, and can fail an otherwise good
     run (reported by the #80 session). #74 changed those tests (the queue
     tests now start as an "already allowed" browser, with a 400 ms file gap),
     so re-measure on current `main` before deciding a fix. In this session's
     five full e2e runs it did not fail.
   - **Second flaky e2e (seen 2026-10-08 on #87):**
     `growth-genre.spec.ts:35` failed in two full runs (m430, then m390).
     axe `color-contrast` fired on a `.text-primary-foreground` button
     mid-transition (fg #333a4a on bg #ff6b2f, `transition-all duration-200`).
     It passes 160/160 alone with `--repeat-each=5`. The likely fix is to wait
     for the transition, or to move the mouse away, before the axe scan.
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

   Everything else was deleted on 2026-10-08: 50 pre-existing local branches
   (24 of them `worktree-agent-*`) and 25 pre-existing remote branches, plus
   the branches this session created. Each was checked to add nothing to
   `main` (`git merge-tree --write-tree origin/main <branch>` gives
   main's own tree), plus 17 clean worktrees.
3. **Carried from #68 (closed), still open:**
   - The extension repair (`~/Developer/tracktoolkit-extension-work`, branch
     `fix/extension-domain`) and the Hypeddit runner are unpushed because the
     repo is public. Make the repo private, or move both to a private repo.
   - ~~Add the sideloaded extension's ID to `CHROME_EXTENSION_IDS`~~ Done
     2026-10-08: `ckjliacjcpfmjdefabdhicmhmpdckccb`, the unpacked load of
     `~/Developer/tracktoolkit-extension-work` (v1.5.0). Verified: a CORS
     preflight from that origin gets 204 with credentials, and a POST passes
     the origin guard (401, no cookie). The ID comes from the folder path, since
     the manifest has no `key`, so moving the folder changes it. The setting is
     not in Bicep, so **`infra/deploy.sh` removes it**; re-add it afterwards.
   - ~~The extension's stepper no longer matches live gates~~ Fixed 2026-11-03
     (`011c7a2`): the extension is the way to do gates again. Its
     `comment-cleanup.js` still does not check which page it is on.
   - **2026-10-08: the runner's logins are bot-blocked.** SoundCloud,
     Instagram and Spotify all refused sign-in in the runner's Playwright
     Chromium, and SoundCloud blocked the network IP ("We detected unusual
     activity…"). The runner cannot work without evading bot detection, which
     is out of scope, so don't add stealth or session-copying workarounds.
     Gates go manual in Cole's normal browser. A "work through gates"
     checklist on `/rekordbox-gaps` was offered (it opens links only).
   - First real Hypeddit run (superseded by the line above):
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


### From the 2026-10-08 downloads session
- **The multiple-downloads check stays, and it blocks a restart** (2026-10-08).
  It is the only thing stopping a run from reporting files as "started"
  that Chrome silently held (#65). It is now a modal on every width plus the
  same question in the helper tab; `enqueue` and `start` both refuse while it
  is pending. Do not turn it back into a panel card, and do not let
  "Download all" replace a queue with a pending check.

- **Downloads save through the page, not the server** (2026-10-08). Folder
  mode fetches the CDN file in the browser and writes it with the File System
  Access API; the server still only exchanges `download_url` for a link. Do
  not add a streaming proxy for filenames — the CDN is CORS-open and this
  keeps "the server never touches the file" true. The helper-tab flow stays
  as the fallback for browsers without the API and for anyone who unticks
  the box.

### From the 2026-11-03 Hypeddit session
- **The extension works every Hypeddit tab, not only queue tabs** (Cole,
  2026-11-03). Autofill and click-through on a gate opened by hand is what he
  had and wants. Commit `2000b1b` removed it without asking; don't remove it.
- **Tracks are picked with row checkboxes** (Cole, 2026-11-04). Auto-Download
  stays for select-all; it must not be the only way in.
- **A queue must not take focus** (Cole, 2026-11-04). Queue tabs never call
  `window.open`; the worker opens step pages as background tabs. A minimized
  queue window was tried and failed (`60947ea`), so don't bring it back.
- **Agents reload the extension themselves** (Cole, 2026-11-04), through
  `src/dev-reload.js`. Wait up to a minute after an edit; don't ask him.
- **No captcha, bot-check or `isTrusted` workarounds.** The stepper stops at a
  captcha and leaves the gate to the person.
- **Account block lives at the top of the sidebar** (Cole, 2026-11-04):
  profile + name, theme toggle, log out, Support Me. The nav list scrolls
  inside the sidebar, never the whole page. Support Me keeps the shiny text.
- **Mobile navigation is a bottom tab bar with sheets** (Cole, 2026-11-04):
  Dashboard, Playlists, Social, Downloads, More, below `lg`. Playlists and
  Social open a sheet of their group. More opens the account block first, then
  a filter over every tool, then everything without a tab. Replaced the
  hamburger drawer. Tab order follows the `nav.ts` groups, not usage data.
- **On a phone the login button sits at the bottom of the screen** (Cole's ask
  to optimize for mobile, 2026-11-04): logo and tagline at the top, a plain
  column with no card chrome, the card returning from `sm`.

### From the 2026-11-04 gate-sites session
- **Cobrand gate tabs may come to the front** (Cole, 2026-11-04), an
  exception to "a queue must not take focus": Cloudflare's Turnstile only
  runs in a visible tab. Only the running Cobrand gate's own tab; every other
  queue tab stays in the background.
- **The extension lives in the private repo `cole-hackman/tracktoolkit-extension`**,
  never in this public one. Gate automation details stay there; this file and
  `CLAUDE.md` get one-sentence summaries.
- **Droploud gates are full auto in the extension** (Cole, 2026-11-04),
  performing every action the gate requires on Cole's real account. A per-run
  cap (default 10) limits how many go in one queue.
- **Cobrand gates are automated too** (Cole, 2026-11-04). Each signup consents
  to that artist's marketing SMS; the web app says so before sending.
- **No bypassing server-checked gate steps** (2026-11-04). Steps a gate
  verifies (OAuth-run actions, a checked repost, Turnstile, phone) are done for
  real; only honor steps the gate itself does not check are clicked through.
  Do not build or research ways to make a gate believe an action happened.
- **The extension ships before the web app**, and the web app shows new gate
  sites only when the extension says it supports them
  (`sc-toolkit-ext-gates`); the queue keeps the `sc-toolkit-hypeddit-queue` key.

### From the 2026-11-04 clone-private session
- **A copy of a private playlist is private** (Claude's call, 2026-11-04, not
  yet reviewed by Cole): a secret link or `sharing: 'private'` source makes
  every cloned part `sharing: 'private'`. Cloning used to hard-code public.
  Revisit only by asking Cole.
- **Clone a user's likes** is a separate route from followed-likes (which needs
  a followed user), takes any profile URL, and reuses `createOrAppendTrackIds`.

## Landmines
- **Gate pages differ from guesses; capture before building** (2026-11-04).
  Droploud serves two layouts (v1 `dtr-`, v2 `dltg-`) with different button
  text; SoundCloud's track page is a same-origin iframe whose Repost state is
  its `aria-label` (pressing "Unpost / Edit repost" removes it); Cobrand has no
  `<form>`, and its Turnstile token is made after Sign Up is pressed. The
  extension repo's `test/fixtures/` README says which fixtures are captured.
- **Never fetch 1001Tracklists from the server.** A plain request (`curl`,
  Node `fetch`) gets HTTP 401 `www-authenticate: reCaptcha` and an image
  captcha on every tracklist page (checked 2026-11-02 on two sets); a real
  browser does not. Getting past that is circumventing a bot check, so
  `/set-to-playlist` works on text the user pastes from their own browser,
  and `sourceUrl` is printed in the description, never requested. The
  SoundCloud id on a 1001TL row only arrives through
  `/ajax/get_medialink.php` when its player icon is clicked; calling that in
  bulk (from an extension, say) is undocumented, unlicensed use and may
  trip the captcha on the user's own session. There is no terms page
  (`/info/terms.html` is 404); robots.txt allows `/` with `Crawl-delay: 8`.
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
- **Anything pinned to the bottom of an app page must offset by
  `--mobile-nav-h`**, or it lands under the tab bar. It is `0px` from `lg` up.
- **Cole's own browser window is below `lg` on tracktoolkit.com** (seen
  2026-10-08: mobile header, queue as the bottom bar). Anything that lives
  only in a `lg:` side column is invisible to him. Verify UI live at his
  width, not just at 1280.
- **This checkout is shared by concurrent sessions.** On 2026-10-08 another
  session switched the main checkout to `main` and pulled while this one was
  editing on a branch; one edited file was lost and the rest landed on the
  wrong base. Work in a worktree (`.worktrees/<branch>`, node_modules
  symlinked from the main checkout, `E2E_PORT` of your own) and leave the main
  checkout alone.
- **`window.open` always shows Chrome's window**, even for a tab of a hidden
  window, and that pulls Chrome in front of the app in use. Hypeddit's popup
  helper also calls `focus()` on the result.
- **Spotify's step needs its tab alive past 10 s.** With no `window.opener`,
  `/spotify_callback` writes `hypeChildWindow` to localStorage and the gate
  moves on from the `storage` event. A leftover identical value fires no event,
  so opening that callback by hand can stall the next gate: remove the key.
- **Do not trust `onCreated` for `openerTabId` on a tab from `tabs.create`.** It
  looks unset at that point (inferred from tabs never closing), and
  `test/fake-chrome.mjs` does not reproduce it, so tests passed with the bug.
- **Hypeddit starts its own download up to about 6 s after the unlock.** The
  worker waits up to 15 s before starting one, or each file saves twice.
- **The extension's saved email lives per extension ID.** The ID comes from the
  folder path, so loading another folder means an empty `hdEmail` and gates
  stopping at the first step.
- **Closing the lid interrupts gate downloads.** They need Resume in
  `chrome://downloads`, and a signed link lasted about 100 minutes. The queue
  reports a track done when its download starts, not when the file lands.
- **A secret link's `s-…` token is a credential.** It goes to SoundCloud only as
  `secret_token`; the clone description uses `stripSecretToken`. Never log the
  raw URL or put it in `OperationLog` metadata.
