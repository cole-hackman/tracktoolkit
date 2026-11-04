/**
 * Per-user request-scoped caches for the authenticated user's SoundCloud
 * social/library payloads. Shared by the core API routes and the growth
 * suite so whichever runs first warms the cache for the other.
 */
import { requestCache } from './request-cache.js';
import { soundcloudClient } from './soundcloud-client.js';
import logger from './logger.js';
import {
  readSnapshot,
  writeSnapshot,
  invalidateSnapshot,
  SNAPSHOT_RESOURCES,
} from './snapshot-cache.js';

export const CACHE_TTL = {
  me: 60 * 1000,
  playlists: 5 * 60 * 1000,
  followings: 5 * 60 * 1000,
  followers: 5 * 60 * 1000,
  likes: 60 * 1000,
  reposts: 60 * 1000,
  activities: 60 * 1000,
};

/**
 * In-flight loads, keyed the same way as the cache itself.
 *
 * Without this, the cache only dedupes work that has already FINISHED: two
 * requests arriving while a full-library crawl is in progress both miss, and
 * both run the crawl. That is the common case on a cold page load, where the
 * dashboard and the tool page ask for the same resource within milliseconds.
 * Same shape as inFlightRefreshes in soundcloud-client.js.
 */
const inFlightLoads = new Map();

/**
 * When each (user, resource) was last invalidated: `{ rev, at }`.
 *
 * `cancelInFlight` only reaches loads registered in `inFlightLoads`. That left
 * three ways for a crawl that started before a mutation to publish its
 * pre-mutation snapshot afterwards: the persistent write in
 * loadUserCollection's tier 3, the background revalidate (which is not in
 * `inFlightLoads` at all), and a read racing the not-yet-committed
 * `status='invalidated'` UPDATE.
 *
 * The mark closes all three WITHIN THIS PROCESS, and does it synchronously —
 * no waiting on the database. A crawl records the mark when it starts and
 * refuses to publish if the mark has moved; a reader refuses a snapshot synced
 * at or before the mark.
 *
 * It is per-process state. At `instance_count > 1` (.do/app.yaml) a second
 * instance has an empty map: a crawl there that straddles a mutation made here
 * passes its own mark check and republishes the pre-mutation items as
 * `complete`, with a `syncedAt` newer than this instance's invalidation —
 * which then defeats this instance's reader guard too. The durable tier makes
 * that worse than the old in-memory cache, because the row looks
 * authoritative. Closing it across instances needs the mark persisted (a
 * revision column on library_cache_states); until then instance_count is the
 * gate. See CLAUDE.md, Known Limitations #6.
 *
 * Two different values, because the two comparisons want different things:
 *
 *   - `rev` is a process-wide counter that strictly increases on EVERY
 *     invalidation. `Date.now()` does not: two mutations inside the same
 *     millisecond produce the same timestamp, so a crawl that started between
 *     them would compare equal to the later one and publish pre-mutation data.
 *     Equality against a counter cannot collide that way.
 *   - `at` is the wall clock, compared against `syncedAt`. BOTH sides come from
 *     this process's clock: writeSnapshot stamps `syncedAt` with `new Date()`
 *     in Node, not with a database default, and that is what makes the
 *     comparison sound. Do not move `syncedAt` to a Postgres-side now() —
 *     Node/Postgres skew of tens of milliseconds would silently break the only
 *     guard covering the uncommitted-invalidation window.
 *
 * Bounded like the sibling caches (request-cache DEFAULT_MAX_ENTRIES,
 * auth-cache MAX_ENTRIES): an uncapped map keyed by user is a leak scaled by
 * distinct users, and entries are also dropped on account deletion. The cap is
 * generous on purpose. An evicted mark reads as 0, which makes an in-flight
 * crawl refuse to publish (safe) but lets a reader serve a snapshot during the
 * milliseconds before invalidateSnapshot's UPDATE commits (not safe). Eviction
 * only bites if that many OTHER (user, resource) pairs invalidate inside that
 * window, so the number just has to be far above plausible concurrency.
 */
