/**
 * Runs the real gate-results route and the real admin downloads SQL against a
 * real Postgres. The raw SQL (jsonb unnesting, FILTER, ARRAY_AGG, the JSON path
 * filter used for de-duplication) is exactly what a mocked client cannot check.
 *
 * Skipped unless TT_TEST_DATABASE_URL points at a THROWAWAY database whose
 * schema is in sync (`DATABASE_URL=… npx prisma db push`). It deletes every row
 * in operation_logs, tracks and users, so never point it at anything real.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const url = process.env.TT_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

if (url) {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'development'; // rate limiters off
  process.env.ADMIN_IDS = '1';
  process.env.DOWNLOAD_ALLOWLIST = '1,2';
}

// server/index.js does this for the real app; this test mounts the routers itself.
BigInt.prototype.toJSON = function () { return this.toString(); };

let currentUser = { id: 'u-admin', soundcloudId: 1 };
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    next();
  },
}));

maybe('admin downloads usage against a real database', () => {
  let prisma;
  let app;

  beforeAll(async () => {
    ({ default: prisma } = await import('../../server/lib/prisma.js'));
    const { default: apiRoutes } = await import('../../server/routes/api.js');
    const { default: adminRoutes } = await import('../../server/routes/admin.js');
    app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);
    app.use('/api/admin', adminRoutes);

    await prisma.operationLog.deleteMany();
    await prisma.track.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.createMany({
      data: [
        { id: 'u-admin', soundcloudId: 1, username: 'admin' },
        { id: 'u-friend', soundcloudId: 2, username: 'friend' },
      ],
    });
    await prisma.track.create({ data: { id: 101n, title: 'Alpha', artistName: 'Aaa' } });

    // Direct downloads, the way the existing routes log them.
    await prisma.operationLog.createMany({
      data: [
        { userId: 'u-admin', action: 'proxy-download', status: 'success', metadata: { trackIds: [101] } },
        { userId: 'u-admin', action: 'proxy-download', status: 'error', metadata: { trackIds: [102], reason: 'upstream_error' } },
        { userId: 'u-friend', action: 'download-links', status: 'success', metadata: { trackIds: [101, 102] } },
      ],
    });

    // Gate downloads, through the real route, as the friend.
    currentUser = { id: 'u-friend', soundcloudId: 2 };
    const body = {
      runId: 'run-1',
      results: [
        { id: 101, site: 'hypeddit', status: 'done', title: 'Alpha (gate title)', artist: 'Aaa' },
        { id: 102, site: 'droploud', status: 'done', title: 'Beta', artist: 'Bbb', actions: ['follow', 'repost'] },
        { id: 103, site: 'cobrand', status: 'failed', title: 'Gamma', reason: 'No phone number set' },
      ],
    };
    const first = await request(app).post('/api/downloads/gate-results').send(body);
    expect(first.body).toEqual({ logged: 3, duplicates: 0 });
    // The real JSON-path de-duplication, not a mock of it.
    const again = await request(app).post('/api/downloads/gate-results').send(body);
    expect(again.body).toEqual({ logged: 0, duplicates: 3 });
    currentUser = { id: 'u-admin', soundcloudId: 1 };
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const get = (path) => request(app).get(`/api/admin/downloads/${path}`);

  test('summary counts every channel, the people, and who has the extension', async () => {
    const res = await get('summary?period=all');
    expect(res.status).toBe(200);
    // ok: hypeddit 101, droploud 102, proxy 101, queue 101 + 102 = 5. failed: cobrand 103, proxy 102 = 2.
    expect(res.body.totals).toEqual({ downloads: 5, failures: 2, tracks: 2, users: 2, extensionUsers: 1 });
    const ch = Object.fromEntries(res.body.channels.map((c) => [c.channel, c]));
    expect(ch.direct).toMatchObject({ downloads: 3, failures: 1, tracks: 2, users: 2 });
    expect(ch.hypeddit).toMatchObject({ downloads: 1, failures: 0 });
    expect(ch.droploud).toMatchObject({ downloads: 1 });
    expect(ch.cobrand).toMatchObject({ downloads: 0, failures: 1 });
    const friend = res.body.users.find((u) => u.username === 'friend');
    expect(friend).toMatchObject({ direct: 2, hypeddit: 1, droploud: 1, cobrand: 0, failures: 1, usesExtension: true });
    const admin = res.body.users.find((u) => u.username === 'admin');
    expect(admin).toMatchObject({ direct: 1, failures: 1, usesExtension: false });
    const today = res.body.daily[res.body.daily.length - 1];
    expect(today).toMatchObject({ direct: 3, hypeddit: 1, droploud: 1, cobrand: 0 });
  });

  test('tracks ranks by downloads, names them from the catalog or the gate report, and filters', async () => {
    const all = await get('tracks?period=all');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    const [first, second, third] = all.body.tracks;
    expect(first).toMatchObject({ trackId: '101', title: 'Alpha', artist: 'Aaa', downloads: 3, users: 2, failures: 0 });
    expect(first.channels.sort()).toEqual(['direct', 'hypeddit']);
    expect(second).toMatchObject({ trackId: '102', title: 'Beta', downloads: 2, failures: 1 });
    expect(third).toMatchObject({ trackId: '103', downloads: 0, failures: 1 });

    const drop = await get('tracks?period=all&channel=droploud');
    expect(drop.body.tracks.map((t) => t.trackId)).toEqual(['102']);
    expect(drop.body.total).toBe(1);

    const byArtist = await get('tracks?period=all&q=bbb');
    expect(byArtist.body.tracks.map((t) => t.trackId)).toEqual(['102']);

    const byTitle = await get('tracks?period=all&q=ALPH');
    expect(byTitle.body.tracks.map((t) => t.trackId)).toEqual(['101']);
  });

  test('a hostile sort key is ignored, not interpolated', async () => {
    const res = await get('tracks?period=all&sort=constructor;DROP%20TABLE%20users');
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe('downloads');
  });

  test('csv export carries the same rows', async () => {
    const res = await get('tracks?period=all&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('trackId,title,artist,downloads,failures,users,channels,lastAt');
    expect(res.text).toMatch(/101,Alpha,Aaa,3,0,2,direct hypeddit|101,Alpha,Aaa,3,0,2,hypeddit direct/);
  });

  test('events lists each outcome with channel, via and the failure reason', async () => {
    const res = await get('events?period=all&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    const cobrand = res.body.events.find((e) => e.channel === 'cobrand');
    expect(cobrand).toMatchObject({ ok: false, via: 'extension', reason: 'No phone number set', trackId: '103', user: { username: 'friend' } });
    const click = res.body.events.find((e) => e.via === 'click' && e.trackId === '101');
    expect(click).toMatchObject({ ok: true, channel: 'direct', user: { username: 'admin' } });

    const onlyAdmin = await get('events?period=all&userId=u-admin');
    expect(onlyAdmin.body.total).toBe(2);
    const onlyGate = await get('events?period=all&channel=hypeddit');
    expect(onlyGate.body.total).toBe(1);
  });

  test('the catalog\'s per-track touches pick the gate rows up with no extra work', async () => {
    const res = await request(app).get('/api/admin/catalog/tracks?period=all&action=gate-download');
    expect(res.status).toBe(200);
    expect(res.body.tracks.map((t) => String(t.id)).sort()).toEqual(['101']); // only 101 is in the catalog table
  });
});
