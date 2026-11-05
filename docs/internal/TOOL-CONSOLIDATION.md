# Tool consolidation — candidates, evidence, and what would confirm them

Written 2026-11-05 with the design-system migration (`feat/design-system`).
**Nothing here has been combined or removed.** Each candidate below says
what the existing data and the code already show, and what
`docs/sql/analysis-tool-sequences.sql` must show before it is worth doing.

## Can we measure which tools people use in succession or repeatedly?

Yes, from data we already collect — with limits.

`operation_logs` has one row per operation with `userId`, `action` and
`createdAt`, which is enough to rebuild what a person did in a sitting:
`docs/sql/analysis-tool-sequences.sql` groups each user's rows into 30-minute
sessions, maps actions to tools, collapses the bulk tools' per-chunk rows
into one run, and reports per tool: reach, tool-to-tool transitions within a
session, repeats within a session, and repeat use across days.

Limits, all of which bias the answer and should be read with it:

- **Only writes and runs are logged.** A visit that only looks (opens Like
  Manager, scrolls, leaves) is invisible, so "used A then B" means "ran A
  then ran B". `view:*` rows would fill this in, but ANALYSIS.md §5.8 found
  none in the 2026-08 export; the query excludes them by design, and whether
  production has them now is unchecked.
- **Three pages share one action.** Activity → Playlist and Recently Played
  create a *new* playlist through `POST /api/playlists/from-likes`, the
  Likes → Playlist endpoint, so those runs are logged as `from-likes` with
  nothing to tell them apart (no source field, no `clientInfo` on that call).
  The query therefore counts them as Likes → Playlist, and so does
  ANALYSIS.md's 717. (This repo's history for those two pages starts at the
  2026-09-23 import, so whether they existed during the March–August export
  is not recorded here.) Adding to an *existing* playlist from them is the
  PUT below and is not logged at all.
- **Several runs log nothing**: Health Check's fix, and the add-to-existing
  path of Activity → Playlist and Recently Played, save through
  `PUT /api/playlists/:id`, which is not logged as an operation; Export runs
  in the browser. They cannot appear in a sequence. Downloads logs only when
  a link is fetched.
- **`proxy-download` has no single page** (Downloads, Link Resolver,
  Rekordbox gaps and Playlist Modifier all call it), so it stays its own
  "tool" in the report.
- **Retention**: `operation_logs` is kept 365 days, so the query sees at most
  the last year.
- **The 30-minute gap is a convention**, not a measurement. Re-run with 15
  and 60 minutes; a finding that only holds at one gap is not a finding.

### Query

`docs/sql/analysis-tool-sequences.sql`. Read-only: `BEGIN TRANSACTION READ
ONLY; … ROLLBACK;`. **Tested** on PostgreSQL 16.15 against 19 fixture rows
for three users covering every rule (excluded `view:`/`read:`/`auth-login`/
`admin-*` rows; a three-row `bulk-unlike` collapsing to one run; two
separate merges two minutes apart staying two runs; a 45-minute gap starting
a new session; a second-day return). All 21 output rows matched the values
worked out by hand (12 runs from 15 rows, 6 sessions, `combine` reached by 3
users in 5 sessions, `combine → library-audit` share 1.000, `combine`
repeated in one session, `combine` used on 2+ days by 1 of its 3 users).
**It has not been run against production.**

Fixture used (create in a scratch database, then run the query file):