const MAX_INVALIDATION_MARKS = 5000;
let invalidationRev = 0;
const invalidatedAt = new Map();

const markKey = (userId, resource) => `${resource}::${userId}`;

/** Monotonic revision of the last invalidation; 0 when never invalidated.
 *  Module-private on purpose: the guard only works when the mark is taken
 *  BEFORE the crawl starts, and an exported getter invites taking it at the
 *  wrong point, which reads as correct and disables the guard. */
function invalidationMark(userId, resource) {
  return invalidatedAt.get(markKey(userId, resource))?.rev ?? 0;
}

/** Wall-clock time of the last invalidation, for comparing against a stored
 *  `syncedAt`; 0 when never invalidated. */
function invalidationTime(userId, resource) {
  return invalidatedAt.get(markKey(userId, resource))?.at ?? 0;
}

function recordInvalidation(userId, resources) {
  const at = Date.now();
  for (const resource of resources) {
    const k = markKey(userId, resource);
    // Delete-then-set moves a re-invalidated key to the end of insertion
    // order, so eviction below always drops the least recently invalidated.
    invalidatedAt.delete(k);
    invalidatedAt.set(k, { rev: ++invalidationRev, at });
  }
  while (invalidatedAt.size > MAX_INVALIDATION_MARKS) {
    invalidatedAt.delete(invalidatedAt.keys().next().value);
  }
}

/** Forget a user's invalidation marks. Called on account deletion so nothing
 *  about the user survives in process memory; see routes/auth.js. */
export function dropInvalidationMarks(userId) {
  const suffix = `::${userId}`;
  for (const k of [...invalidatedAt.keys()]) {
    if (k.endsWith(suffix)) invalidatedAt.delete(k);
  }
}

/** Number of (user, resource) marks held. For tests and diagnostics. */
export function invalidationMarkCount() {
  return invalidatedAt.size;
}

/** True when nothing has invalidated this resource since `mark` was taken. */
function stillCurrent(userId, resource, mark) {
  return invalidationMark(userId, resource) === mark;
}

/**
 * Persist a crawl, then make sure a mutation did not race the write.
 *
 * Checking the mark BEFORE the write cannot make the write atomic with
 * invalidation: `writeSnapshot` is a transaction round trip, and a mutation
 * landing during it runs `invalidateSnapshot` against the row this writer is
 * about to overwrite. The mutation marks it `invalidated`; this (older) writer
 * then upserts it back to `complete` with a FRESH `syncedAt` — which also
 * defeats the reader's `syncedAt <= invalidated` guard, because that timestamp
 * records when the row was written, not when the items were fetched.
 *
 * Re-checking afterwards and re-invalidating converges: any writer that finds
 * the mark moved leaves the row invalidated, so the next read re-crawls. The
 * failure direction is a needless crawl, never a served-stale snapshot.
 *
 * @returns {Promise<boolean>} true when the snapshot was published and is current
 */
async function publishSnapshot(userId, resource, items, mark, { truncated }) {
  const written = await writeSnapshot(userId, resource, items, { truncated });
  if (stillCurrent(userId, resource, mark)) return true;
  logger.info('[snapshot-cache] invalidated during snapshot write; re-marking', { resource });
  // Conditioned on the stamp THIS writer produced. A newer crawl may already
  // have replaced the row with correct post-mutation data; invalidating that
  // would cost a needless full re-crawl, repeatedly under mutation-heavy
  // flows. `lte` rather than equality so a truncated timestamp cannot turn
  // this into a silent no-op — that would leave the stale row `complete`,
  // which is the bug this exists to prevent. A soft-failed write returns
  // null and the invalidation falls back to unconditional.
  await invalidateSnapshot(userId, [resource], { syncedAtLte: written?.syncedAt ?? null });
  return false;
}

