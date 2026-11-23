# Staged rollout runbook

How to release a feature to 10%, then 50%, then 100% of accounts with the
flag system in `server/lib/flags.js`, what to look at between stages, when to
stop, and how to roll back.

**The halt is a manual gate.** Nothing in this repo turns a flag off by
itself. The existing per-feature error-rate monitoring is the admin
console's Overview tab, which computes its figures when an admin opens it;
there is no background job that evaluates error rates and no alert channel
for them (the uptime worker only knows whether a hostname answers). An
automatic halt would need a scheduler, a halted state that survives a
restart, and a way to tell the operator, none of which exist. What is built
instead: the console's Experiments tab computes the gate for each rollout
flag from the same numbers and prints `Under threshold`, `Too few
operations` or `Halt`. A person reads it and changes the setting.

No feature is being rolled out by this document. Candidates are at the end.

## The flag

A rollout flag is one entry in `FLAGS`:

```js
'sort-likes': {
  kind: 'rollout',
  description: 'Sort Likes for everyone',
  rolloutPercent: 0,
  guard: {
    actions: ['sort-likes-apply', 'sort-likes-unlike'],
    maxErrorRatePct: 10,   // set from the feature's own baseline, see below
    minOperations: 20,
    windowHours: 24,
  },
},
```

- The server gates with `isFlagEnabled('sort-likes', req.user)`; the page
  with `useFlag("sort-likes")` (`frontend-UI/src/lib/experiments.ts`), which
  reads the list `/api/auth/me` returns. Gate both: the page hides the
  feature, the route refuses it.
- An account is in when `sha256("<flag>:<SoundCloud id>") mod 100` is under
  the percent. The same accounts stay in as the percent rises: everyone in
  the 10% is in the 50%.
- Admins (`ADMIN_IDS`) have a rollout flag at any percent, including 0. That
  is the internal stage.
- The percent is the App Service setting `FLAG_<KEY>_PERCENT`
  (`FLAG_SORT_LIKES_PERCENT`). Saving a setting restarts the app; allow a
  minute. No deploy.

`guard.actions` are the `operation_logs` actions only this feature writes. A
feature without an action of its own cannot be gated this way: its errors
would be mixed with everyone else's. Give it one before rolling it out.

## Halt thresholds

The gate reads errors / operations for the flag's actions over the trailing
`windowHours`. It is the figure the Overview tab shows per action under
"Error rate by feature", over a shorter window.

Set `maxErrorRatePct` per flag before stage 1:

- A feature that already runs for admins or testers: twice its error rate
  over the last 30 days (Overview, period 30d), and not below 5.
- A feature with no history: twice the console's overall error rate for the
  last 30 days, and not below 5.

`minOperations` is how many operations the window must hold before the gate
says anything. Below it the gate reads `Too few operations`, which is not a
pass: wait, or stay at the stage longer.

Halt, at any stage, on any one of:

1. The gate reads `Halt`.
2. The Overview's error rate for the whole app is clearly above the week
   before the stage began, and the Operations tab shows the new errors come
   from the feature's actions or from routes it touches.
3. A feedback report (Feedback tab, type `bug`) describes data lost or
   changed wrongly by the feature. One is enough.
4. The App Service log shows the process being killed or restarting more
   than before the stage began.

## Stages

| Stage | Setting | Stay for | Move on when |
|---|---|---|---|
| 0, internal | unset (0%) | until you have used every path yourself | it works for you on the live site, at your window width and on a phone |
| 1 | `FLAG_<KEY>_PERCENT=10` | at least 3 days and `minOperations` in the window | the gate reads `Under threshold` and none of the halt conditions held |
| 2 | `FLAG_<KEY>_PERCENT=50` | at least 3 days | same |
| 3 | `FLAG_<KEY>_PERCENT=100` | 7 days | same; then remove the flag in code |

At each stage, after saving the setting:

1. Experiments tab: the flag shows the new percent with `setting` beside it,
   and no warning. A warning means the value was refused and the flag is at
   0.
2. App Service log: `[flags] <key>: rollout, rollout N% (setting)` on the
   restart.
3. Use the feature once from an account that is in the rollout.
4. The next day, and before every move: the gate, the Overview error rate,
   the Feedback tab, and the log for restarts.

## Rolling back

Set `FLAG_<KEY>_PERCENT=0` and save. Within about a minute only admins have
the feature. Nothing is deleted and no account's bucket changes, so setting
the percent again later brings back the same accounts.

To take it away from admins as well, set `FLAGS_KILL=<key>`, or
`FLAGS_KILL=all` to turn every flag off. A name `FLAGS_KILL` does not
recognise turns every flag off too; the console says so.

After a rollback, write down in `docs/internal/STATE.md` what was seen and at
which stage, before changing anything.

## Things that will catch you

- `infra/deploy.sh` replaces the App Service settings with the list in
  `infra/main.bicep`, which has none of these. An infra deploy during a
  rollout sets every flag back to its default, 0. Re-add the setting and
  check the console.
- The percent must be a whole number from 0 to 100. `10%` and `0.1` are
  refused and read as 0.
- Raising the percent is not instant for someone with the page open: the
  page reads its flags when it loads.
- A flag's key is part of the hash. Renaming it reshuffles who is in.

## Candidates

Named for Cole to choose from. None is flagged or rolled out.

1. **Sort Likes.** It is already at stage 0: admin-only, reachable by URL,
   with its own actions (`sort-likes-apply`, `sort-likes-unlike`). Opening it
   means replacing `adminAuth` on its three routes with the flag and adding
   it to `NAV`, the dashboard, `TOOL_RANKING` and the recent-tools slugs for
   accounts that have the flag. Its stream endpoint and both preview players
   have not been verified live; do that first.
2. **The download queue beyond the allowlist** (`download-links`,
   `gate-download`). Today `DOWNLOAD_ALLOWLIST` is a hand-kept list of ids. A
   rollout would replace the list with a percent. The privacy page's sentence
   about the download queue has to be settled first
   (`docs/internal/STATE.md`, Decisions, 2026-11-10).
3. **Logging `PUT /api/playlists/:id` saves.** Not user-visible, but a
   write-path change on the most guarded route in the app, and it would close
   the gap the activation experiment has for Playlist Modifier saves. A
   rollout limits who is exposed if the logging misbehaves.
