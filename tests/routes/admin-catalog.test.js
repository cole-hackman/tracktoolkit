import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// The catalog listings are raw SQL; the harness only checks the routes'
// contracts (guards, validation, CSV shape, the write's inputs), never the
// SQL itself.
const queryRaw = jest.fn();
const betaFindMany = jest.fn();
jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    $queryRaw: queryRaw,
    $executeRaw: jest.fn(),
    // Only the retired beta survey's CSV export reads a model delegate here.
    betaSignup: { findMany: betaFindMany },
  },
}));

const enrichTrackIds = jest.fn();
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({
  enrichTrackIds,
  piggybackEnrichment: jest.fn(),
}));

const logOperation = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  getAnalyticsWriteHealth: () => ({ failures: 0 }),
}));

jest.unstable_mockModule('../../server/middleware/rateLimiter.js', () => ({
  heavyOperationRateLimiter: (req, res, next) => next(),
}));

jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'admin-1', soundcloudId: 111 };
    req.accessToken = 'access';
    req.refreshToken = 'refresh';
    next();
  },
}));

const { default: adminRoutes } = await import('../../server/routes/admin.js');

const app = express();
app.use(express.json()); // mirrors prod: express.json() is the ONLY body parser
app.use('/api/admin', adminRoutes);

const ORIGINAL_ADMIN_IDS = process.env.ADMIN_IDS;
beforeEach(() => {
  process.env.ADMIN_IDS = '111';
  queryRaw.mockReset();
  betaFindMany.mockReset().mockResolvedValue([]);
  enrichTrackIds.mockReset();
  logOperation.mockClear();
});
afterAll(() => {
  if (ORIGINAL_ADMIN_IDS === undefined) delete process.env.ADMIN_IDS;
  else process.env.ADMIN_IDS = ORIGINAL_ADMIN_IDS;
});

describe('POST /catalog/re-resolve', () => {
  test('rejects an empty body and a form-encoded body with 400 before any work', async () => {
    const empty = await request(app).post('/api/admin/catalog/re-resolve').send({});
    expect(empty.status).toBe(400);

    const form = await request(app)
      .post('/api/admin/catalog/re-resolve')
      .type('form')
      .send('trackIds[]=1');
    expect(form.status).toBe(400);

    expect(enrichTrackIds).not.toHaveBeenCalled();
  });

  test('caps the list at 200 ids', async () => {
    const res = await request(app)
      .post('/api/admin/catalog/re-resolve')
      .send({ trackIds: Array.from({ length: 201 }, (_, i) => i + 1) });
    expect(res.status).toBe(400);
    expect(enrichTrackIds).not.toHaveBeenCalled();
  });

  test('forces enrichment with the admin token and logs the operation', async () => {
    enrichTrackIds.mockResolvedValue({ candidates: 2, fetched: 1, missing: 1 });
    const res = await request(app)
      .post('/api/admin/catalog/re-resolve')
      .send({ trackIds: [10, 20, 20] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: 2, candidates: 2, fetched: 1, missing: 1 });
    expect(enrichTrackIds).toHaveBeenCalledTimes(1);
    const [ids, access, refresh, opts] = enrichTrackIds.mock.calls[0];
    expect(ids).toEqual([10, 20]);
    expect(access).toBe('access');
    expect(refresh).toBe('refresh');
    expect(opts).toEqual({ force: true });

    expect(logOperation).toHaveBeenCalledTimes(1);
    expect(logOperation.mock.calls[0][0]).toMatchObject({
      action: 'admin-re-resolve',
      status: 'success',
      trackIds: [10, 20],
    });
  });

  test('a SoundCloud failure answers 502 and is logged as an error', async () => {
    enrichTrackIds.mockRejectedValue(new Error('upstream 503'));
    const res = await request(app)
      .post('/api/admin/catalog/re-resolve')
      .send({ trackIds: [10] });
    expect(res.status).toBe(502);
    expect(logOperation.mock.calls[0][0]).toMatchObject({
      action: 'admin-re-resolve',
      status: 'error',
      errorCode: 'RE_RESOLVE_FAILED',
    });
  });

  test('is closed to non-admins', async () => {
    process.env.ADMIN_IDS = '999';
    const res = await request(app)
      .post('/api/admin/catalog/re-resolve')
      .send({ trackIds: [10] });
    expect(res.status).toBe(403);
    expect(enrichTrackIds).not.toHaveBeenCalled();
  });
});