export function getCachedUserPayload(namespace, userId, key, load, ttlMs) {
  const cached = requestCache.get(namespace, userId, key);
  if (cached !== undefined) return Promise.resolve(cached);

  const flightKey = `${namespace}::${userId}::${key}`;
  const existing = inFlightLoads.get(flightKey);
  if (existing) return existing.promise;

  // A load that was already running when an invalidation happened is carrying
  // pre-invalidation data. It still resolves for whoever is awaiting it, but it
  // must not write that data into the cache — otherwise unliking a track and
  // then re-reading likes can resurrect it for a full TTL.
  const entry = { stale: false };
  // Invoked synchronously (not via .then) so the in-flight entry and the
  // underlying request start in the same tick — a deferred start would let a
  // caller in the same tick miss the coalescing window. The try/catch keeps a
  // synchronous throw from `load` behaving like a rejected promise.
  let started;
  try {
    started = Promise.resolve(load());
  } catch (err) {
    started = Promise.reject(err);
  }
  entry.promise = started
    .then((data) => {
      if (!entry.stale) requestCache.set(namespace, userId, key, data, ttlMs);
      return data;
    })
    .finally(() => {
      // Cleared on success AND failure, so one failed crawl does not wedge
      // every later attempt for this user.
      if (inFlightLoads.get(flightKey) === entry) inFlightLoads.delete(flightKey);
    });

  inFlightLoads.set(flightKey, entry);
  return entry.promise;
}

/**
 * An invalidation landed while these loads were running. Two things must
 * happen, and `stale` alone only did the first:
 *
 *   - the running crawl must not write its pre-mutation result into the cache
 *     when it resolves — `stale` gates that write in getCachedUserPayload;
 *   - later callers must not JOIN it. getCachedUserPayload hands any caller
 *     the in-flight promise, so leaving the entry in the map served
 *     pre-mutation data as the HTTP response to a request made AFTER the
 *     mutation. Two review passes missed that the mark only ever gated
 *     publishing, never serving.
 *
 * Deleting the entry makes the next caller start a fresh crawl, which every
 * caller after it coalesces onto — so no thundering herd, at most one extra
 * crawl. Callers already awaiting the old promise still resolve: they asked
 * before the mutation. Deleting during for..of over a Map is safe, and the old
 * entry's .finally is guarded by identity so it cannot remove the new one.
 */
function cancelInFlight(userId, namespaces) {
  const wanted = new Set(namespaces);
  for (const [flightKey, entry] of inFlightLoads) {
    const [namespace, entryUserId] = flightKey.split('::');
    if (entryUserId === String(userId) && wanted.has(namespace)) {
      entry.stale = true;
      inFlightLoads.delete(flightKey);
    }
  }
}

export function invalidateUserNamespaces(userId, namespaces) {
  // Recorded first and synchronously: everything downstream — the in-flight
  // guard, the background revalidate, and the snapshot reader — decides what
  // it may publish by comparing against this mark.
  recordInvalidation(userId, namespaces);
  cancelInFlight(userId, namespaces);
  namespaces.forEach((namespace) => {
    requestCache.invalidateNamespaceForUser(namespace, userId);
  });
}

/* Shared cached loaders for the auth user's social lists. The GET routes and
 * growth discovery use the same namespace/key/payload shape, so whichever
 * runs first warms the cache for the other. */
export function loadCachedFollowings(req) {
  return loadUserCollection(
    req,
    'followings',
    () => soundcloudClient.getFollowings(req.accessToken, req.refreshToken),
    (followings) => ({ collection: followings, total: followings.length }),
  );
}

export function loadCachedFollowers(req) {
  return loadUserCollection(
    req,
    'followers',
    () => soundcloudClient.getFollowers(req.accessToken, req.refreshToken),
    (followers) => ({ collection: followers, total: followers.length }),
  );
}

