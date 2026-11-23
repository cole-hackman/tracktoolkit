import express from 'express';
import request from 'supertest';
import {
  validateBulkUnfollow,
  validateBulkUnlike,
  validateBulkLike,
  validateCloneFollowedPlaylists,
  validateCreateFromFollowedLikes,
  validateSortApply,
  validateSortUnlike,
  validateAdminReResolve,
  validateBulkRemovePlaylistTracks,
  validateBulkAddPlaylistTracks,
} from '../../server/middleware/validation.js';

/**
 * Fourth verification pass: the id-array fields converted to scalarIdField in
 * the last round. Each body is the shape the real sender builds (file named
 * beside it); every one must still be accepted, and the handler must receive
 * numbers. Admin re-resolve is pinned for both the shape the console sends
 * today (`trackIds.map(Number)`) and a numeric-string list, since the
 * catalog's ids are BIGINT and an older console could send them as strings.
 */

function appFor(validator) {
  const app = express();
  app.use(express.json());
  app.post('/t', ...validator, (req, res) => res.json({ body: req.body }));
  return app;
}

const post = (validator, body) => request(appFor(validator)).post('/t').send(body);

const allNumbers = (arr) => Array.isArray(arr) && arr.every((v) => typeof v === 'number');

describe('converted id arrays: legitimate senders are accepted and get numbers', () => {
  test('following-manager bulk-unfollow (Set<number> chunk of 50)', async () => {
    const userIds = Array.from({ length: 50 }, (_, i) => 100000 + i);
    const res = await post(validateBulkUnfollow, { userIds });
    expect(res.status).toBe(200);
    expect(res.body.body.userIds).toEqual(userIds);
  });

  test('like-manager / playlist-modifier bulk-unlike (numbers, batch of 100 and a single id)', async () => {
    const trackIds = Array.from({ length: 100 }, (_, i) => 2000000000 + i);
    let res = await post(validateBulkUnlike, { trackIds });
    expect(res.status).toBe(200);
    expect(allNumbers(res.body.body.trackIds)).toBe(true);
    res = await post(validateBulkUnlike, { trackIds: [123456789] });
    expect(res.status).toBe(200);
  });

  test('playlist-to-likes bulk-like', async () => {
    const res = await post(validateBulkLike, { trackIds: [1, 22, 333] });
    expect(res.status).toBe(200);
    expect(res.body.body.trackIds).toEqual([1, 22, 333]);
  });

  test('following-library clone and followed-likes (selected, existing target / all, new title)', async () => {
    let res = await post(validateCloneFollowedPlaylists, { playlistIds: [111, 222], titlePrefix: 'Copy' });
    expect(res.status).toBe(200);
    expect(res.body.body.playlistIds).toEqual([111, 222]);

    res = await post(validateCreateFromFollowedLikes, { mode: 'selected', trackIds: [5, 6], targetPlaylistId: 9 });
    expect(res.status).toBe(200);
    expect(res.body.body.trackIds).toEqual([5, 6]);
    expect(res.body.body.targetPlaylistId).toBe(9);

    res = await post(validateCreateFromFollowedLikes, { mode: 'all', title: 'Their Likes' });
    expect(res.status).toBe(200);
  });

  test('sort-likes apply and unlike (pendingForDestination / unlikeEligible return number[])', async () => {
    let res = await post(validateSortApply, { playlistId: 42, trackIds: [7, 8] });
    expect(res.status).toBe(200);
    res = await post(validateSortUnlike, { trackIds: [7, 8] });
    expect(res.status).toBe(200);
    expect(res.body.body.trackIds).toEqual([7, 8]);
  });

  test('admin HealthPanel re-resolve: numbers (today) and numeric strings (BIGINT ids) both pass as numbers', async () => {
    let res = await post(validateAdminReResolve, { trackIds: [2147483648, 99] });
    expect(res.status).toBe(200);
    expect(res.body.body.trackIds).toEqual([2147483648, 99]);
    res = await post(validateAdminReResolve, { trackIds: ['2147483648', '99'] });
    expect(res.status).toBe(200);
    expect(res.body.body.trackIds).toEqual([2147483648, 99]);
  });

  test('playlist-keyword-search bulk-remove / bulk-add with numbers', async () => {
    let res = await post(validateBulkRemovePlaylistTracks, { items: [{ playlistId: 1, trackIds: [2, 3] }] });
    expect(res.status).toBe(200);
    expect(res.body.body.items[0].trackIds).toEqual([2, 3]);
    res = await post(validateBulkAddPlaylistTracks, { targetPlaylistId: 1, trackIds: [2, 3] });
    expect(res.status).toBe(200);
  });
});

describe('converted id arrays: values no real sender produces are refused', () => {
  const cases = [
    [validateBulkUnfollow, 'userIds'],
    [validateBulkUnlike, 'trackIds'],
    [validateBulkLike, 'trackIds'],
    [validateCloneFollowedPlaylists, 'playlistIds'],
    [validateSortUnlike, 'trackIds'],
    [validateAdminReResolve, 'trackIds'],
  ];
  const bad = [
    ['urn', 'soundcloud:tracks:5'],
    ['leading zero', '05'],
    ['zero', 0],
    ['negative', -1],
    ['float', 1.5],
    ['null', null],
    ['object', { id: 5 }],
    ['bool', true],
    ['beyond safe integer', '9007199254740993'],
    ['traversal', '5/../../me'],
  ];
  for (const [validator, field] of cases) {
    for (const [label, value] of bad) {
      test(`${field} on ${validator === validateAdminReResolve ? 're-resolve' : field} refuses ${label}`, async () => {
        const res = await post(validator, { [field]: [value] });
        expect(res.status).toBe(400);
      });
    }
  }
});
