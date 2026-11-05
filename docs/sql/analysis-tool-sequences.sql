-- ANALYSIS QUERY — NOT A MIGRATION. It changes nothing and must never be
-- applied as one. It runs inside a READ ONLY transaction that is rolled back,
-- so even a mistake in it cannot write.
--
-- Question: which tools do people use in succession, and which do they come
-- back to? Answers docs/internal/TOOL-CONSOLIDATION.md, which lists what each
-- proposed merge of two tools needs this report to show.
--
-- Source: operation_logs (Prisma model OperationLog). One row per logged
-- operation; reads and page opens are separate actions and are excluded.
--
-- Method
--   1. Rows: every action except page opens (`view:*`), read-latency probes
--      (`read:*`), `auth-login`/`auth-logout` and the admin console's
--      `admin-*`. Each action is mapped to the tool (page) that issues it;
--      actions with no single page keep their own name.
--   2. Sessions: per user, a new session starts when more than 30 minutes
--      pass since that user's previous row (`params.session_gap`).
--   3. Chunk collapse: the bulk tools log one row per ≤100-item request, so
--      one "unlike 800 tracks" is eight rows. Consecutive rows in a session
--      with the same action, from the chunked set, less than
--      `params.chunk_gap` apart, are one run. Any other row is its own run,
--      so two separate merges a minute apart stay two runs.
--   4. Report (one result set, `section` says which part a row belongs to):
--        reach        tool          — users, sessions and runs per tool (the
--                                     denominators for everything below)
--        transition   tool → next   — the next run in the same session is a
--                                     different tool; occurrences, sessions,
--                                     users, and share of all transitions out
--                                     of `tool`
--        repeat_session  tool       — sessions with 2+ runs of the tool
--        repeat_days     tool       — users who used the tool on 2+ distinct
--                                     days, and in 2+ sessions
--        summary         —          — rows read, runs after collapse,
--                                     sessions, users
--
-- Run it (Azure PostgreSQL Flexible Server, database `tracktoolkit`; a read
-- replica or a restored copy is better still):
--
--   psql "$AZURE_PROD" -v ON_ERROR_STOP=1 -f docs/sql/analysis-tool-sequences.sql
--
-- Change the window or the gaps in `params` below. Tested on PostgreSQL 16
-- against fixture rows (see TOOL-CONSOLIDATION.md, "Query"); it has not been
-- run against production.

BEGIN TRANSACTION READ ONLY;

WITH params AS (
  SELECT
    interval '30 minutes'           AS session_gap,
    interval '2 minutes'            AS chunk_gap,
    timestamptz '2000-01-01 00:00Z' AS since,
    now()                           AS until,
    ARRAY[
      'bulk-unlike', 'bulk-unfollow', 'bulk-like', 'bulk-remove-reposts',
      'download-links', 'proxy-download', 'growth-engage-start'
    ]::text[]                       AS chunked_actions
),

events AS (
  SELECT
    o."userId"     AS user_id,
    o.action,
    o."createdAt"  AS at,
    CASE o.action
      WHEN 'merge'                       THEN 'combine'
      WHEN 'from-likes'                  THEN 'likes-to-playlist'
      WHEN 'library-audit'               THEN 'library-audit'
      WHEN 'resolve'                     THEN 'link-resolver'
      WHEN 'batch-resolve'               THEN 'batch-link-resolver'
      WHEN 'bulk-unlike'                 THEN 'like-manager'
      WHEN 'bulk-unfollow'               THEN 'following-manager'
      WHEN 'bulk-like'                   THEN 'playlist-to-likes'
      WHEN 'bulk-remove-reposts'         THEN 'repost-manager'
      WHEN 'clone'                       THEN 'playlist-cloner'
      WHEN 'clone-user-likes'            THEN 'playlist-cloner'
      WHEN 'genre-search'                THEN 'genre-search'
      WHEN 'playlist-compare'            THEN 'playlist-compare'
      WHEN 'playlist-transfer'           THEN 'playlist-modifier'
      WHEN 'followed-likes-to-playlist'  THEN 'following-library'
      WHEN 'followed-playlist-clone'     THEN 'following-library'
      WHEN 'playlist-keyword-search'     THEN 'playlist-keyword-search'
      WHEN 'playlist-bulk-remove-tracks' THEN 'playlist-keyword-search'
      WHEN 'playlist-bulk-add-tracks'    THEN 'playlist-keyword-search'
      WHEN 'setlist-to-playlist'         THEN 'set-to-playlist'
      WHEN 'download-links'              THEN 'downloads'
      ELSE CASE
        WHEN o.action LIKE 'growth-%' THEN 'growth'
        -- proxy-download is issued by downloads, link-resolver, rekordbox-gaps
        -- and playlist-modifier alike, so it cannot name one page.
        ELSE o.action
      END
    END AS tool
  FROM operation_logs o, params p
  WHERE o."createdAt" >= p.since
    AND o."createdAt" <  p.until
    AND o.action NOT LIKE 'view:%'
    AND o.action NOT LIKE 'read:%'
    AND o.action NOT LIKE 'admin-%'
    AND o.action NOT IN ('auth-login', 'auth-logout')
),

