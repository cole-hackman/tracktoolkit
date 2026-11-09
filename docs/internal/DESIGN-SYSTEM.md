# Design system — tool pages

The rules every page under `frontend-UI/src/app/(app)/` follows, the audit
they came from, and the progress of the migration (branch
`feat/design-system`). This is a consolidation, not a re-theme: the HSL
tokens in `globals.css`, the type, the brand and the primary button
(dark text on `#FF5500`) are unchanged. What changes is that a page is built
from the same few pieces in the same arrangement, so 25 tools read as one
product.

The UI primitives section of `CLAUDE.md` still applies in full (`Field`,
`Dialog`, `IconButton`, `SelectableList`/`SelectableRow`, `InlineAlert`,
`PageHeader`, `useAnnounce`). This file adds the layer above them.

---

## 1. Audit (2026-11-05, `main` at `728efd8`)

Every page under `(app)` was read for layout, width, spacing, selection
lists, result display and search. Line counts are for `page.tsx`.

| Page | Lines | Width | Layout | Picks from | Search | Result display |
|---|---:|---|---|---|---|---|
| combine | 701 | wide | list + sticky panel | playlists (checkbox rows), target (dialog of buttons) | **none** | success screen **replaces the page** (h1, "Back to Dashboard" / "Merge More") |
| likes-to-playlist | 584 | wide | list + sticky panel | likes (rows), target (dialog of buttons) | **none** | success screen replaces the page |
| library-audit | 331 | wide | toolbar + results | — (scans all) | none | inline cards, notice at top |
| link-resolver | 195 | narrow | form → output card (one link) or result table (2–50) | — | results (table) | ResultPanel below; the batch resolver merged in 2026-11-10 |
| like-manager | 500 | wide | toolbar + virtual list + bottom bar | likes | yes (progressive) | notice at top |
| playlist-cloner | 449 | narrow | two forms → output | — | — | ResultPanel at the bottom |
| genre-search | 574 | default | form → result list + bottom bar | results; target playlist (`Select` in a dialog) | form | success alert above the list |
| following-manager | 612 | wide | toolbar + virtual list + bottom bar | followings | yes (progressive) | notice at top |
| playlist-compare | 268 | wide | two `Select`s → results | playlists (native `Select` ×2) | none | inline, notice at top |
| playlist-modifier | 1239 | wide | playlist grid → editor | playlists (button grid) | tracks only | notice at top |
| playlist-to-likes | 408 | wide | playlist list → list + panel | playlists (button list), tracks | none | success screen replaces the page |
| following-library | 1092 | wide | 320px rail + detail | followings, their playlists/likes, target | followings | ResultPanel in the detail column |
| growth | 1696 | wide | tabs, multi-step | seed users (grid), suggestions | seeds | "Campaign Initiated!" card replaces the step |
| repost-manager | 581 | wide | toolbar + virtual list + bottom bar | reposts | yes (progressive) | notice at top |
| downloads | 1272 | default | source grid → list (+ queue column) | playlists (button grid, own search) | playlists | inline alerts |
| export (+4 sub) | 50 | narrow | card grid → export card | playlists (`PlaylistSelectGrid`, 2-col buttons) | none | inside the export card |
| playlist-health-check | 536 | wide | playlist grid → report | playlists (button grid) | none | notice at top |
| playlist-keyword-search | 657 | wide | form → virtual list | matches; target (`Select`) | form | notice at top |
| set-to-playlist | 502 | wide (unset) | form → match review | candidates | — | ResultPanel at the bottom |
| activity-to-playlist | 441 | wide | list + sticky panel | activity tracks; target (`Select`) | yes | notice at top |
| recently-played | 390 | wide | list + sticky panel | tracks; target (`Select`) | yes | notice at top |
| rekordbox-gaps | 450 | default | form → list (+ queue column) | gaps | — | inline |
| account / feedback | 334 / 560 | narrow | stacked cards | — | — | inline |
| dashboard | 635 | default | hub | — | tools | — |

