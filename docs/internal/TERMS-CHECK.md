# TERMS-CHECK — SoundCloud API Terms Questions Blocking the Catalog Branch

The vendored OpenAPI spec (`docs/api.json`, `info.termsOfService`) points to
the governing terms: **https://developers.soundcloud.com/docs/api/terms-of-use**

The terms text is **not** in this repo and could not be fetched from this
environment (network egress blocked). Nothing below is a reading of the terms —
it is a checklist of exactly what to verify yourself before deploying the
branch or running the backfill. The backfill job (~18,613 historical track IDs)
is gated behind a default-off env flag and has **not** been executed; keep it
off until every item below is answered.

---

## 1. Metadata caching / storage duration limits

**What to check:** Does the terms-of-use limit how long API responses (or data
derived from them) may be cached or stored? Common patterns: a fixed TTL
(e.g. 24 hours / 30 days), "no permanent storage", or "cache only as needed to
operate the service".

**What depends on the answer:**
- The `tracks` / `playlists` catalog itself, which stores title, artist,
  genre, duration, and access status **indefinitely** ("retained while the
  service operates").
- The operation-log metadata JSON, which retains touched-ID arrays with no
  expiry.
- The backfill job, which would bulk-populate the catalog from historical IDs.

**If restrictive:** switch the catalog to TTL-based storage — stamp each row
with `fetchedAt` and either re-verify against the API or delete rows older
than the permitted window; drop the "retained while the service operates"
wording from the privacy draft; and do not run the backfill (bulk-storing
18k rows is the least defensible act under a caching limit).

## 2. Delete-on-upstream-removal requirements

**What to check:** Does the terms-of-use require deleting cached/stored data
when the underlying content is removed from SoundCloud (track deleted, made
private, or taken down)?

**What depends on the answer:**
- The current design's **keep-row-with-`access='gone'`** policy: when a track
  disappears upstream, the catalog keeps the row, flips access to `'gone'`,
  and preserves the last-known metadata (title, artist, genre, duration).

**Does keep-as-'gone' survive a delete-on-removal clause? No.** If the terms
require deleting cached data when content is removed upstream, retaining
last-known metadata under a `'gone'` flag is exactly the retention the clause
prohibits — the flag does not change what is stored. In that case `'gone'`
must become a **hard delete**: the row is removed (at most an opaque tombstone
of the numeric ID with no metadata, and only if the terms permit even that).
The aggregate view would then lose deleted tracks from historical trends;
accept that rather than argue the flag is compliance.

## 3. Dataset / aggregation prohibitions

**What to check:** Does the terms-of-use prohibit building databases or
datasets from API data, aggregating data across users, or using API data for
analytics beyond operating the service? Watch for wording like "no data
mining", "no building a database of SoundCloud content", or purpose-limitation
clauses ("solely to provide your application's functionality to the user").

**What depends on the answer:**
- The catalog **is** a cross-user database of SoundCloud content — that is
  its point.
- The **admin-only aggregate view** (trends by genre/artist/availability
  across all users' operations) is analytics beyond serving any individual
  user's request.
- The backfill exists only to make that dataset more complete; it serves no
  user-facing feature.

**If restrictive:** do not run the backfill at all (delete the flag and job);
drop the admin aggregate view; and either drop the catalog or narrow it to a
strict per-request cache used only to serve the requesting user's own
features. A purpose-limitation clause alone — even without an explicit
database prohibition — likely forbids the trend-analysis use.

## 4. Post-revocation retention

**What to check:** What must be deleted when a user revokes OAuth access or
deletes their account? Does anything obtained via that user's token have to
go, or only their tokens/credentials and personal data?

**What depends on the answer:**
- **Operation logs:** the branch retains a user's operation-log ID arrays
  after they stop using the app (only account deletion removes them, and
  OAuth revocation by itself deletes nothing).
- **Catalog rows sourced via a revoked user's token:** enrichment calls
  `GET /tracks?ids=` with the user's own OAuth token. If the terms say data
  obtained through a user's authorization must be deleted when that
  authorization is revoked, rows (or fields) that exist *only* because of that
  user's token are affected — and today the schema does not record which
  token sourced which row, so provenance tracking would have to be added
  before the rule could even be enforced.

**If restrictive:** on revocation/deletion, purge catalog rows sourced only
from that user's token (requires adding a `sourceUserId`/provenance column
first); treat detected OAuth revocation like account deletion for operation
logs; and shorten operation-log retention rather than keeping ID arrays
indefinitely for departed users.

---

## Client-credentials question (why enrichment is piggyback-only)

`docs/api.json` → `components.securitySchemes.oAuth2_1.flows` declares **both**
`authorizationCode` and `clientCredentials` flows, so the SoundCloud API
*generally* supports app-level (client-credentials) tokens. But whether **this
app's registration** is enabled for client credentials cannot be determined
from the repo — that depends on the app's registration with SoundCloud, not on
the spec.

Consequences, as implemented:
- Catalog enrichment ships **piggyback-only**: `GET /tracks?ids=` is called
  with the requesting user's own OAuth token, during that user's operations.
- A **nightly client-credentials sweep** (re-verifying catalog availability
  status app-wide without any user token) is **not built**. Before building
  it: confirm the registration actually issues client-credentials tokens, and
  re-check items 1–3 above — a background sweep is service-operator analytics,
  not user-serving activity, and sits squarely under any purpose-limitation
  clause.

---

# Answers (2026-09-22)

## Provenance and caveat — read before citing anything below

The clause text quoted in this section comes from
`.superpowers/sdd/do-on-new-branch-logical-cake/soundcloud-terms-clauses.md`,
which records the terms at
https://developers.soundcloud.com/docs/api/terms-of-use ("Last Updated: 30
March 2024") **as retrieved by an automated fetch on 2026-09-21**. That file
carries this caveat, repeated here verbatim because it governs everything
below:

> The quoted lines are as the fetch returned them; re-verify against the live
> page before treating any as a verbatim citation in a legal document.
> Anything marked (paraphrase) came from a search summary, not the page text.

Accordingly: **nothing in this section is a legal citation.** Quotes are
reproduced as retrieved and must be re-verified against the live page before
being cited anywhere that matters. One item below is marked `(paraphrase)` in
the source and is labelled as such here; it is not quoted text.

Where the retrieved text does not settle a question, this section says **"to
verify"** rather than asserting an answer. Statuses describe what the code
does, not whether a clause is satisfied — that judgement needs the verified
wording first.

## Finding A — privacy policy (questions 1, 3, 4 context)

Quote, as retrieved:

> "You must have a privacy policy in place which explains how you, through
> your API-connected product or service utilizing User Content, collect,
> store, process, transfer and use any Personal Data."

Data minimisation, quote fragment as retrieved:

> you "must not request access to more Personal Data than you actually need
> for the effective operation of your app, and must not retain Personal Data
> for longer than is reasonably necessary."

**What this branch does.** The privacy page is the disclosure surface. The
mechanisms it can point at now exist rather than being described in the
abstract:

- `GET /api/auth/export` — every row keyed to the user, as a JSON download.
- `DELETE /api/auth/account` — deletes the account; every per-user table
  cascades (guarded by `tests/account-deletion-cascade.test.js`).
- `POST /api/auth/disconnect` — hands the grant back and destroys the stored
  tokens without deleting the account.

On minimisation, the retention job now bounds three stores that previously had
no expiry at all: operation logs (`OPLOG_RETENTION_DAYS`, 365), library cache
(`CACHE_TTL_DAYS`, 7) and dormant accounts (`INACTIVE_MONTHS`, 24).

> **Superseded 2026-11-11 (Cole):** the 365-day operation-log purge is gone.
> Logs now live as long as the account (deleted with it on account deletion,
> the 6-day disconnect sweep and the 24-month dormancy sweep), so the
> "no longer than is reasonably necessary" ceiling for that store is now the
> account's own lifetime. The deletion-on-revocation and 7-day limits below
> are unaffected: they act on the account, and the logs cascade with it.

**To verify:** whether the retrieved fragment is complete, and whether "no
longer than is reasonably necessary" is elsewhere given a specific ceiling for
any of these stores.

## Finding B — deletion on revocation, and the 7-day limit (question 4)

Deletion on revocation, quote as retrieved:

> "Unless otherwise permitted by applicable law and/or agreed with the
> relevant user, when a user revokes access to their SoundCloud account, you
> must ensure that all Personal Data and User Content pertaining to that user
> is deleted from your app, networks, systems and servers as soon as
> reasonably possible."

Seven-day limit, quote **fragment** as retrieved:

> "you shall discontinue accessing the applicable SoundCloud Personal Data and
> delete the applicable SoundCloud Personal Data in your possession or control
> without undue delay, but in any case within 7 days"

**What this branch does.**

| Mechanism | Where |
|---|---|
| A disconnect action exists | `POST /api/auth/disconnect` → `disconnectUser()` |
| Revocation is detected **when the user next comes back** — not on its own | `invalid_grant` at the refresh choke point runs the same teardown with `reason: 'revoked'`. Detection is lazy: it only happens inside a token refresh, which only happens when a request the user made 401s. See "Detection latency" below — this is the weakest part of the position |
| Credentials destroyed immediately | `tokens` row deleted, auth memo invalidated, library caches and durable snapshots dropped — synchronous, not deferred to the job |
| Remaining rows removed after 6 days | retention step 2: `users.disconnectedAt < now - 6d` → `user.deleteMany`, cascading to operation logs, growth actions, votes, cache pages |
| Reconnecting cancels the deletion | a successful OAuth callback sets `lastLoginAt` and clears `disconnectedAt` |

`DISCONNECTED_GRACE_DAYS = 6` is a constant in `server/lib/retention.js`, not
an environment variable, so the window cannot be widened from a deployment
dashboard.

**RESOLVED 2026-09-22 — the deadline is now met, and it was not before.**
This was `7`, which read as compliant and was not. The sweep runs once a day,
so the time from the disconnect to the row's deletion is the grace period plus
however long until the next run — at seven, a worst case of 7 days + one
`RETENTION_INTERVAL_MS`, i.e. up to eight days, outside a ceiling the retrieved
text states as an absolute ("in any case within 7 days"). Dropping the constant
to `6` puts the same worst case at 6 days + one daily interval ≈ 7, inside the
ceiling, while leaving the sweep's cadence alone.

So, against the wording as retrieved, this mechanism now meets the 7-day limit
rather than straddling it. The three user-facing statements of the window —
the disconnect card and the dialog description in
`frontend-UI/src/app/(app)/account/page.tsx`, and the retention section of
`frontend-UI/src/app/privacy/page.tsx` — all say six days, in identical words,
so the policy people are shown is the policy the job enforces.
`tests/retention.test.js` asserts the cutoff, and its comment says why the
number is 6, so a future tidy-up cannot quietly restore the breach.

The items below are unchanged: they are about the wording, which is still
unverified, not about the arithmetic, which is now correct either way.

**To verify, and it matters:**

1. **What triggers the 7-day fragment.** The retrieved text is a fragment with
   no surrounding sentence, so the condition it attaches to is unknown from
   here. It may or may not be the same event as the revocation clause above.
2. **Whether "as soon as reasonably possible" (revocation clause) is
   compatible with a grace period at all.** The two retrieved passages use
   different standards. This branch assumes the credentials-immediately /
   rows-within-6-days split satisfies both, but that assumption rests on
   unverified wording. If "as soon as reasonably possible" governs the user
   rows too, the grace period has to go — shortening it from 7 to 6 does not
   answer this question, it only removes the arithmetic breach against the
   other clause.
3. **Scope.** Whether "all Personal Data and User Content pertaining to that
   user" reaches catalog rows enriched via that user's token. The schema still
   records no provenance, so as question 4 above already noted, the rule could
   not be enforced today even if it applies.
4. **Detection latency — and the population it never reaches.** Revocation is
   noticed only inside a token refresh, and a refresh only happens when a
   request the user made comes back 401. **Someone who revokes in SoundCloud's
   settings and never opens this app again is therefore never detected at
   all.** Their `disconnectedAt` is never stamped, the 6-day clock never
   starts, and every row keyed to them — tokens included — survives until the
   dormancy sweep at `INACTIVE_MONTHS` (24 months). For that population the
   7-day clause is not met, and it is not a latency of days but of up to two
   years.

   The 6-day window is therefore the worst case **only for users who come
   back**. Nothing in the table above closes the other case, and the earlier
   version of this document claimed otherwise — it said revocation was
   detected "without the user telling this app", which is true only of a user
   who is still using the app.

   The fix is a proactive sweep: once a day, attempt a refresh for token rows
   untouched for N days and run the teardown on a *genuine* `invalid_grant`.
   It is deliberately not on this branch, because it must not ship before the
   refresh path can tell a genuinely revoked grant from a refresh token that
   has merely been spent — `_resolveInvalidGrant` in
   `server/lib/soundcloud-client.js`. Without that, a daily sweep presenting
   stale tokens would disconnect live users in bulk.

The worst case for a returning user is bounded by the job cadence: 6 days plus
up to one `RETENTION_INTERVAL_MS`, so at the default 24h it lands at roughly 7
days and inside the ceiling. That is exactly the margin the sixth day buys,
which is why `RETENTION_INTERVAL_MS` is **clamped to a 24h maximum in code**
(`resolveIntervalMs` in `server/lib/retention.js`, which logs when it refuses a
larger value) rather than merely documented as compliance-relevant. Lowering it
is always allowed; raising it past the deadline is not possible from a
deployment dashboard.

## Finding C — session-based caching (questions 1 and 3)

Quote, as retrieved:

> "Your app may employ session-based caching, but only to the extent
> reasonably necessary for the operation of your app during that session, and
> any cached content must cease to be available, accessible or playable within
> your app at the end of that session."

Quote fragments, as retrieved: the app "must not include file-save
functionality, or otherwise designed to cache, download or persistently store
any User Content" and must not provide "offline access to any User Content".

This is the restrictive reading question 1 anticipated, and it is **narrower
than a fixed TTL** — the retrieved text ties cache lifetime to the session,
not to a duration.

**What this branch does, and what it does not.**

- The library cache (`library_cache_pages` / `library_cache_states`) is now
  bounded: retention step 1 deletes rows older than `CACHE_TTL_DAYS` (7).
  **Seven days is longer than a session, so this does not meet the retrieved
  wording.** It is bounded where it used to be unbounded; that is all.
  Session-scoped eviction is not implemented.
- The **catalog** (`tracks` / `playlists`) persistently stores track metadata
  across sessions and across users. It is untouched by this branch. **The
  backfill remains unrun and its flag default-off.**
- Operation-log metadata retains touched-ID arrays. It was bounded at 365 days
  (a duration, not a session); since 2026-11-11 it is kept with the account.

**To verify:** whether "User Content" as defined in the terms covers stored
*metadata* (title, artist, genre, duration, permalink) or only the audio
itself. The whole catalog question turns on that definition, and the retrieved
fragments do not include it. Question 3 above also asked about an explicit
"no separate database" prohibition; **no such clause appears in the retrieved
text**, so that specific claim is unsupported and is not made here.

**Still open:** session-scoped library-cache eviction; the catalog's existence
and the admin aggregate view built on it.

## Finding D — reflecting uploader removals (question 2)

**(paraphrase — not quoted from the page.)** The source file records, from a
search summary rather than the page text:

> if an uploader removes an item or disables API access, the app must reflect
> and respect that change as soon as reasonably possible.

This is **not** verified clause text and must not be relied on. It is
directionally consistent with what question 2 above already decided on its own
reasoning: *"retaining last-known metadata under a `'gone'` flag is exactly the
retention the clause prohibits — the flag does not change what is stored."*

**What this branch does** — the change stands on question 2's reasoning, not on
the paraphrase. Retention step 8 strips metadata from `gone` rows on every run:

```
track.updateMany({
  where: { access: 'gone', title: { not: null } },
  data: { title: null, artistName: null, genre: null,
          genreNormalized: null, permalinkUrl: null },
})
```

What survives is the numeric SoundCloud ID and the `gone` status — the opaque
tombstone question 2 allowed for, with no cached metadata attached. Historical
operation logs still resolve; aggregate views lose deleted tracks from their
trends, which question 2 said to accept.

Detection is unchanged and remains **piggyback-only**: `server/lib/enrichment.js`
marks rows `gone` when `GET /tracks?ids=` stops returning them, during a user's
own operations. A track nobody touches can stay stale indefinitely. A background
sweep would fix the latency but is itself service-operator activity under
Finding C, so it is still not built.

**To verify:** the actual clause text on uploader removals, including whether
"private" is treated the same as "removed", and what standard of promptness
applies.

## Summary

| Finding | Status after this branch |
|---|---|
| A — privacy policy | Export, delete and disconnect all exist and work; minimisation ceilings to verify |
| B — deletion on revocation / 7 days | **Meets the retrieved wording** as of 2026-09-22: the grace period is 6 days, so the daily sweep's worst case (grace + one interval) lands inside the 7-day ceiling instead of past it. Wording still to verify (trigger for the 7-day fragment, and whether a grace period is compatible with "as soon as reasonably possible" at all) |
| C — session-based caching | **Does not meet the retrieved wording.** Caches bounded by duration, not session; catalog and admin aggregate untouched; backfill unrun |
| D — uploader removals | Metadata now stripped from `gone` rows; rests on question 2's reasoning, not on verified text; detection latency remains a gap |

Nothing here changes the standing instruction on the backfill: it stays off.

## Other clauses in the retrieved file, not assessed here

The source file also records clauses on attribution when displaying content,
multi-user storage, user-initiated actions only, and naming/domain
restrictions. This section did not assess any of them — they are outside the
account-lifecycle work — but they bear on the growth suite, the display
surfaces and the rebrand, and should be picked up separately.
