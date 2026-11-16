/**
 * Sort Likes — the pure half of filing one destination.
 *
 * A destination is an existing playlist or a new one. Either way the tracks
 * the user marked are split three ways: those already in the playlist (no
 * write; they still count as filed), those that fit under the 500-track cap,
 * and the rest, which go into overflow playlists named "<title> (2)",
 * "<title> (3)", … of at most 500 each. A new playlist is the same thing with
 * an empty existing list.
 */
import { MAX_PLAYLIST_TRACKS } from './playlist-transfer.js';
import { splitIntoChunks } from './merge-utils.js';

/**
 * @param {{ existingIds: number[], trackIds: number[], max?: number }} args
 * @returns {{ unique: number[], alreadyPresent: number[], intoTarget: number[], overflowChunks: number[][] }}
 */
export function planSortApply({ existingIds, trackIds, max = MAX_PLAYLIST_TRACKS }) {
  const unique = [...new Set(trackIds)];
  const existing = new Set(existingIds);
  const alreadyPresent = unique.filter((id) => existing.has(id));
  const fresh = unique.filter((id) => !existing.has(id));
  const room = Math.max(0, max - existingIds.length);
  return {
    unique,
    alreadyPresent,
    intoTarget: fresh.slice(0, room),
    overflowChunks: splitIntoChunks(fresh.slice(room), max),
  };
}

/** "Tech House" → "Tech House (2)" for the first overflow, and so on. */
export function sortOverflowTitle(baseTitle, index) {
  return `${baseTitle} (${index + 2})`;
}

/** The description a new Sort Likes playlist gets when its note is empty. */
export const SORT_DEFAULT_DESCRIPTION = 'Sorted from liked tracks';
