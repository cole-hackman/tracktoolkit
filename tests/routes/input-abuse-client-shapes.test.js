import express from 'express';
import request from 'supertest';
import {
  validateMergePlaylists,
  validatePlaylistTrackTransfer,
  validateCreateFromLikes,
  validateCreateFromFollowedLikes,
  validateGateResults,
  validateBulkUnrepost,
  validatePlaylistTrackSearch,
  validateBulkRemovePlaylistTracks,
  validateBulkAddPlaylistTracks,
  validateGrowthDiscover,
  validateGrowthEngageBatch,
  validateSetlistPlaylist,
  validateSortApply,
  validateBulkUnfollow,
  validateBulkUnlike,
  validateBulkLike,
  validateCloneFollowedPlaylists,
} from '../../server/middleware/validation.js';

/**
 * Third verification pass over fix/input-abuse-rules.
 *
 * Part 1 pins the request bodies the real clients send (frontend-UI pages and,
 * for gate-results, what GateUsageReporter forwards from the extension) so a
 * later tightening cannot 400 a legitimate request. Each body is copied from
 * the page that sends it; the file and line are named beside it.
 *
 * Part 2 covers the id fields the widening did not reach: the bulk
 * unfollow / unlike / like arrays and clone-followed `playlistIds.*` still use
 * a bare element-wise `.isInt()`, so a nested array passes and reaches
 * `/me/followings/${id}` / `/likes/tracks/${id}` as "5,6".
 */

function appFor(validator, { method = 'post', path = '/t' } = {}) {
  const app = express();
  app.use(express.json());
  app[method](path, ...validator, (req, res) => res.json({ body: req.body, query: req.query }));
  return app;
}

const post = (validator, body) => request(appFor(validator)).post('/t').send(body);

