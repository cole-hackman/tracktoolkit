# Decisions

Settled choices agents must not undo. Moved word for word from the Decisions section of docs/internal/STATE.md on 2026-11-12 (64 entries). Equally binding as if they were still in the state file.

### From the 2026-11-10 downloads-usage session
- **Gate downloads are logged server-side, via the page** (Cole, 2026-11-10):
  the extension stays server-free; the Downloads page forwards per-track gate
  outcomes to `POST /api/downloads/gate-results`. Cole chose not to change the
  privacy policy because the accounts using it are internal testers he has
  briefed. **The policy's line "the download queue you build … is never sent to
  us" (`app/privacy/page.tsx`) is no longer literally true for gate outcomes**,
  so revisit it before the extension or the allowlist goes beyond those testers.
### From the 2026-11-05 design-system session (PR #110)
- **Tool pages are built from the shared pieces in DESIGN-SYSTEM.md**: one
  width per page type (`PageContainer kind`), one spacing scale, `Panel`
  sections, `ToolLayout` for pick-then-act pages. A hand-rolled equivalent
  needs a reason written next to it.
- **A run's outcome is `ResultPanel status=` in the slot under the header**,
  never a screen that replaces the tool. Exceptions: Growth's step 4,
  per-row and in-dialog errors, the feedback confirmation.
- **Pick-one lists are buttons (`PlaylistChoiceRow`), never radios**: a
  radio group commits on arrow keys, and choosing a playlist loads it.
- **Search covers the whole collection**, never only rendered rows; "Select
  all" with a query selects the matches. Downloads' "Download all" still
  means the whole source.
- **Dashboard order comes from `TOOL_RANKING`** (unique users, ANALYSIS.md);
  the four groups stay; the sidebar keeps `nav.ts` order.

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
- **`OperationLog` is kept while the account exists** (Cole, 2026-11-11),
  superseding "kept 12 months". The 365-day purge (`OPLOG_RETENTION_DAYS`) is
  removed; rows go with their user through the account-deletion, 6-day
  disconnect and 24-month dormancy cascades. The all-time figures are running
  totals (`lifetime_registered_users`, `lifetime_tracks_processed`) extended
  at the start of every retention run, before any delete, and the README
  badges and the admin all-time tiles read those same rows. Revisit the
  privacy wording if a time limit comes back.
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
- **A copy of a private playlist is private** (confirmed by Cole, 2026-11-04):
  a secret link or `sharing: 'private'` source makes every cloned part
  `sharing: 'private'`. Cloning used to hard-code public.
- **Clone a user's likes keeps the follow gate** (Cole, 2026-11-04): it works
  only for a profile the caller follows (or their own), checked with
  `assertFollowedUser` before any crawl; otherwise 403 `NOT_FOLLOWED`. It
  reuses `createOrAppendTrackIds`.
- **A secret-link token never leaves the request**: not stored, not in the
  description, not logged (`redactSecretToken` in `scRequest`), not in the
  catalog (secret-link sources are not harvested). Share-menu tracking
  (`ref`, `si`, `utm_*`) is dropped before `/resolve`; a short link's token
  comes back from the resolve redirect as a non-enumerable `secretToken`.