ordered AS (
  SELECT
    e.*,
    lag(e.at)     OVER w AS prev_at,
    lag(e.action) OVER w AS prev_action
  FROM events e
  WINDOW w AS (PARTITION BY e.user_id ORDER BY e.at, e.action)
),

sessionized AS (
  SELECT
    o.*,
    sum(CASE WHEN o.prev_at IS NULL OR o.at - o.prev_at > p.session_gap THEN 1 ELSE 0 END)
      OVER (PARTITION BY o.user_id ORDER BY o.at, o.action) AS session_no,
    -- A row continues the previous run only if it is in the same session,
    -- repeats the same chunked action, and follows within chunk_gap.
    CASE
      WHEN o.prev_at IS NOT NULL
       AND o.at - o.prev_at <= p.session_gap
       AND o.action = o.prev_action
       AND o.action = ANY (p.chunked_actions)
       AND o.at - o.prev_at <= p.chunk_gap
      THEN 0 ELSE 1
    END AS starts_run
  FROM ordered o, params p
),

runs AS (
  SELECT
    s.user_id,
    s.user_id || ':' || s.session_no AS session_id,
    s.tool,
    s.at,
    s.at::date AS day
  FROM sessionized s
  WHERE s.starts_run = 1
),

sequenced AS (
  SELECT
    r.*,
    lead(r.tool) OVER (PARTITION BY r.session_id ORDER BY r.at, r.tool) AS next_tool
  FROM runs r
),

reach AS (
  SELECT tool,
         count(DISTINCT user_id)    AS users,
         count(DISTINCT session_id) AS sessions,
         count(*)                   AS runs
  FROM runs
  GROUP BY tool
),

transitions AS (
  SELECT tool, next_tool,
         count(*)                   AS occurrences,
         count(DISTINCT session_id) AS sessions,
         count(DISTINCT user_id)    AS users
  FROM sequenced
  WHERE next_tool IS NOT NULL AND next_tool <> tool
  GROUP BY tool, next_tool
),

repeat_session AS (
  SELECT tool,
         count(*)                AS sessions,
         count(DISTINCT user_id) AS users,
         sum(runs_in_session)    AS occurrences
  FROM (
    SELECT tool, session_id, user_id, count(*) AS runs_in_session
    FROM runs
    GROUP BY tool, session_id, user_id
    HAVING count(*) >= 2
  ) t
  GROUP BY tool
),

repeat_days AS (
  SELECT tool,
         count(*) FILTER (WHERE days >= 2)     AS users,
         count(*) FILTER (WHERE sessions >= 2) AS users_2plus_sessions,
         sum(sessions)                         AS sessions
  FROM (
    SELECT tool, user_id,
           count(DISTINCT day)        AS days,
           count(DISTINCT session_id) AS sessions
    FROM runs
    GROUP BY tool, user_id
  ) t
  GROUP BY tool
),

report AS (
  SELECT 'reach' AS section, tool, NULL::text AS next_tool,
         users, sessions, runs AS occurrences, NULL::numeric AS share
  FROM reach

  UNION ALL
  SELECT 'transition', t.tool, t.next_tool,
         t.users, t.sessions, t.occurrences,
         round(t.occurrences::numeric / sum(t.occurrences) OVER (PARTITION BY t.tool), 3)
  FROM transitions t

  UNION ALL
  SELECT 'repeat_session', tool, tool,
         users, sessions, occurrences, NULL
  FROM repeat_session

  UNION ALL
  -- users = 2+ distinct days; occurrences = users in 2+ sessions;
  -- share = users on 2+ days / all users of the tool.
  SELECT 'repeat_days', d.tool, NULL,
         d.users, d.sessions, d.users_2plus_sessions,
         round(d.users::numeric / NULLIF(r.users, 0), 3)
  FROM repeat_days d JOIN reach r USING (tool)

  UNION ALL
  SELECT 'summary', 'all tools', NULL,
         (SELECT count(DISTINCT user_id) FROM runs),
         (SELECT count(DISTINCT session_id) FROM runs),
         (SELECT count(*) FROM runs),
         round((SELECT count(*) FROM runs)::numeric / NULLIF((SELECT count(*) FROM events), 0), 3)
)

SELECT section, tool, next_tool, users, sessions, occurrences, share
FROM report
ORDER BY
  CASE section
    WHEN 'summary' THEN 0 WHEN 'reach' THEN 1 WHEN 'transition' THEN 2
    WHEN 'repeat_session' THEN 3 ELSE 4
  END,
  users DESC NULLS LAST, occurrences DESC, tool, next_tool;

-- summary row: users, sessions, occurrences = runs after collapse,
-- share = runs / rows read (how much the chunk collapse removed).

ROLLBACK;