describe('legitimate client bodies are accepted, and ids arrive as numbers', () => {
  test('combine/page.tsx merge into an existing playlist', async () => {
    const res = await post(validateMergePlaylists, {
      sourcePlaylistIds: [111, 222],
      targetPlaylistId: 333,
      deleteAfterMerge: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.body.sourcePlaylistIds).toEqual([111, 222]);
    expect(res.body.body.targetPlaylistId).toBe(333);
  });

  test('combine/page.tsx merge into a new playlist (no target)', async () => {
    const res = await post(validateMergePlaylists, { sourcePlaylistIds: [111, 222], title: 'Mix' });
    expect(res.status).toBe(200);
    expect(res.body.body.targetPlaylistId).toBeUndefined();
  });

  test('playlist-modifier transfer: move with source, and liked-view duplicate without', async () => {
    const move = await post(validatePlaylistTrackTransfer, {
      action: 'move', trackId: 9, targetPlaylistId: 2, sourcePlaylistId: 1,
    });
    expect(move.status).toBe(200);
    expect(move.body.body).toMatchObject({ trackId: 9, targetPlaylistId: 2, sourcePlaylistId: 1 });

    const dup = await post(validatePlaylistTrackTransfer, {
      action: 'duplicate', trackId: 9, targetPlaylistId: 2,
    });
    expect(dup.status).toBe(200);
    expect(dup.body.body.sourcePlaylistId).toBeUndefined();
  });

  test('likes-to-playlist / following-library targetPlaylistId', async () => {
    for (const v of [validateCreateFromLikes, validateCreateFromFollowedLikes]) {
      const res = await post(v, { targetPlaylistId: 5, trackIds: [1, 2] });
      // Only the target is under test; other fields may be required by the
      // validator, so look only for a targetPlaylistId error.
      const errs = (res.body.details || res.body.errors || []);
      expect(JSON.stringify(errs)).not.toMatch(/targetPlaylistId/);
    }
  });

  test('GateUsageReporter batch (pendingGateResults output: numeric ids only)', async () => {
    const res = await post(validateGateResults, {
      runId: 'run_abc-1',
      results: [
        { id: 1234567, site: 'hypeddit', status: 'done', title: 'T', artist: 'A', actions: ['follow', 'like'] },
        { id: 7654321, site: 'droploud', status: 'failed', reason: 'timeout' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.body.results.map((r) => r.id)).toEqual([1234567, 7654321]);
  });

  test('repost-manager bulk-remove items', async () => {
    const res = await post(validateBulkUnrepost, {
      items: [{ id: 10, resourceType: 'track' }, { id: 11, resourceType: 'playlist' }],
    });
    expect(res.status).toBe(200);
  });

  test('playlist-keyword-search scoped search ?playlistId=123 and bulk-remove / bulk-add', async () => {
    const app = appFor(validatePlaylistTrackSearch, { method: 'get' });
    const scoped = await request(app).get('/t').query({ q: 'house', playlistId: '123' });
    expect(scoped.status).toBe(200);
    expect(scoped.body.query.playlistId).toBe(123);
    const unscoped = await request(app).get('/t').query({ q: 'house', limit: '20', offset: '0' });
    expect(unscoped.status).toBe(200);

    const rm = await post(validateBulkRemovePlaylistTracks, { items: [{ playlistId: 7, trackIds: [1, 2] }] });
    expect(rm.status).toBe(200);
    // page.tsx sends Number(copyTarget)
    const add = await post(validateBulkAddPlaylistTracks, { targetPlaylistId: 8, trackIds: [1] });
    expect(add.status).toBe(200);
  });

  test('growth discover (Set<number> of inspirations) and engage with likeTrackId null', async () => {
    const d = await post(validateGrowthDiscover, { inspirationUserIds: [101, 202], strategy: 'balanced' });
    expect(JSON.stringify(d.body)).not.toMatch(/inspiration user IDs/);

    const e = await post(validateGrowthEngageBatch, {
      targets: [
        { userId: 5, likeTrackId: null, targetName: 'dj', targetAvatar: 'https://i1.sndcdn.com/a.jpg', targetFollowers: 10, targetFollowings: 3 },
        { userId: 6, likeTrackId: 77, targetName: 'dj2', targetAvatar: null, targetFollowers: 0, targetFollowings: 0 },
      ],
      likeTracks: true,
      sessionLabel: 'Seed: a, b — 11/23/2026',
      inspirationIds: '101,202',
      inspirationNames: 'a,b',
    });
    expect(e.status).toBe(200);
    expect(e.body.body.targets.map((t) => [t.userId, t.likeTrackId])).toEqual([[5, null], [6, 77]]);
  });

  test('set-to-playlist and sort-likes apply (existing and new destination)', async () => {
    const s = await post(validateSetlistPlaylist, {
      title: 'Set', sourceUrl: null, tracks: [{ id: 1, label: 'A - B' }, { id: 2, label: 'C - D' }],
    });
    expect(s.status).toBe(200);

    const existing = await post(validateSortApply, { playlistId: 9, trackIds: [1, 2] });
    expect(existing.status).toBe(200);
    expect(existing.body.body.playlistId).toBe(9);
    const fresh = await post(validateSortApply, { title: 'New', trackIds: [1] });
    expect(fresh.status).toBe(200);
  });
});

describe('id arrays the widening did not reach (element-wise .isInt on a nested array)', () => {
  // `userIds.*` = [5, 6] passes `.isInt()` element-wise; runBulkDelete then
  // calls unfollowUser(..., [5, 6]) and the path becomes /me/followings/5,6.
  // The same class as items.*.id on bulk-unrepost, which this branch fixed.
  test('bulk-unfollow userIds: [[5, 6]] is refused', async () => {
    const res = await post(validateBulkUnfollow, { userIds: [[5, 6]] });
    expect(res.status).toBe(400);
  });

  test('bulk-unlike trackIds: [[5, 6]] is refused', async () => {
    const res = await post(validateBulkUnlike, { trackIds: [[5, 6]] });
    expect(res.status).toBe(400);
  });

  test('bulk-like trackIds: [[5, 6]] is refused', async () => {
    const res = await post(validateBulkLike, { trackIds: [[5, 6]] });
    expect(res.status).toBe(400);
  });

  test('clone-followed playlistIds: [[2]] is refused', async () => {
    const res = await post(validateCloneFollowedPlaylists, { playlistIds: [[2]] });
    expect(res.status).toBe(400);
  });

  test('none of them let a traversal string through (whole-string isInt)', async () => {
    for (const [v, f] of [[validateBulkUnfollow, 'userIds'], [validateBulkUnlike, 'trackIds'], [validateCloneFollowedPlaylists, 'playlistIds']]) {
      const res = await post(v, { [f]: ['2/../../me/followings/777?'] });
      expect(res.status).toBe(400);
    }
  });
});
