/** In-memory cache for /api/resolve results. Per-process; resets on restart
 * (documented limitation — single-instance deploy).
 *
 * It is keyed by URL alone and shared by every user, so whatever goes in is
 * served to anyone who asks for that URL, without SoundCloud seeing their
 * token. Only write what `isShareableResolve` allows. Entries are
 * `{ v1, v2 }`: the v1-normalized object and the v2 payload, both built from
 * the raw upstream resource at write time — v2 cannot be rebuilt from v1. */
const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 1000;
const resolveCache = new Map(); // key: sanitized URL, value: { data, expiresAt }

/**
 * Whether a raw upstream resolve result may enter the shared cache: a user
 * profile, or a track/playlist whose `sharing` is exactly 'public'. A private
 * resource only resolves for a token that can see it (its owner, or a secret
 * link), so caching it would hand it to every later caller. Anything else — a
 * missing `sharing` field, an older or wrapped shape, an unknown kind — is
 * treated as private and not cached; that costs a SoundCloud round trip, never
 * a leak. Check the RAW resource: the normalized objects carry no `sharing`.
 */
export function isShareableResolve(resource) {
  if (!resource || typeof resource !== 'object') return false;
  return resource.kind === 'user' || resource.sharing === 'public';
}

function pruneResolveCache() {
  const now = Date.now();
  for (const [key, value] of resolveCache.entries()) {
    if (!value || value.expiresAt <= now) resolveCache.delete(key);
  }
  if (resolveCache.size <= RESOLVE_CACHE_MAX_ENTRIES) return;
  const overflow = resolveCache.size - RESOLVE_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of resolveCache.keys()) {
    resolveCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function getCachedResolve(url) {
  const entry = resolveCache.get(url);
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.data;
}

export function setCachedResolve(url, data) {
  pruneResolveCache();
  resolveCache.set(url, { data, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
}

export function resolveCacheSize() { return resolveCache.size; }
export function clearResolveCache() { resolveCache.clear(); }