What the audit found:

1. **Six ways to pick a playlist.** Checkbox rows (combine), a dialog of
   `aria-pressed` buttons (combine/likes target), a two-column button grid
   (`PlaylistSelectGrid`, export only; health check, modifier and downloads
   each re-implement it), a one-column button list (playlist-to-likes), a
   native `<select>` (compare, keyword search, activity, recently played,
   genre search). Artwork was 28, 40, 48 or 64px; "N tracks" sat in three
   different places. Only downloads could search its playlists.
2. **Search was missing exactly where lists are longest.** Combine and
   Likes → Playlist — the two tools 69% of users start with — had no search
   over playlists or likes; neither had playlist-to-likes, health check,
   modifier's playlist grid or any target picker.
3. **Four result patterns.** (a) A success screen that replaces the page,
   drops the tool, and offers "Back to Dashboard" (combine, likes-to-playlist,
   playlist-to-likes, growth); (b) a dismissible notice above the tool
   (managers, compare, audit, health check, keyword search, activity,
   recently played); (c) a `ResultPanel` at the bottom of the page (cloner,
   set-to-playlist, following-library); (d) an alert inside a dialog or above
   a list (genre search). Focus moved to the result on (a) only; the
   announcement wording differed per page; failure, partial success and
   "nothing to do" looked the same as or different from success at random.
4. **Widths did not follow the layout.** Two-column workbenches and plain
   single lists were both `wide`; genre search (a list) was `default`;
   set-to-playlist (a form) had no width and fell back to `wide`.
5. **Spacing was per page.** Card padding `p-4`, `p-5`, `p-6`, `p-8` and
   `p-4 sm:p-6`; panel headings `text-xl font-bold`, `text-lg font-bold`,
   `text-sm font-bold`, `text-2xl`; column gaps `gap-5`, `gap-6`, `gap-8`;
   `border-2` on some cards only; section spacing by `mb-5`/`mb-6`/`mb-8`.

---

## 2. Rules

### 2.1 Page structure

Every tool page is:

```
PageContainer kind=…          ← width for the page type, 16/24px gutters
  PageHeader                  ← the single h1, description, mb-6 (24px)
  [result slot]               ← ResultPanel status=… after a run (2.5)
  page body                   ← sections 24px apart (space-y-6)
```

**Width per page type** (`PageContainer kind`, never a raw width):

| `kind` | Max width | Use for | Pages |
|---|---|---|---|
| `form` | 896px (`max-w-4xl`) | one column: inputs, then their output | link-resolver, playlist-cloner, set-to-playlist, export (+ sub-pages), account, feedback |
| `list` | 1024px (`max-w-5xl`) | one list or table with a toolbar | like-manager, following-manager, repost-manager, playlist-keyword-search, library-audit, playlist-compare, playlist-health-check, genre-search, downloads, rekordbox-gaps |
| `workbench` | 1152px (`max-w-6xl`) | a list to pick from beside a sticky action panel (`ToolLayout`) | combine, likes-to-playlist, playlist-to-likes, activity-to-playlist, recently-played, playlist-modifier, following-library, growth |
| `hub` | 1024px | grid of cards | dashboard |

Why these numbers: body text reads best at 50–75 characters a line, and WCAG
1.4.8 caps it at 80 [1]. A form's inputs, help text and result paragraphs
are body text, so `form` stops at 896px — at 14px that is ~110 characters
for a full-width input but its hint and the result text (`max-w-2xl` inside)
stay within the measure. A single list wants the title, its meta and a
right-hand control on one row without the eye travelling 1,100px from a
checkbox to its control, so `list` is 1024px. A workbench needs ~700px for
the list *and* ~350px for the panel side by side, so it alone gets 1152px —
Material's "supporting pane" canonical layout makes the same split [2].

### 2.2 Spacing scale

Tailwind's 4px steps, used as a fixed scale with one meaning per step. Space
inside a group is always smaller than space between groups (proximity [3];
Atlassian and Material use the same small/medium/large bands on an
4/8px base [4][5]; GOV.UK likewise fixes a scale and treats overrides as
the exception [6]).