```sql
CREATE TABLE operation_logs (id text PRIMARY KEY DEFAULT md5(random()::text),
  "userId" text NOT NULL, action text NOT NULL, status text NOT NULL DEFAULT 'success',
  "trackCount" int NOT NULL DEFAULT 0, "itemCount" int NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT now());
INSERT INTO operation_logs ("userId", action, "createdAt") VALUES
 ('u1','view:combine','2026-08-01 10:00:00'), ('u1','auth-login','2026-08-01 10:00:05'),
 ('u1','merge','2026-08-01 10:01:00'), ('u1','merge','2026-08-01 10:03:00'),
 ('u1','library-audit','2026-08-01 10:05:00'), ('u1','read:likes','2026-08-01 10:06:00'),
 ('u1','bulk-unlike','2026-08-01 10:10:00'), ('u1','bulk-unlike','2026-08-01 10:10:40'),
 ('u1','bulk-unlike','2026-08-01 10:11:20'), ('u1','from-likes','2026-08-01 10:20:00'),
 ('u1','merge','2026-08-01 12:30:00'), ('u1','merge','2026-08-02 09:00:00'),
 ('u2','resolve','2026-08-01 11:00:00'), ('u2','merge','2026-08-01 11:05:00'),
 ('u2','bulk-unfollow','2026-08-01 11:50:00'), ('u2','bulk-unfollow','2026-08-01 11:50:30'),
 ('u2','growth-discover','2026-08-01 12:00:00'), ('u2','admin-re-resolve','2026-08-01 12:01:00'),
 ('u3','merge','2026-08-01 15:00:00');
```

### Reading the output

`transition` rows: `share` is the fraction of all transitions **out of**
`tool` that go to `next_tool`. A pair is a real path when it is both frequent
(users, not occurrences) and a large share. `repeat_session` with many
occurrences per session means people use a single-item tool as if it were a
batch tool. `repeat_days.share` is the fraction of a tool's users who came
back to it on another day.

Use **users** for every threshold below. One power user with 300 sessions
should not decide a page's fate.

---

## Candidates

Usage figures are unique users from ANALYSIS.md §3 (2026-03-19 → 2026-08-08,
1,855 users). "No data" means the tool logs no operation or is newer.

### 1. Link Resolver + Batch Link Resolver → one resolver

- **Data:** resolve 202 users, batch-resolve 23. 156 users' *first* action is
  resolve, so the single resolver is an entry door; the batch one is barely
  found.
- **Code:** the same family of endpoints (`POST /api/resolve`,
  `POST /api/resolve/batch`, both `heavyOperationRateLimiter`), the same
  output fields. The batch page is a textarea that accepts one URL as well as
  fifty; the single page is the batch page with one line and a richer card.
- **Shape:** one page with a textarea that grows; one link shows the full
  card, several show the table.
- **Confirm with the query:** `repeat_session` for `link-resolver` — if a
  meaningful share of resolver users (≥15%) run it 3+ times in one session,
  they are batching by hand and the merge helps them. Also
  `link-resolver ↔ batch-link-resolver` transitions: any at all from the same
  users means the split is costing a page change.
- **Risk:** the dashboard's quick "Resolve" box and `?url=` deep links target
  `/link-resolver`; keep that route.

### 2. Likes → Playlist + Activity → Playlist + Recently Played → "Tracks → Playlist"