/**
 * Every playlist the user owns, fully paginated by cursor and cached across
 * both tiers.
 *
 * The paged tools (library audit, keyword search) slice this list rather than
 * asking SoundCloud for an offset page: `/me/playlists` declares only
 * `show_tracks`, `linked_partitioning` and `limit`, and the shared `offset`
 * parameter is marked deprecated — an ignored offset silently returns page one
 * while the UI claims to be showing playlists 21-40. Cursor pagination has no
 * such ambiguity, and the crawl is already cached for GET /api/playlists.
 */
export function loadCachedPlaylists(req) {
  return loadUserCollection(
    req,
    'playlists',
    () => soundcloudClient.getAllPlaylists(req.accessToken, req.refreshToken),
    (playlists) => {
      // Cover art is derived from what the list response already carries.
      // This used to fall back to getPlaylistWithTracks for every artwork-less
      // playlist, in an unbounded Promise.all — 50 simultaneous requests each
      // returning up to 500 full track objects, to read one artwork_url off
      // tracks[0]. That fan-out was the dominant cost of this endpoint and its
      // swallowed errors turned the resulting 429s into silently missing
      // covers. Clients that want a real per-playlist cover can ask for one
      // lazily; the owner avatar is a fine placeholder in a list view.
      const collection = playlists.map((p) => {
        const idNum = typeof p.id === 'string' ? parseInt(p.id, 10) : p.id;
        const coverUrl = p.artwork_url || p.user?.avatar_url || '';
        return { ...p, id: idNum, coverUrl };
      });
      return { collection, total: collection.length };
    },
  );
}

/** The authenticated user's own SoundCloud profile. Short TTL: it carries the
 * follower/like/playlist counters the dashboard renders, so it should not go
 * visibly stale, but /api/me and /api/dashboard/summary both want it on the
 * same page load and there is no reason to fetch it twice. */
export function loadCachedMe(req) {
  return getCachedUserPayload('me', req.user.id, 'default', () => (
    soundcloudClient.getMe(req.accessToken, req.refreshToken)
  ), CACHE_TTL.me);
}

/**
 * Invalidate after a playlist mutation.
 *
 * MUST clear both tiers. GET /api/playlists reads through the snapshot now, so
 * clearing only memory left a 'complete' Postgres snapshot in place for its
 * full TTL: a deleted playlist kept rendering (and 404'd when opened), and a
 * newly merged one was missing from the list that the merge itself redirects to.
 */
export function invalidatePlaylistState(userId) {
  invalidateUserCollections(userId, ['playlists']);
}

/* ── Read-through across both cache tiers ───────────────────────────────── */

/** Background refreshes in flight, so a stale-while-revalidate burst does not
 *  start one crawl per request. */
const revalidating = new Map();

function revalidateInBackground(userId, resource, crawl, shape) {
  const key = markKey(userId, resource);
  if (revalidating.has(key)) return;

  // Taken before the crawl starts: if a mutation lands while it runs, this
  // refresh is carrying pre-mutation data and must publish nothing. This path
  // is deliberately NOT in `inFlightLoads`, so cancelInFlight cannot reach it —
  // the mark is what protects it.
  const mark = invalidationMark(userId, resource);

  const done = Promise.resolve()
    .then(async () => {
      const items = await crawl();
      logLibraryLoad(resource, 'revalidate', items);
      if (!stillCurrent(userId, resource, mark)) {
        logger.info('[snapshot-cache] discarding background revalidate; invalidated mid-crawl', { resource });
        return;
      }
      const truncated = items?.truncated === true;
      // Publishes and then re-checks: writeSnapshot is a round trip, and a
      // mutation can land during it. Losing the memo write is harmless;
      // leaving a stale snapshot marked 'complete' is not.
      if (!(await publishSnapshot(userId, resource, items, mark, { truncated }))) return;
      // publishSnapshot re-checked before its promise resolved; this
      // continuation runs a microtask later, and a mutation handler can run in
      // between. Nothing would ever clear a memo written now, so check again
      // immediately before the write — the same reason the tier-3 memo write
      // is gated by getCachedUserPayload's `stale` flag.
      if (!stillCurrent(userId, resource, mark)) return;
      // Same payload shape as the other tiers — a bare shape(items) here would
      // silently drop `truncated` after any background refresh.
      requestCache.set(
        resource, userId, 'default',
        { ...shape(items), truncated },
        CACHE_TTL[resource] ?? 60_000,
      );
    })
    .catch((error) => {
      // A failed refresh is not a user-visible error: the stale snapshot they
      // were already served remains valid until the next attempt.
      logger.warn('[snapshot-cache] background revalidate failed', {
        resource, error: error?.message,
      });
    })
    .finally(() => { revalidating.delete(key); });

  revalidating.set(key, done);
}