| Step | px | Means | Where |
|---|---:|---|---|
| `gap-1.5` | 6 | label → control | inside `Field` |
| `gap-2` | 8 | between rows of a list | `SelectableList` |
| `gap-3` | 12 | between controls in a toolbar or action bar | toolbars, `ActionBar` |
| `space-y-4` / `mb-4` | 16 | between form groups; panel heading → body | `Panel`, forms |
| `p-4 sm:p-6` | 16 / 24 | panel padding (phone / `sm` up) | `Panel`, `ResultPanel` |
| `gap-6` / `space-y-6` | 24 | between page sections; between workbench columns; above an action bar | page body, `ToolLayout`, `ActionBar` |

Nothing else: no `p-5`, `p-8`, `gap-5`, `gap-8`, `mb-5`/`mb-8` on a tool
page's structure. (Inside a component — a stat tile, a badge — use what the
component needs.)

### 2.3 Panels and headings

A section of a page is a `Panel`: the card surface, `p-4 sm:p-6`, an optional
heading row (`h2`, `text-lg font-semibold`) with right-hand actions, and
16px to the body. No `border-2`, no `rounded-2xl`, no `text-xl font-bold`
section headings. `h3` inside a panel uses `SectionHeading`.

### 2.4 Workbench (`ToolLayout`)

List left (2/3), action panel right (1/3) from `lg`; stacked below it, list
first. The aside is sticky and `self-start`, offset by `--announcement-h`.
The action panel holds, in order: the selection summary (count, total
tracks), the settings (mode toggle, name, target), then the `ActionBar`
with the primary button full width (`layout="stretch"`).

### 2.5 Results (`ResultPanel status=…`)

One pattern for the outcome of a run:

| Status | When | Tint |
|---|---|---|
| `success` | everything asked was done | success |
| `partial` | some done; the rest listed with reasons | warning |
| `empty` | nothing needed doing (already liked, no matches) | info |
| `error` | nothing done / request failed | error |

- **Position:** the result slot, directly under `PageHeader`, above the
  tool. Never a screen that replaces the tool, never at the bottom of the
  page. The tool stays below it, with its inputs, so it can be run again.
  GOV.UK puts its notification banner at the top of the content for the
  same reason, and focuses it [7]; its error summary is placed and focused
  the same way [8].
- **Focus and announcement:** the panel takes focus when it appears and
  speaks its summary through `useAnnounce` (assertive for `error`). It has
  no live role of its own — the app's single `LiveRegion` is the one voice,
  so the text is read once.
- **Content:** title (what happened, with the count), description (the
  existing sentence), body (per-item reasons, created playlists, links),
  footer actions (Open in SoundCloud). All existing wording, counts and
  per-item reasons are kept; only their container changed.
- **Clearing:** a new run clears the previous result when it starts. A
  dismiss button is offered where the old notice had one.
- Field validation errors stay at the field (`Field error`). A failure to
  *load* a list stays where the list would be (`EmptyState` with Retry).
  Neither is a result.

"Back to Dashboard" and "Merge More"/"Create Another" go: the sidebar and
tab bar already lead to the dashboard, and the tool itself is the "do it
again" (NN/g: keep the primary action next to what it acts on [9]).

Exceptions, kept on purpose:

- **Growth's step 4.** Discover is a four-step flow; after a batch the
  "Campaign Initiated!" summary is a result panel in the slot, but steps
  1–3 are not shown beside it — "Discover Again" returns to step 1, as
  before. Growth was layout-only, and showing the steps would change the
  flow.
- **Per-row and in-dialog errors** stay where they are: a failed row
  download (Rekordbox gaps, Link Resolver's download/copy), a failed
  transfer inside the Modifier's dialog. A focused panel at the top of the
  page would pull the user away from the row, or take focus from behind an
  open modal.
- **Feedback's "Thanks — got it"** replaces the form, as before (the form is
  done; "Send another" brings it back).
