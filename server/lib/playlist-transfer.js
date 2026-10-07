/**
 * Move or duplicate a single track between playlists using full track-list PUTs.
 * Preserves order; appends to target when adding.
 */

import logger from './logger.js';
import { sleep, SC_WRITE_PACING_MS } from './pacing.js';

export const MAX_PLAYLIST_TRACKS = 500;

export function extractOrderedTrackIds(playlist) {
  const raw = playlist?.tracks;
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => (typeof t?.id === 'number' ? t.id : parseInt(t.id, 10))).filter((id) => Number.isInteger(id) && id >= 1);
}

/**
 * A playlist whose track list came back shorter than its own track_count.
 *
 * Carries both numbers so the caller can say which playlist it refused and by
 * how much it was short.
 */
export class PlaylistReadIncompleteError extends Error {
  constructor(seen, expected) {
    super(
      `SoundCloud returned only ${seen} of the ${expected} tracks in this playlist ` +
      '(some may be deleted or private). Nothing was changed, because writing back ' +
      'a partial list would delete the missing tracks.',
    );
    this.name = 'PlaylistReadIncompleteError';
    this.seen = seen;
    this.expected = expected;
  }
}

/**
 * Read a playlist for an operation that will PUT its track list back.
 *
 * Every write in this file — and in the bulk remove/add routes — replaces the
 * playlist's ENTIRE list. extractOrderedTrackIds silently drops entries whose
 * id is unusable, and nothing compared what survived against what the playlist
 * says it holds. A 100-track playlist returning 2 unusable entries yields 98
 * ids; removing one track then PUTs 97, and the other two are deleted from the
 * user's playlist for good while the response cheerfully reports "removed: 1".
 *
 * A short read is not a recoverable condition here — there is no way to write
 * back a list we do not fully have — so this refuses rather than guessing.
 * Playlists with no track_count are left alone: the check needs a number to
 * compare against, and inventing one would refuse valid writes.
 *
 * @returns {Promise<{ playlist: object, ids: number[] }>}
 * @throws {PlaylistReadIncompleteError}
 */
export async function readPlaylistForRewrite(client, accessToken, refreshToken, playlistId) {
  // All access levels: SoundCloud's default (playable,preview) omits blocked
  // tracks while track_count still counts them, so a default read of any
  // playlist with a blocked track looked "short" and was refused outright.
  const playlist = await client.getPlaylistWithTracks(accessToken, refreshToken, playlistId, { allAccess: true });
  const ids = extractOrderedTrackIds(playlist);

  if (Number.isInteger(playlist?.track_count) && ids.length !== playlist.track_count) {
    logger.warn('[playlist-rewrite] refused short read', {
      playlistId,
      seen: ids.length,
      expected: playlist.track_count,
    });
    throw new PlaylistReadIncompleteError(ids.length, playlist.track_count);
  }

  return { playlist, ids };
}

/**
 * Grow a playlist to `ids` with a series of full-list PUTs, never writing a
 * prefix shorter than `floor`.
 *
 * SoundCloud's PUT replaces the whole list, so every intermediate write is a
 * moment where the playlist holds only that prefix. The old append loops began
 * at 100 (merge: 200) tracks regardless of what the target already held, so
 * appending 30 tracks to a 450-track playlist cut it to 100 on the first PUT,
 * and a failure on the next one (429 after retries, 5xx, timeout) left it
 * there. Appends keep existing order and add new ids at the end, so any prefix
 * at least as long as the existing list contains every existing track: pass
 * `floor = existingIds.length` and a failed later write leaves the target
 * holding all of its old tracks plus some new ones, never fewer than it began
 * with. A brand-new playlist has nothing to protect: `floor = 0`.
 *
 * Prefix lengths run max(floor, min(batchSize, n)), then +batchSize, ending
 * with exactly n. Writes are paced with SC_WRITE_PACING_MS between writes
 * only. A rejection propagates and ends the sequence.
 *
 * @param {object} args
 * @param {number[]} args.ids       The full final list.
 * @param {number} [args.floor=0]   Never write fewer than this many ids (capped at ids.length).
 * @param {number} [args.batchSize=100]
 * @param {(prefix: number[]) => Promise<unknown>} args.write
 */
export async function writeGrowingPrefix({ ids, floor = 0, batchSize = 100, write }) {
  const n = Array.isArray(ids) ? ids.length : 0;
  if (n === 0) return;
  const step = Math.max(1, Math.floor(batchSize) || 1);

  let length = Math.min(n, Math.max(Math.max(0, floor), Math.min(step, n)));
  for (;;) {
    await write(ids.slice(0, length));
    if (length >= n) return;
    await sleep(SC_WRITE_PACING_MS);
    length = Math.min(n, length + step);
  }
}