describe('catalog listings', () => {
  test('tracks?format=csv downloads the filtered rows with RFC 4180 quoting', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        id: 1n, title: 'Night, "Drive"', artistName: 'Kaito', artistId: 9n, genre: 'Deep House',
        genreNormalized: 'deep house', durationMs: 240000, access: 'playable', resolveStatus: 'resolved',
        permalinkUrl: 'https://soundcloud.com/k/n', touches: 3, users: 2,
        last_touched: new Date('2026-09-21T00:00:00Z'), firstSeenAt: null, lastSeenAt: null,
      },
    ]);
    const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv&access=blocked');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/catalog-tracks-7d\.csv/);
    const lines = res.text.replace(/^﻿/, '').split('\n');
    expect(lines[0]).toBe('id,title,artistName,artistId,genre,genreNormalized,durationMs,access,resolveStatus,permalinkUrl,touches,users,last_touched,firstSeenAt,lastSeenAt');
    expect(lines[1]).toContain('"Night, ""Drive"""');
    expect(lines[1]).toContain('2026-09-21T00:00:00.000Z');
    // CSV skips the COUNT query: one raw query only
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  test('an unknown sort key falls back instead of reaching the SQL', async () => {
    queryRaw.mockResolvedValue([]);
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    const res = await request(app).get('/api/admin/catalog/playlists?sort=constructor&order=asc');
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe('touches');
    expect(res.body.order).toBe('asc');
    expect(res.body.playlists).toEqual([]);
  });

  test('artists and daily answer the documented shapes', async () => {
    queryRaw
      .mockResolvedValueOnce([{ artist_key: '9', artistName: 'Kaito', artistId: 9, tracks: 4, touches: 12, notPlayable: 1, unresolved: 0, notPlayablePct: 25, last_touched: null }])
      .mockResolvedValueOnce([{ total: 1 }]);
    const artists = await request(app).get('/api/admin/catalog/artists?period=30d&sort=notPlayable');
    expect(artists.status).toBe(200);
    expect(artists.body.total).toBe(1);
    expect(artists.body.sort).toBe('notPlayable');
    expect(artists.body.artists[0]).toMatchObject({ artistName: 'Kaito', tracks: 4, notPlayablePct: 25 });

    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const daily = await request(app).get('/api/admin/catalog/daily?period=7d');
    expect(daily.status).toBe(200);
    expect(daily.body.daily).toHaveLength(7);
    expect(daily.body.daily[0]).toEqual({ date: expect.any(String), touches: 0, distinctTracks: 0, playlistTouches: 0 });
  });
});

// Every admin CSV goes through the one `sendCsv` writer, so every export gets
// the same formula guard the feedback inbox export always had. Catalog titles
// and gate-reported titles are written by SoundCloud uploaders and gate pages,
// not by us, and Excel / Sheets / LibreOffice execute a cell opening with
// =, +, -, @, tab or CR when an admin opens the file.
describe('CSV formula guard', () => {
  const trackRow = (overrides) => ({
    id: 1n, title: 'Plain', artistName: 'Kaito', artistId: 9n, genre: null,
    genreNormalized: null, durationMs: 240000, access: 'playable', resolveStatus: 'resolved',
    permalinkUrl: 'https://soundcloud.com/k/n', touches: 3, users: 2,
    last_touched: null, firstSeenAt: null, lastSeenAt: null,
    ...overrides,
  });

  test('a catalog title that is a formula exports as literal text', async () => {
    queryRaw.mockResolvedValueOnce([
      trackRow({ title: '=HYPERLINK("http://evil.example.com","click")' }),
    ]);
    const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv');
    expect(res.status).toBe(200);
    // Apostrophe first, then quoted because the value holds quotes and a comma.
    expect(res.text).toContain('"\'=HYPERLINK(""http://evil.example.com"",""click"")"');
    expect(res.text).not.toContain(',=HYPERLINK');
    expect(res.text).not.toContain(',"=HYPERLINK');
  });

  test('a downloads title that is a formula exports as literal text', async () => {
    queryRaw.mockResolvedValueOnce([{
      track_id: 42n, title: '+cmd', artist: '@artist', permalink_url: null,
      downloads: 1, failures: 0, users: 1, channels: ['direct'], last_at: null,
    }]);
    const res = await request(app).get('/api/admin/downloads/tracks?period=7d&format=csv');
    expect(res.status).toBe(200);
    const lines = res.text.replace(/^\ufeff/, '').split('\n');
    expect(lines[0]).toBe('trackId,title,artist,downloads,failures,users,channels,lastAt');
    expect(lines[1]).toBe("42,'+cmd,'@artist,1,0,1,direct,");
  });

  test.each([
    ['=', '=1+1'],
    ['+', '+1'],
    ['-', '-1+1'],
    ['@', '@SUM(A1)'],
    ['tab', '\t=1'],
    ['CR', '\r=1'],
  ])('a string starting with %s is prefixed', async (_label, title) => {
    queryRaw.mockResolvedValueOnce([trackRow({ title })]);
    const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv');
    expect(res.text).toContain(`'${title}`);
  });

  test('a negative number is a number, not a formula, and is left alone', async () => {
    queryRaw.mockResolvedValueOnce([trackRow({ durationMs: -1, touches: -5 })]);
    const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv');
    const row = res.text.replace(/^\ufeff/, '').split('\n')[1];
    expect(row).toContain(',-1,');
    expect(row).toContain(',-5,');
    expect(row).not.toContain("'-");
  });

  test('ordinary values are untouched', async () => {
    queryRaw.mockResolvedValueOnce([trackRow({ title: 'Night Drive' })]);
    const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv');
    expect(res.text).not.toContain("'");
    expect(res.text).toContain(',Night Drive,');
  });

  test('the beta-emails export is guarded by the same writer', async () => {
    betaFindMany.mockResolvedValueOnce([{
      email: 'a@b.co', platform: '=cmd|"/c calc"!A1', interest: 'line\rbreak',
      wantsCall: false, rekordboxUse: null, createdAt: new Date('2026-09-22T00:00:00Z'),
    }]);
    const res = await request(app).get('/api/admin/feedback/beta-emails');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/beta-emails\.csv/);
    const body = res.text.replace(/^\ufeff/, '');
    expect(body.split('\n')[0]).toBe('email,platform,interest,wantsCall,rekordboxUse,createdAt');
    expect(body).toContain('"\'=cmd|""/c calc""!A1"');
    // A lone CR stays inside its quoted field instead of splitting the row.
    expect(body).toContain('"line\rbreak"');
  });
});
