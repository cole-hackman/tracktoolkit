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
It ran on production on 2026-11-06: see [Results](#results-run-2026-11-06).

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

---

## Results (run 2026-11-06)

**Verdicts:** 1, 5 and 6 confirmed. 4 and 7 not supported. 2 and 3 can't tell
yet, because the runs that would decide them are not logged.

### Window and counts

| | |
|---|---|
| Window | 2026-03-19 16:25 to 2026-11-06 11:06 (UTC), under the 365-day retention limit |
| All of `operation_logs` | 47,848 rows, 3,393 users |
| Analysed, after the query's exclusions | about 18,900 rows, 3,047 users |
| Runs after chunk collapse | 13,669 |
| Sessions at 15 / 30 / 60 minutes | 5,797 / 5,450 / 5,254 |
| `view:*` rows | **0**, so page opens are still invisible |

Figures written `a/b/c` are the 15-, 30- and 60-minute runs. Single figures
are from the 30-minute run. All counts are users unless stated. No finding
below depends on the gap: every threshold gives the same answer at all three.

`from-likes` is shown as Likes → Playlist, as in the query, so that row also
holds new playlists from Activity → Playlist and Recently Played. Health
Check's fix, the add-to-existing path of those two pages, and Export log
nothing, so they cannot appear below. A transition is only the *next* run, so
A → X → B does not count as A → B.

Users of a tool, for the percentages below:

| Tool | Users | Sessions | Runs |
|---|---:|---:|---:|
| combine | 1,298 | 1,807 | 3,476 |
| likes-to-playlist | 1,175 | 1,541 | 2,148 |
| link-resolver | 341 | 371 | 719 |
| library-audit | 325 | 368 | 491 |
| like-manager | 322 | 484 | 1,044 |
| playlist-cloner | 288 | 369 | 1,002 |
| playlist-compare | 190 | 227 | 494 |
| following-manager | 184 | 806 | 996 |
| genre-search | 177 | 201 | 827 |
| playlist-to-likes | 107 | 187 | 488 |
| growth | 73 | 349 | 759 |
| following-library | 52 | 75 | 150 |
| playlist-modifier | 51 | 61 | 632 |
| batch-link-resolver | 39 | 46 | 95 |
| repost-manager | 36 | 42 | 52 |
| playlist-keyword-search | 28 | 31 | 222 |
| proxy-download | 12 | 16 | 24 |

`chat`, `downloads` and `library-sync` have one user each. `set-to-playlist`
has no rows.

### Top transitions by users

| From → to | Users 15/30/60 | Occurrences | Share of transitions out of "from" |
|---|---:|---:|---:|
| playlist-cloner → combine | 107/110/111 | 180 | 67.7% |
| likes-to-playlist → like-manager | 77/78/80 | 113 | 31.9% |
| likes-to-playlist → combine | 64/68/71 | 72 | 20.3% |
| combine → playlist-compare | 64/67/67 | 101 | 24.6% |
| combine → library-audit | 59/60/63 | 68 | 16.6% |
| combine → likes-to-playlist | 49/57/61 | 58 | 14.1% |
| playlist-compare → combine | 50/52/53 | 75 | 51.4% |
| link-resolver → playlist-cloner | 48/48/48 | 68 | 42.8% |
| combine → playlist-cloner | 41/44/46 | 74 | 18.0% |
| library-audit → combine | 41/44/46 | 47 | 27.2% |
| likes-to-playlist → library-audit | 39/40/41 | 48 | 13.6% |
| genre-search → likes-to-playlist | 28/30/30 | 40 | 40.4% |

`link-resolver → playlist-cloner` is a real page change, not a logging
artifact: `/api/resolve` is called only through `lib/resolver`, and only the
two resolver pages use that. The private extension repo was not checked.

### Repeat use per tool

"Same session" is users with 2+ runs of the tool in one session. "2+ days" is
users on at least two distinct days, which does not depend on the gap.

| Tool | Same session 15/30/60 | 2+ days | Share of the tool's users on 2+ days |
|---|---:|---:|---:|
| combine | 552/568/575 | 204 | 15.7% |
| likes-to-playlist | 214/232/245 | 161 | 13.7% |
| playlist-cloner | 129/133/133 | 41 | 14.2% |
| like-manager | 124/133/138 | 44 | 13.7% |
| link-resolver | 122/123/125 | 14 | 4.1% |
| genre-search | 71/71/71 | 16 | 9.0% |
| library-audit | 69/71/73 | 30 | 9.2% |
| playlist-to-likes | 64/69/70 | 26 | 24.3% |
| playlist-compare | 59/61/62 | 18 | 9.5% |
| following-manager | 45/46/47 | 52 | 28.3% |
| growth | 40/41/41 | 24 | 32.9% |
| playlist-modifier | 33/33/33 | 5 | 9.8% |
| following-library | 27/29/30 | 4 | 7.7% |
| playlist-keyword-search | 12/12/12 | 1 | 3.6% |
| batch-link-resolver | 8/8/8 | 2 | 5.1% |
| repost-manager | 5/6/7 | 2 | 5.6% |

Following Manager, Playlist → Likes and Growth are the tools people return
to. The resolver is the opposite: heavy in one sitting, and rarely revisited.

### Candidates

| # | Candidate | Verdict |
|---|---|---|
| 1 | Link Resolver + Batch Link Resolver | **Confirmed** |
| 2 | Likes / Activity / Recently Played → Playlist | **Can't tell yet** |
| 3 | Library Audit + Health Check | **Can't tell yet** (what is visible leans against) |
| 4 | Playlist Cloner + Following Library | **Not supported** |
| 5 | Like Manager + Playlist → Likes | **Confirmed** |
| 6 | Following + Repost + Like Manager | **Confirmed** |
| 7 | Keyword Search + Playlist Modifier | **Not supported** |

**1. Resolver: confirmed.** 63 of 341 resolver users (18.5%) ran it 3+ times
in one session at all three gaps, over the 15% bar. 19/19/19 went straight
from the single resolver to the batch one, which is 49% of the batch page's 39
users, and 12/12/13 went back, so the split does cost a page change. The log
cannot tell a new link from a retry of the same one, so 18.5% may overstate
hand-batching a little.

**2. One "make a playlist" page: can't tell yet.** The three pages share
`from-likes`, and the add-to-existing path is unlogged, so nothing here
separates them. The 1,175 users are all three pages together. This needs the
server change the candidate already describes.

**3. Playlist health: can't tell yet.** Health Check still logs no run, so the
repair half is invisible. The visible half does not help the case:
`library-audit → playlist-modifier` is 4/4/4 users (1.2% of 325), and only
9.2% of audit users came back on another day, so it does not look like a
recurring check-up. `library-audit → combine` is real at 41/44/46 (13.5%), but
that is people merging, not repairing.

**4. Copy from…: not supported.** The overlap passes the doc's floor: 15 of
Following Library's 52 users (28.8%) also cloned by URL, which is 5.2% of the
cloner's 288. But the transitions are almost nil, at 2/2/2 from cloner to
library and 1/1/1 back. Some of the same people use both, in different
sittings. If Following Library is newer than the start of this window, the
overlap is understated.

**5. Likes in one place: confirmed, and stronger than the doc expected.** The
doc had 26 users and called it weak; there are now 107.
`like-manager → playlist-to-likes` is 19/20/20 (18.7% of the smaller tool) and
`playlist-to-likes → like-manager` is 15/17/18 (15.9%, and 39.6% of transitions
out of that tool). The candidate sets no bar of its own, so this uses the 10%
bar from 2 and 6. The log does not say why they chain, so check that it is not
people undoing a mistake before building on it.

**6. Library manager: confirmed.** Every pair clears 10% of the smaller tool at
all three gaps. Like ↔ Following, either direction: 26/30/30 of 184
(14.1/16.3/16.3%). Like ↔ Repost: 7/8/8 each way of 36 (22.2%), and 62% of
transitions out of Repost Manager go to Like Manager. Following → Repost:
7/7/7 of 36 (19.4%), with none the other way. Two limits: the Like ↔ Following
figure is concentrated, since 14/16/16 users account for 38/40/41 sessions of
`following-manager → like-manager`, and Repost Manager is small.

**7. Keyword Search + Modifier: not supported.** `playlist-keyword-search →
playlist-modifier` is 0/0/0, and the reverse is one user. Keyword Search has 28
users and is newer than most of this window, so a later re-run could change
this, but nothing here supports it.

### What to build first

1. **Merge the resolvers (1).** It has the cleanest evidence of the three
   confirmed candidates: it clears its bar with no concentration caveat, and
   it is the smallest change, writing nothing and leaving the flagship tools
   alone. It should also cut rate-limit spend, since each
   hand-run resolve takes one request from the 20/hour budget it shares with
   merge and every bulk write, and a batch of 50 takes one.
2. **Add the logging next**, before any more merges: a `source` on the
   from-likes call, and an operation for the `PUT /api/playlists/:id` saves
   (Health Check and add-to-existing). It is small, and it is the only way to
   decide 2 and 3, the two candidates that touch the flagship and the audit.
3. **Then the library manager (6), with 5 folded in as a source on the Like
   Manager tab**, since both change that page. Keep it behind 1 because it is
   a far larger change, and the Like ↔ Following signal is concentrated.
4. **Drop 4 and 7** for now, and re-run the query once the logging has a few
   weeks of data.

This changes the earlier order of 1, 3, 2: 3 and 2 move behind the logging.

One finding is outside the seven. `playlist-cloner → combine` is the strongest
path in the data: 110 of 288 cloner users (38%), and 67.7% of transitions out
of the cloner. `link-resolver → playlist-cloner` feeds it. The Combine page has
no URL field, so people may be cloning someone's playlist only to be able to
merge it. Letting Combine accept a pasted playlist link could remove that step.
That reason is inferred, not measured, so talk to a user or two before building.

### How this was run

Docker `postgres:17` client, in the file's read-only transaction, on
`tracktoolkit-pg`, database `tracktoolkit`. The raw CSVs stayed outside the repo.

- The analysis query's `session_gap` line is column-aligned, so a replace
  written with a single space changes nothing and silently re-runs 30 minutes.
  Match any run of spaces, and check that the three results differ.
- `DATABASE_URL` carries Prisma's pool parameters, which `psql` rejects. Strip
  the query string and add `sslmode=require`.
- The query reports only 2+ runs in a session and one direction of a
  transition, so candidate 1's 3+ test and candidate 6's either-direction count
  came from one extra read-only SELECT over the same `runs` and `sequenced`
  rows, approved for this run. The committed query is unchanged and could
  report both.
