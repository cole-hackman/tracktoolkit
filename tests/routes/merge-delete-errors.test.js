import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Merge with "delete the sources afterwards" reports each delete that failed as
 * `deleteErrors: [{ id, error }]`, and the Combine page prints `error` as-is.
 * It used to be `safeError(err).message` — the raw error text. A delete runs
 * through scRequest, whose 401 path refreshes and persists tokens, so a
 * database failure there surfaces as a Prisma message naming the DB host and
 * port. The per-item text is now a fixed phrase chosen from the error class.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
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
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, deletePlaylist },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({
  piggybackEnrichment: jest.fn(),
}));
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

const TARGET = 1;
const playlists = {
  1: { id: 1, title: 'Target', track_count: 1, tracks: [{ id: 10, streamable: true }] },
  2: { id: 2, title: 'Src A', track_count: 1, tracks: [{ id: 20, streamable: true }] },
  3: { id: 3, title: 'Src B', track_count: 1, tracks: [{ id: 30, streamable: true }] },
  4: { id: 4, title: 'Src C', track_count: 1, tracks: [{ id: 40, streamable: true }] },
  5: { id: 5, title: 'Src D', track_count: 1, tracks: [{ id: 50, streamable: true }] },
};

beforeEach(() => {
  getPlaylistWithTracks.mockReset().mockImplementation(async (_a, _r, id) => playlists[id]);
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: TARGET });
  deletePlaylist.mockReset().mockImplementation(async (_a, _r, id) => {
    if (id === 2) {
      throw Object.assign(new Error("Can't reach database server at `db.internal:5432`"), { code: 'P1001' });
    }
    if (id === 3) throw Object.assign(new Error('API request failed: 404 secret detail'), { status: 404 });
    if (id === 4) throw Object.assign(new Error('API request failed: 429'), { status: 429 });
    if (id === 5) throw Object.assign(new Error('The operation was aborted.'), { code: 'SC_TIMEOUT', status: 504 });
    return {};
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('deleteErrors carry fixed text, never the raw error message', async () => {
  const res = await request(app).post('/api/playlists/merge').send({
    sourcePlaylistIds: [2, 3, 4, 5],
    targetPlaylistId: TARGET,
    deleteAfterMerge: true,
  });

  expect(res.status).toBe(200);
  expect(res.body.deleteErrors).toEqual([
    { id: 2, error: 'Delete failed' },
    { id: 3, error: 'Playlist not found on SoundCloud' },
    { id: 4, error: 'SoundCloud rate limit reached — try again later' },
    { id: 5, error: 'SoundCloud did not respond — try again later' },
  ]);
  expect(JSON.stringify(res.body)).not.toMatch(/db\.internal|5432|P1001|secret detail/);
});