/**
 * Diagnostic for the exit-137 kills: which load ran, how big, and what the
 * process held afterwards. Counts rather than bytes, because serializing a
 * large library to measure it would allocate the memory being investigated.
 */
function logLibraryLoad(resource, source, items) {
  const { rss, heapUsed } = process.memoryUsage();
  logger.info('[library-load]', {
    resource,
    source,
    items: items?.length ?? 0,
    rssMB: Math.round(rss / 1_048_576),
    heapMB: Math.round(heapUsed / 1_048_576),
  });
}

/**
 * Read a user collection through memory -> Postgres -> SoundCloud.
 *
 * `shape` turns the raw item array into the payload the route returns, and is
 * applied consistently at every tier so a cache hit and a cold crawl are
 * indistinguishable to the caller.
 *
 * @param {object}   req
 * @param {string}   resource  one of SNAPSHOT_RESOURCES
 * @param {Function} crawl     () => Promise<items[]>  (the SoundCloud crawl)
 * @param {Function} shape     (items) => payload
 */
export async function loadUserCollection(req, resource, crawl, shape) {
  if (!SNAPSHOT_RESOURCES.includes(resource)) {
    throw new Error(`Unknown snapshot resource: ${resource}`);
  }
  const userId = req.user.id;

  // Tier 1: in-memory.
  const memo = requestCache.get(resource, userId, 'default');
  if (memo !== undefined) return memo;

  // Tier 2: Postgres. A TTL-stale snapshot (snapshot.stale) is served
  // immediately and refreshed behind the response — an answer now beats a
  // correct answer after a 25-page crawl. An invalidated one is not served at
  // all: readSnapshot refuses any status other than 'complete'.
  const snapshot = await readSnapshot(userId, resource);
  // A snapshot synced at or before the last invalidation is pre-mutation data
  // even if its row still says 'complete': invalidateSnapshot's UPDATE is a
  // fire-and-forget round trip, and this synchronous check covers the window
  // before it commits. It fails CLOSED — a syncedAt that does not parse
  // refuses rather than serves. This is the only guard on that window, and a
  // type test that quietly evaluated to "serve" would switch it off with no
  // log and no failing test.
  const invalidated = invalidationTime(userId, resource);
  const syncedMs = snapshot ? new Date(snapshot.syncedAt).getTime() : NaN;
  const supersededByMutation = Boolean(snapshot)
    && invalidated > 0
    && !(Number.isFinite(syncedMs) && syncedMs > invalidated);

  if (snapshot) logLibraryLoad(resource, 'snapshot', snapshot.items);

  if (snapshot && !supersededByMutation) {
    const payload = {
      ...shape(snapshot.items),
      cachedAt: snapshot.syncedAt,
      stale: snapshot.stale,
      truncated: snapshot.truncated,
    };
    requestCache.set(resource, userId, 'default', payload, CACHE_TTL[resource] ?? 60_000);
    if (snapshot.stale) revalidateInBackground(userId, resource, crawl, shape);
    return payload;
  }

  // Tier 3: SoundCloud. getCachedUserPayload provides the single-flight so
  // concurrent cold readers share one crawl.
  // Taken before the crawl: getCachedUserPayload's own `stale` flag guards only
  // the in-memory write, so without this the persistent write below would
  // republish pre-mutation data — and, being durable, it would survive the
  // restart that used to clear it.
  const mark = invalidationMark(userId, resource);

  return getCachedUserPayload(resource, userId, 'default', async () => {
    const items = await crawl();
    logLibraryLoad(resource, 'crawl', items);
    // One computation for both the response and the snapshot row: the test
    // 'a truncated crawl is reported as truncated' asserts they agree.
    const truncated = items?.truncated === true;
    const payload = { ...shape(items), truncated };
    if (!stillCurrent(userId, resource, mark)) {
      logger.info('[snapshot-cache] not persisting crawl; invalidated mid-flight', { resource });
      return payload;
    }
    // Fire-and-forget, deliberately NOT awaited. Persisting a 20,000-item
    // library is ~100 INSERTs in one transaction; making the response wait on
    // that would hand the cold path a fresh delay in exchange for removing a
    // future one. The caller already has its data — the snapshot is for the
    // NEXT reader. Same posture as harvestTracks.
    Promise.resolve(publishSnapshot(userId, resource, items, mark, { truncated })).catch(() => {});
    return payload;
  }, CACHE_TTL[resource] ?? 60_000);
}

