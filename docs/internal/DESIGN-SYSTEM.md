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
| link-resolver | 484 | narrow | form → output | — | — | output card below the form |
| like-manager | 500 | wide | toolbar + virtual list + bottom bar | likes | yes (progressive) | notice at top |
| playlist-cloner | 449 | narrow | two forms → output | — | — | ResultPanel at the bottom |
| genre-search | 574 | default | form → result list + bottom bar | results; target playlist (`Select` in a dialog) | form | success alert above the list |
| following-manager | 612 | wide | toolbar + virtual list + bottom bar | followings | yes (progressive) | notice at top |
| playlist-compare | 268 | wide | two `Select`s → results | playlists (native `Select` ×2) | none | inline, notice at top |
| playlist-modifier | 1239 | wide | playlist grid → editor | playlists (button grid) | tracks only | notice at top |
| playlist-to-likes | 408 | wide | playlist list → list + panel | playlists (button list), tracks | none | success screen replaces the page |
| following-library | 1092 | wide | 320px rail + detail | followings, their playlists/likes, target | followings | ResultPanel in the detail column |
| batch-link-resolver | 410 | narrow | form → result table | — | results | ResultPanel below |
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
| `form` | 896px (`max-w-4xl`) | one column: inputs, then their output | link-resolver, batch-link-resolver, playlist-cloner, set-to-playlist, export (+ sub-pages), account, feedback |
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

### 2.6 Playlist picker

`PlaylistPicker` (inline) and `PlaylistChooser` (trigger + dialog with the
same picker) in `components/playlists/`. One layout everywhere:

search box with "Showing N of M playlists" → (multi) Select all shown /
Clear → scrolling `SelectableList` (`max-h-[60dvh]`) of rows: 48px artwork,
title (truncated), "N tracks", a real checkbox (`multi`) or radio
(`single`).

- Sources (any number): inline `PlaylistPicker mode="multi"` in the main
  column.
- One playlist to work on (scan, edit, export, compare side): inline
  `PlaylistPicker mode="single"`; the tool appears beside or below it and the
  picker stays, so switching playlists is one click.
- One destination inside a narrow panel (merge target, "add to"):
  `PlaylistChooser`. A click chooses and closes; arrow keys move through the
  radio group without closing; Done/Escape close.
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

- [x] Audit, rules, shared pieces (`Panel`, `ToolLayout`, `ActionBar`,
      `ListSearch`, `useListSearch`, `ResultPanel` outcome mode,
      `PageContainer kind`, `SelectableRow type="radio"`,
      `PlaylistPicker`, `PlaylistChooser`)
- [x] combine (`a69ae43`) — also `SegmentedControl`
- [x] likes-to-playlist (`3d3c9d0`) — also `useListSelection`
- [ ] remaining pages (usage order), in parallel worktrees:
      forms (audit, link/batch resolver, cloner, set → playlist);
      managers (like, following, repost); search/scan (genre, compare,
      keyword search, health check); playlist workbenches (modifier,
      playlist → likes, activity, recently played); library/account
      (following library, export, rekordbox gaps, account, feedback);
      downloads; growth
- [x] dashboard ranking (`ed6a337`) — `TOOL_RANKING` in `lib/tool-ranking.ts`
- [x] analysis query (`6a1a1b5`), consolidation doc (`4365701`)
- Draft PR: cole-hackman/tracktoolkit#110

---

## 5. Open questions for Cole

Calls made under this brief, recorded so they can be reversed:

1. **Success screens are gone.** Combine, Likes → Playlist, Playlist → Likes
   and Growth no longer replace the page with a big check mark and "Back to
   Dashboard"; the result appears in the slot above the tool. The four
   statuses keep the colour signal.
2. **Result slot is above the tool, not next to the button.** Consistent on
   every layout and visible at the top of the page; focus moves there, so on
   a phone the page scrolls up to it after a button at the bottom.
3. **"Select all" with a search active selects the matches only**, and says
   so ("Select all 12 shown"). Without a query it is unchanged.
4. **Single lists narrowed from 1152 to 1024px** (the managers, keyword
   search, audit, compare, health check).

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