/**
 * @param {object} deps
 * @param {string} deps.accessToken
 * @param {string} deps.refreshToken
 * @param {object} deps.client - soundcloud client with getPlaylistWithTracks, addTracksToPlaylist
 * @param {number} deps.trackId
 * @param {number} deps.targetPlaylistId
 */
export async function duplicateTrackBetweenPlaylists(deps) {
  const { accessToken, refreshToken, client, trackId, targetPlaylistId } = deps;

  if (targetPlaylistId === undefined || targetPlaylistId === null) {
    return { ok: false, error: 'Target playlist is required' };
  }

  // Throws on a short read rather than appending to a truncated list, which
  // would delete whatever the read dropped. The route's catch turns it into an
  // error response.
  const { playlist: target, ids: targetIds } = await readPlaylistForRewrite(
    client, accessToken, refreshToken, targetPlaylistId,
  );

  if (targetIds.includes(trackId)) {
    return {
      ok: true,
      noop: true,
      message: 'Track is already in this playlist',
      targetPlaylistId,
      targetTitle: target.title ?? null,
    };
  }

  if (targetIds.length >= MAX_PLAYLIST_TRACKS) {
    return {
      ok: false,
      error: `Target playlist is full (${MAX_PLAYLIST_TRACKS} tracks max)`,
    };
  }

  const nextTargetIds = [...targetIds, trackId];
  await client.addTracksToPlaylist(accessToken, refreshToken, targetPlaylistId, nextTargetIds);

  return {
    ok: true,
    noop: false,
    action: 'duplicate',
    trackId,
    targetPlaylistId,
    targetTitle: target.title ?? null,
  };
}

/**
 * @param {object} deps
 * @param {number} deps.trackId
 * @param {number} deps.sourcePlaylistId
 * @param {number} deps.targetPlaylistId
 */
export async function moveTrackBetweenPlaylists(deps) {
  const { accessToken, refreshToken, client, trackId, sourcePlaylistId, targetPlaylistId } = deps;

  if (sourcePlaylistId === targetPlaylistId) {
    return { ok: false, error: 'Source and target playlist must be different' };
  }

  // Both lists are PUT back in full below, so both reads are guarded: a short
  // read of either side would delete whatever it dropped. Throws on a short
  // read; the route maps that to a 409 rather than a generic failure.
  const [
    { playlist: source, ids: sourceIds },
    { playlist: target, ids: targetIds },
  ] = await Promise.all([
    readPlaylistForRewrite(client, accessToken, refreshToken, sourcePlaylistId),
    readPlaylistForRewrite(client, accessToken, refreshToken, targetPlaylistId),
  ]);

  if (!sourceIds.includes(trackId)) {
    return {
      ok: false,
      error: 'Track is not in the source playlist (it may have changed — refresh and try again)',
    };
  }

  const targetAlreadyHas = targetIds.includes(trackId);
  let nextTargetIds = targetIds;

  if (!targetAlreadyHas) {
    if (targetIds.length >= MAX_PLAYLIST_TRACKS) {
      return {
        ok: false,
        error: `Target playlist is full (${MAX_PLAYLIST_TRACKS} tracks max)`,
      };
    }
    nextTargetIds = [...targetIds, trackId];
  }

  try {
    await client.addTracksToPlaylist(accessToken, refreshToken, targetPlaylistId, nextTargetIds);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'Failed to update target playlist',
      stage: 'target_update',
    };
  }

  const nextSourceIds = sourceIds.filter((id) => id !== trackId);

  try {
    await client.addTracksToPlaylist(accessToken, refreshToken, sourcePlaylistId, nextSourceIds);
  } catch (err) {
    return {
      ok: false,
      partial: true,
      stage: 'source_update',
      targetUpdated: true,
      trackId,
      sourcePlaylistId,
      targetPlaylistId,
      sourceTitle: source.title ?? null,
      targetTitle: target.title ?? null,
      error: err?.message || 'Failed to remove track from source playlist',
      message:
        'The track was added to the target playlist, but it could not be removed from the source playlist. Remove it manually from the source playlist or try again.',
    };
  }

  return {
    ok: true,
    noop: false,
    action: 'move',
    trackId,
    sourcePlaylistId,
    targetPlaylistId,
    sourceTitle: source.title ?? null,
    targetTitle: target.title ?? null,
  };
}
