import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * "Merge & Delete" may delete a source only when every one of its tracks is in
 * the playlists the merge wrote. Anything else keeps all the sources and says
 * why in deleteErrors.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();
const deletePlaylist = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({
  harvestTracks: jest.fn(),
  harvestPlaylists: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/pacing.js', () => ({
  SC_WRITE_PACING_MS: 0,
  SC_PLAYLIST_PACING_MS: 0,
  SC_BULK_PACING_MS: 0,
  SC_READ_CONCURRENCY: 5,
  sleep: jest.fn(async () => {}),
  mapWithConcurrency: async (items, _l, fn) => Promise.all(items.map(fn)),
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, createPlaylist, deletePlaylist },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({ piggybackEnrichment: jest.fn() }));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });
afterEach(() => jest.restoreAllMocks());

const TARGET = 1;
// A stand-in for SoundCloud: PUT replaces the list, and a default read hides
// blocked tracks while track_count still counts them.
let store;
let dropOnWrite;
let failRead;

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  store = new Map([
    [TARGET, [{ id: 10 }]],
    [2, [{ id: 20 }, { id: 21 }]],
    [3, [{ id: 30 }]],
  ]);
  dropOnWrite = new Set();
  failRead = () => false;
  let nextId = 900;
  getPlaylistWithTracks.mockReset().mockImplementation(async (_a, _r, id, { allAccess = false } = {}) => {
    if (failRead(id, allAccess)) throw Object.assign(new Error('API request failed: 503'), { status: 503 });
    const tracks = store.get(id);
    return {
      id, title: `P${id}`, track_count: tracks.length,
      tracks: allAccess ? tracks : tracks.filter((t) => !t.blocked_at),
    };
  });
  const write = (id, ids) => store.set(id, ids.filter((t) => !dropOnWrite.has(t)).map((t) => ({ id: t })));
  addTracksToPlaylist.mockReset().mockImplementation(async (_a, _r, id, ids) => { write(id, ids); return { id }; });
  createPlaylist.mockReset().mockImplementation(async (_a, _r, _t, _d, ids) => {
    const id = nextId; nextId += 1; write(id, ids); return { id, permalink_url: 'x' };
  });
  deletePlaylist.mockReset().mockResolvedValue({});
});

const merge = (extra = {}) => request(app).post('/api/playlists/merge').send({
  sourcePlaylistIds: [2, 3], targetPlaylistId: TARGET, deleteAfterMerge: true, ...extra,
});

test('deletes the sources when every track is in the target', async () => {
  const res = await merge();
  expect(res.status).toBe(200);
  expect(res.body.deletedPlaylistIds).toEqual([2, 3]);
  expect(res.body.deleteErrors).toBeUndefined();
});

test('tracks that went to an overflow playlist count as copied', async () => {
  store.set(TARGET, Array.from({ length: 499 }, (_, i) => ({ id: 1000 + i })));
  const res = await merge();
  expect(res.body.overflowPlaylists).toHaveLength(1);
  expect(res.body.deletedPlaylistIds).toEqual([2, 3]);
});

test.each([
  ['a blocked track', () => store.get(2).push({ id: 22, blocked_at: '2026-01-01' })],
  ['a non-streamable track', () => store.get(2).push({ id: 22, streamable: false })],
  ['a track SoundCloud did not keep', () => dropOnWrite.add(21)],
])('keeps every source when one has %s', async (_label, arrange) => {
  arrange();
  const res = await merge();
  expect(res.status).toBe(200);
  expect(deletePlaylist).not.toHaveBeenCalled();
  expect(res.body.deletedPlaylistIds).toBeUndefined();
  expect(res.body.deleteErrors).toEqual([
    { id: 2, error: 'Kept: 1 of its tracks was not copied' },
    { id: 3, error: 'Kept: another playlist in this merge was not fully copied' },
  ]);
});

test('keeps every source when one cannot be read in full', async () => {
  failRead = (id, allAccess) => id === 3 && allAccess;
  const res = await merge();
  expect(res.status).toBe(200);
  expect(deletePlaylist).not.toHaveBeenCalled();
  expect(res.body.deleteErrors).toContainEqual({ id: 3, error: 'Kept: its full track list could not be read' });
});

test('keeps every source when the target cannot be checked', async () => {
  let targetReads = 0;
  failRead = (id) => id === TARGET && (targetReads += 1) > 1;
  const res = await merge();
  expect(res.status).toBe(200);
  expect(deletePlaylist).not.toHaveBeenCalled();
  expect(res.body.deleteErrors.map((e) => e.error)).toEqual(Array(2).fill('Kept: the merged playlist could not be checked'));
});

test('without deleteAfterMerge nothing is deleted or re-read', async () => {
  const res = await merge({ deleteAfterMerge: false });
  expect(res.status).toBe(200);
  expect(deletePlaylist).not.toHaveBeenCalled();
  expect(getPlaylistWithTracks).toHaveBeenCalledTimes(3);
});