/** Invalidate BOTH tiers. Every existing invalidateUserNamespaces call site
 *  gets the persistent tier for free by routing through here. */
export function invalidateUserCollections(userId, resources) {
  invalidateUserNamespaces(userId, resources);
  // Fire-and-forget: the in-memory tier is already clear, so a slow database
  // must not hold up the mutation response.
  invalidateSnapshot(userId, resources)?.catch?.(() => {});
}

/**
 * Drop all in-process cache coordination state: in-flight loads, background
 * revalidations, and invalidation marks. For tests; `await` it in beforeEach.
 *
 * These live at module scope for the lifetime of the process, so without this
 * one test's leftover in-flight entry is handed to the next test that asks for
 * the same (user, resource) — which is exactly how the races the tiering suite
 * covers went unnoticed. Mirrors clearAuthCache in auth-cache.js.
 *
 * Clearing the maps does not cancel continuations already scheduled on the
 * promises they held — a publishSnapshot re-check, a memo write. Left alone
 * those land in the NEXT test and inflate its mock call counts. So this also
 * waits for whatever was pending to settle, bounded so a test that
 * deliberately left a gate closed cannot hang the suite. The bound is a real
 * timer: under jest fake timers advance them first, or leave nothing pending.
 */
export async function __resetCacheCoordinationForTests({ settleMs = 25 } = {}) {
  const pending = [
    ...[...inFlightLoads.values()].map((entry) => entry.promise),
    ...revalidating.values(),
  ];
  inFlightLoads.clear();
  revalidating.clear();

  if (pending.length > 0) {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, settleMs)),
    ]);
  }

  // AFTER the settle, not before, and this order is the whole point.
  //
  // Draining `pending` runs the very continuations that write a collection
  // into `requestCache`, so clearing the payload cache first would clear it
  // and then watch the previous test's data be written straight back in. A
  // suite that wiped the cache itself before calling this saw exactly that:
  // its next test was served a playlist list it never stubbed, and the
  // assertion that failed was about totals in an unrelated test one run in
  // thirty. Wiping here, once, after everything has landed, is what makes
  // "the caches are empty" true rather than merely attempted — and it is why
  // callers no longer need a `requestCache.invalidateUser` of their own.
  //
  // `invalidatedAt` is cleared last too. It is the mark that makes a
  // background revalidate discard a result taken before a mutation; clearing
  // it while such a refresh is still in flight re-authorises the stale write
  // this function exists to prevent.
  invalidatedAt.clear();
  requestCache.clear();
}