- A result never mounts while a dialog is open; pages close the dialog
  first (Modifier transfer, Downloads gate send).

### 2.6 Playlist picker

`PlaylistPicker` (inline) and `PlaylistChooser` (trigger + dialog with the
same picker) in `components/playlists/`. One layout everywhere:

search box with "Showing N of M playlists" → (multi) Select all shown /
Clear → scrolling `SelectableList` (`max-h-[60dvh]`) of rows: 48px artwork,
title (truncated), "N tracks", and either a real checkbox (`multi`) or a
pressable row with a round indicator (`single`, `PlaylistChoiceRow`,
`<button aria-pressed>`).

**Single choice is a button, not a radio.** The first version used native
radios; review found that a radio group commits on every arrow key, and
choosing a playlist *loads* it — so arrowing down the list fetched each
playlist, dropped the modifier's unsaved edits and the downloads
selections, and on Playlist → Likes unmounted the picker under focus. A
button commits only on click, Enter or Space; Tab moves between rows, as
the old grids did. `e2e/design-system.spec.ts` pins it. A fixed entry above
the picker (Liked Tracks on Downloads and the Modifier) uses the same
`PlaylistChoiceRow`.

- Sources (any number): inline `PlaylistPicker mode="multi"` in the main
  column.
- One playlist to work on (scan, edit, export, compare side): inline
  `PlaylistPicker mode="single"`; the tool appears beside or below it and the
  picker stays, so switching playlists is one click.
- One destination inside a narrow panel (merge target, "add to"):
  `PlaylistChooser`. Choosing (click, Enter, Space) closes it and returns
  focus to the trigger; Done/Escape close it unchanged.
- A playlist that cannot be picked is disabled with its reason in the row
  and in its accessible name ("merge target").

### 2.7 Search

Every list a user picks from or scrolls through has a `ListSearch` above it:
playlists, likes, a playlist's tracks, followings, reposts, activity,
recently played, seeds. Filtering is `useListSearch` (`lib/list-search.ts`):
case- and accent-insensitive, every word must match, over the **whole**
collection the page holds — never only rendered or virtualized rows. Lists
that arrive page by page (`lib/progressive.ts`) pass `pendingNote` so the
count says the search has not covered everything yet. Live filtering suits a
list already in memory: results are instant, and the count tells the user
what the query did [10].

Selection and search: shift-click ranges and "Select all" act on the rows
**shown**; with a query active the button says "Select all N shown".
Selections made before a search survive it.

### 2.8 Action bars

`ActionBar`: 24px above, 12px between buttons, primary first. Under a form
the buttons align with the fields' left edge (`layout="start"`); in a
workbench panel they are full width (`layout="stretch"`). One primary
button per bar [9].

---

## 3. Migration checklist (per page)

1. `PageContainer kind=` from 2.1; drop raw `maxWidth`.
2. Body sections in `space-y-6`; sections are `Panel`s; no off-scale spacing.
3. Two-column pick-then-act pages use `ToolLayout`.
4. Every playlist choice is `PlaylistPicker` / `PlaylistChooser`.
5. Every list a user picks from or scrolls has `ListSearch` + `useListSearch`
   over the full collection.
6. Run outcomes render as `ResultPanel status=` in the slot under
   `PageHeader`; remove success screens, bottom result panels and top
   notices that reported a run. Keep every string, count and per-item reason.
   Remove now-duplicate `announce()` calls for the outcome (the panel speaks).
7. Behaviour unchanged: same API calls, same guards, same confirmations.
8. Update any e2e test that pinned the old layout in the same commit and
   say why in the message.

---

## 4. Progress

Done. Every page under `(app)` is migrated (commit subjects
`refactor(<page>): …` on `feat/design-system`), each group reviewed by a
separate reviewer, and the findings fixed (`fix(…)` commits). Full checks
at the end are in `docs/internal/STATE.md`.