- **Data:** from-likes 717 users (the #2 tool). Activity and Recently Played
  have no figure of their own: their new-playlist saves are logged *as*
  `from-likes` (same endpoint), and their add-to-existing saves are the
  unlogged PUT. That shared endpoint is itself evidence for this candidate —
  the server already treats the three as one operation.
- **Code:** after this migration all three are the same workbench —
  a searchable track list on the left, `SegmentedControl` new/existing, a
  name or `PlaylistChooser`, one button on the right. They differ only in the
  source list (`/api/likes`, `/api/activities`, `/api/recently-played`) and
  the write (from-likes creates or appends via the server; the other two PUT
  an append).
- **Shape:** one page with a source switch (Likes / Feed / Recently played).
- **Confirm with the query:** cannot be confirmed until the three pages are
  told apart in the log (send a `source` with the from-likes call and record
  it in `metadata`, and log the PUT path — a small server change, out of
  scope here). Then: share of `likes-to-playlist` users who
  also run either of the others (transition users ≥10% of the smaller
  tool's users), and whether those sessions chain them.
- **Risk:** from-likes is the flagship; any change to it must keep its
  500-track split and its 409 handling. Cheapest version: keep the route, add
  the source switch.

### 3. Library Audit + Playlist Health Check → one "Playlist health"

- **Data:** library-audit 204 users (#3), 80 users' first action. Health
  check: no data (its fix is the unlogged PUT; the scan is a read).
- **Code:** both answer "what is wrong with my playlists" —
  `server/lib/library-audit.js` scans every playlist for duplicates,
  unavailable tracks and download links; Health Check scans one playlist for
  blocked/preview tracks and then **fixes** it (PUT with `remove`). The audit
  finds, the health check repairs; today a user has to notice that and walk
  from one to the other.
- **Shape:** the audit's report with a "Fix" action per playlist that opens
  the health check's repair view for that playlist.
- **Confirm with the query:** `library-audit → playlist-modifier` and
  `library-audit → combine` transitions (the only logged ways to act on an
  audit today); a high `repeat_days.share` for library-audit says it is a
  check-up people come back to, which favours putting the repair inside it.
  Health Check needs a logged run first, as in 2.

### 4. Playlist Cloner + Following Library (copy someone else's music)

- **Data:** clone 127 users; followed-likes-to-playlist 24 and
  followed-playlist-clone 11.
- **Code:** both copy other people's playlists and likes into the caller's
  account. "Clone someone's likes" (`clone-user-likes`) and Following
  Library's likes copy both go through `createOrAppendTrackIds`, and both
  apply the follow gate (`assertFollowedUser`). The cloner takes a pasted
  URL; the library browses the people you follow.
- **Shape:** one "Copy from…" page: paste a link, or pick from people you
  follow.
- **Confirm with the query:** transitions between `playlist-cloner` and
  `following-library` in either direction, by users, and overlap of their
  user sets (the `reach` rows plus a one-off `COUNT(DISTINCT)` on the
  intersection). If fewer than ~10% of Following Library's users ever clone
  by URL, the two serve different moments and should stay apart.

### 5. Like Manager + Playlist → Likes (like and unlike in one place)

- **Data:** bulk-unlike 135 users; bulk-like 26.
- **Code:** both are bulk operations on the caller's likes in 100-id chunks,
  with the same `BulkReviewDetails` confirmation and progress copy.
  Playlist → Likes picks the tracks from a playlist; Like Manager lists the
  likes.
- **Shape:** Like Manager gains "Like tracks from a playlist" as a second
  source.
- **Confirm with the query:** `like-manager ↔ playlist-to-likes`
  transitions by users. Weak candidate: the two jobs (clean up vs. bulk-add)
  are opposite, and 26 users is too few to justify moving them.

### 6. Following Manager + Repost Manager + Like Manager (one "Library manager" with tabs)

- **Data:** bulk-unfollow 108, bulk-unlike 135, bulk-remove-reposts 14.
- **Code:** after this migration the three pages are the same component
  shape: progressive list (`lib/progressive.ts`), `ListSearch` with
  `pendingNote`, virtualized rows, `SelectionBanner`, 100-id chunks,
  `BulkReviewDetails`. Each has its own filters.
- **Shape:** one page, three tabs.
- **Confirm with the query:** cleanup sessions that chain two of them
  (`like-manager → following-manager` etc.) for ≥10% of the smaller tool's
  users. If they rarely chain, tabs only add a click.

### 7. Keyword Search + Playlist Modifier (editing playlists' tracks)

- **Data:** playlist-transfer (Modifier) 29 users; keyword search: newer
  than the export.
- **Code:** both rewrite playlists through `readPlaylistForRewrite` and the
  `remove` contract; Keyword Search does it across playlists, the Modifier
  within one.
- **Confirm with the query:** `playlist-keyword-search ↔ playlist-modifier`
  transitions. Weak: different scopes (many playlists vs one).

### Not candidates

- **Combine** stays its own page: 820 users, 666 first actions. Every other
  candidate should be judged by whether it helps people who start here.
- **Downloads**, **Growth** and **Set → Playlist** have no overlap in data
  or code with another tool.

---

## Order to look at them

1, 3, 2 — the three that touch the most-used tools (resolver, audit,
from-likes) and that the code already makes cheap. 4 needs the user-overlap
number. 5–7 are weak and should wait for a reason beyond tidiness.