| Page | Kind | Picker / search | Result slot |
|---|---|---|---|
| combine | workbench | PlaylistPicker multi + search; PlaylistChooser target | yes |
| likes-to-playlist | workbench | likes search + select shown; chooser | yes |
| library-audit | list | — (≤20 per run) | yes |
| link-resolver | form | results search (table) | errors; the table run is partial/success (the card stays content) |
| like / following / repost manager | list | ListSearch (progressive note) | yes |
| playlist-cloner | form | — | yes |
| genre-search | list | inline picker in the add dialog | yes |
| playlist-compare | list | two PlaylistChoosers | errors |
| playlist-modifier | workbench | single picker (stays as aside); track search | yes |
| playlist-to-likes | workbench | single picker; track search + select shown | yes |
| following-library | workbench (rail kept) | followings / likes / playlists search; chooser | yes |
| growth | workbench | seed, suggestion, session, action search | yes (step 4 kept) |
| downloads | list | single picker + Liked Tracks row; track search | yes |
| export (+4) | form | single picker on export/playlists | — |
| playlist-health-check | list | single picker (stays) | yes |
| playlist-keyword-search | list | chooser for copy target | yes |
| set-to-playlist | form | — | yes |
| activity-to-playlist / recently-played | workbench | track search; chooser | yes |
| rekordbox-gaps | list | track search | row errors stay on the row |
| account / feedback | form | — | — |
| dashboard | hub | tool search; order from `TOOL_RANKING` | — |

## 5. Open questions for Cole

Calls made under this brief, recorded so each can be reversed. None changes
what a tool sends to SoundCloud.

**Across the app**

1. **Success screens are gone.** Combine, Likes → Playlist and Playlist →
   Likes no longer replace the page with a big check mark and "Back to
   Dashboard" / "Merge More"; the result appears in the slot above the tool.
   Growth keeps its four-step flow (2.5).
2. **The result slot is above the tool, not next to the button.** The same
   place on every layout; focus moves there, so on a phone the page scrolls
   up to it after a button at the bottom.
3. **"Select all" with a search active selects the matches only** and says
   so ("Select all 12 shown"); selections hidden by a search are kept and
   still sent. Without a query it is unchanged. Exceptions kept for
   behaviour: the three managers keep their own select-all, and Downloads'
   "Download all" and Auto-Download "Select All" still mean the whole source.
4. **Single lists narrowed from 1152 to 1024px** (managers, keyword search,
   audit, compare, health check).
5. **Pick-one lists are buttons, not radios** (2.6). Tab moves between rows.
6. **The picker stays on screen** on Health Check, Downloads, the Modifier
   and Export Playlist: "Back to playlists" / "Back to sources" / "Change
   playlist" are gone there; switching is one click. Playlist → Likes still
   swaps the picker for the tracks ("Change playlist").
7. **Titles were added to outcome panels** ("Tracks unliked", "Couldn't
   merge playlists", "Nothing to change" …). Every old sentence is the
   description, word for word.
8. **Status mapping where the old UI had only success/error:** some done =
   `partial`; nothing done with failures = `error`; nothing to do = `empty`.
9. **Search matching is now the same everywhere** (accent-insensitive, every
   word), including the managers and the batch resolver, which used a plain
   substring before.
10. **The selection banner's destructive button** moved from raw
    `#ef4444` (3.76:1, failing AA) to the destructive tokens.

**Per page**

- *Library Audit:* no search (a run shows ≤20 playlists). Partial only when
  some playlists could not be read; finding duplicates is still `success`.
- *Playlist Cloner:* a truncated likes copy, or one with a copy gap, is now
  titled "Partly cloned" (was "Cloning Complete"). A `CLONE_PARTIAL` shows
  one partial panel (was an alert plus a result).
- *Batch Resolver* (merged into Link Resolver on 2026-11-10; the table
  is `components/resolver/ResolvedList.tsx`): the summary panel repeats the counts on the Results
  header. The 50-link limit is a field error (same text). The "Showing N of
  M" count includes the status/type filters.
- *Set → Playlist:* "no tracks found" / "more than 150" are Tracklist field
  errors. A created playlist is `partial` whenever any line was not added
  (usually ID lines), which gives it the warning tint.
- *Managers:* the "N of M" count includes the genre/duration/not-following-
  back filters; the progressive status line stays beside it while loading.
- *Playlist Modifier:* transfer errors stay in the dialog; a no-op transfer is
  `empty`; the out-of-sync save is an error titled "Playlist reloaded"; the
  success result no longer disappears after 9 s. Switching playlists drops
  unsaved edits without asking, as "Back" did.
- *Playlist → Likes:* liked tracks are unticked after a run.
- *Activity / Recently Played:* a failed feed load shows only the alert (was
  alert plus the empty card).
- *Following Library:* keeps its 320px rail (not `ToolLayout`). Playlists load
  50 at a time; a note under the picker says the search covers loaded ones
  only. The likes button reads "Select loaded"; the picker's lost its old
  two-column grid. Playlist counts of 1,000+ lose the thousands separator.
- *Downloads:* switching source is one click; arrowing does not switch.
  Focus after a gate send lands on "Queue sent to extension". Remove success
  is a visible panel (was a spoken message only). `?url=` no longer pre-fills
  the playlist search (nothing in this repo links to it; the private
  extension repo was not checked).
- *Growth:* "Campaign Initiated!" is always success-tinted, even for a
  cancelled or failed batch (its existing copy already says "successfully";
  fixing that is a wording change). A finished batch clears the "Engagement
  started" result and the "Cancelling…" notice. Switching tabs clears the
  result. On a phone the seed list comes before Scan settings.
  `/api/followings` can say `truncated`, and nothing reads it yet.
- *Rekordbox gaps:* search is within the chosen Show group.
- *Feedback:* "Thanks — got it" left as it was (2.5).
- *Export:* the sub-pages drop the header's "Back to Dashboard" on phones,
  which stacked under "Back to Export".
- *Dashboard:* tools with no usage figure (Downloads, Export, Health Check,
  Keyword Search, Set → Playlist, Activity, Recently Played) sort last in
  their group, in their previous order. Activity and Recently Played log new
  playlists as `from-likes`, so their use is inside Likes → Playlist's 717
  (TOOL-CONSOLIDATION.md).

---

## Sources

1. Baymard Institute, "Readability: The Optimal Line Length" — 50–75
   characters; cites WCAG 1.4.8's 80. https://baymard.com/blog/line-length-readability
2. Material Design 3, canonical layouts: supporting pane.
   https://m3.material.io/foundations/layout/canonical-layouts/supporting-pane
3. Nielsen Norman Group, "Proximity Principle in Visual Design".
   https://www.nngroup.com/articles/gestalt-proximity/
4. Atlassian Design System, Spacing — 8px base; 0–8px inside compact
   pieces, 12–24px between items, 32px+ for layout. https://atlassian.design/foundations/spacing
5. Material Design, spacing methods — 8dp grid, 4dp for smaller elements.
   https://material.io/design/layout/spacing-methods.html
6. GOV.UK Design System, Spacing. https://design-system.service.gov.uk/styles/spacing/
7. GOV.UK Design System, Notification banner — before the `h1`, focused
   when it reports the outcome of the user's action.
   https://design-system.service.gov.uk/components/notification-banner/
8. GOV.UK Design System, Error summary.
   https://design-system.service.gov.uk/components/error-summary/
9. Nielsen Norman Group, "Website Forms Usability: Top 10 Recommendations"
   — single column, labels above fields, one submit button below the form,
   primary actions near what they affect. https://www.nngroup.com/articles/web-form-design/
10. Nielsen Norman Group, "Applying Filters: Batch vs. Interactive" —
    interactive filtering when results update near-instantly.
    https://www.nngroup.com/articles/applying-filters/
11. WCAG 2.2, 2.5.8 Target Size (Minimum) and Apple HIG 44pt — the 44px rows
    and buttons the primitives already enforce.
    https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
