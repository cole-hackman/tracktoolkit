import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Adversarial cases for the one admin CSV writer (`sendCsv` -> `csvCell` in
// server/routes/admin.js). Every admin export funnels through it, so these
// drive it through real routes with mocked Prisma rows.
const queryRaw = jest.fn();
const betaFindMany = jest.fn();
const feedbackFindMany = jest.fn();
jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    $queryRaw: queryRaw,
    $executeRaw: jest.fn(),
    betaSignup: { findMany: betaFindMany },
    feedback: { findMany: feedbackFindMany },
  },
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({
  enrichTrackIds: jest.fn(),
  piggybackEnrichment: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn().mockResolvedValue(undefined),
  getAnalyticsWriteHealth: () => ({ failures: 0 }),
}));
jest.unstable_mockModule('../../server/middleware/rateLimiter.js', () => ({
  heavyOperationRateLimiter: (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'admin-1', soundcloudId: 111 };
    next();
  },
}));
jest.unstable_mockModule('../../server/lib/logger.js', () => ({
  default: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const { default: adminRoutes } = await import('../../server/routes/admin.js');
const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const ORIGINAL_ADMIN_IDS = process.env.ADMIN_IDS;
beforeEach(() => {
  process.env.ADMIN_IDS = '111';
  queryRaw.mockReset();
  betaFindMany.mockReset().mockResolvedValue([]);
  feedbackFindMany.mockReset().mockResolvedValue([]);
});
afterAll(() => {
  if (ORIGINAL_ADMIN_IDS === undefined) delete process.env.ADMIN_IDS;
  else process.env.ADMIN_IDS = ORIGINAL_ADMIN_IDS;
});

/** Export one catalog row whose title is `title` and return the title cell's raw text. */
async function catalogTitleCell(title) {
  queryRaw.mockResolvedValueOnce([{
    id: 1n, title, artistName: 'A', artistId: 9n, genre: null, genreNormalized: null,
    durationMs: 1, access: 'playable', resolveStatus: 'resolved', permalinkUrl: 'u',
    touches: 1, users: 1, last_touched: null, firstSeenAt: null, lastSeenAt: null,
  }]);
  const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv');
  expect(res.status).toBe(200);
  const body = res.text.replace(/^﻿/, '');
  // Header is the first line; the row is everything after it. The title is the
  // second field and every case below keeps the cell's end unambiguous: it is
  // followed by `,A,9,`.
  const row = body.slice(body.indexOf('\n') + 1);
  return row.slice(row.indexOf(',') + 1, row.indexOf(',A,9,'));
}

describe('admin CSV formula guard: adversarial cells', () => {
  test.each([
    ['CR then =', '\r=1+1', '"\'\r=1+1"'],
    ['tab then =', '\t=1+1', '\'\t=1+1'],
    ['a lone -', '-', '\'-'],
    ['a lone =', '=', '\'='],
    ['+1 as a string', '+1', '\'+1'],
    ['-1 as a string', '-1', '\'-1'],
    ['@ mention', '@cole', '\'@cole'],
    ['quotes after =', '="a""b"', '"\'=""a""""b"""'],
    ['newline inside a prefixed cell', '=1+1\n=2+2', '"\'=1+1\n=2+2"'],
    ['CRLF inside a prefixed cell', '+x\r\ny', '"\'+x\r\ny"'],
    ['comma after =', '=SUM(1,2)', '"\'=SUM(1,2)"'],
  ])('%s is prefixed and correctly quoted', async (_label, title, expected) => {
    expect(await catalogTitleCell(title)).toBe(expected);
  });

  // What a spreadsheet may not show, or may trim, in front of the character
  // that makes a formula. OWASP's list names a leading line feed and the
  // full-width forms; Google Sheets trims text put into a cell, and
  // LibreOffice has a "Trim spaces" import option. The value is never changed,
  // only prefixed.
  test.each([
    ['leading space then =', ' =1+1', '\' =1+1'],
    ['several spaces then +', '   +cmd', '\'   +cmd'],
    ['no-break space then =', '\u00a0=1+1', '\'\u00a0=1+1'],
    ['ideographic space then @', '\u3000@SUM(A1)', '\'\u3000@SUM(A1)'],
    ['BOM then =', '\ufeff=1+1', '\'\ufeff=1+1'],
    ['zero-width space then =', '\u200b=1+1', '\'\u200b=1+1'],
    ['right-to-left override then =', '\u202e=1+1', '\'\u202e=1+1'],
    ['NUL then =', '\u0000=1+1', '\'\u0000=1+1'],
    ['full-width equals', '\uff1d1+1', '\'\uff1d1+1'],
    ['full-width plus', '\uff0bcmd', '\'\uff0bcmd'],
    ['full-width minus', '\uff0d2+3', '\'\uff0d2+3'],
    ['full-width at', '\uff20SUM(A1)', '\'\uff20SUM(A1)'],
    ['space then full-width equals', ' \uff1d1+1', '\' \uff1d1+1'],
    ['leading line feed', '\nplain', '"\'\nplain"'],
    ['line feed then =', '\n=1+1', '"\'\n=1+1"'],
  ])('%s is prefixed, and otherwise unchanged', async (_label, title, expected) => {
    expect(await catalogTitleCell(title)).toBe(expected);
  });

  // Ordinary titles and names: a trigger character that is not the first
  // thing a spreadsheet would see must leave the cell exactly as it was.
  test.each([
    ['= in the middle', 'a=b'],
    ['a hyphenated word', 're-edit'],
    ['an email address', 'x@y.z'],
    ['a leading space and plain text', ' plain'],
    ['a dash between words', 'Artist - Title'],
    ['full-width digits', '\uff11\uff12\uff13'],
    ['an em dash first', '\u2014 Intro'],
    ['an en dash first', '\u2013 Intro'],
    ['a minus sign (U+2212) first', '\u2212 Intro'],
    ['a full-width space and plain text', '\u3000plain'],
    ['only spaces', '   '],
    ['an apostrophe already present', '\'=1'],
    ['a hash first', '#1 hit'],
  ])('%s is left alone', async (_label, title) => {
    expect(await catalogTitleCell(title)).toBe(title);
  });

  test('a null or undefined title is an empty cell, not "null"', async () => {
    expect(await catalogTitleCell(null)).toBe('');
    expect(await catalogTitleCell(undefined)).toBe('');
  });

  test('a bigint id and a Date are emitted as before (no prefix, ISO date)', async () => {
    queryRaw.mockResolvedValueOnce([{
      id: -5n, title: 't', artistName: 'A', artistId: 9n, genre: null, genreNormalized: null,
      durationMs: -1, access: 'playable', resolveStatus: 'resolved', permalinkUrl: 'u',
      touches: 1, users: 1, last_touched: new Date('2026-11-01T00:00:00Z'),
      firstSeenAt: null, lastSeenAt: null,
    }]);
    const res = await request(app).get('/api/admin/catalog/tracks?period=7d&format=csv');
    const row = res.text.replace(/^﻿/, '').split('\n')[1];
    expect(row).toBe('-5,t,A,9,,,-1,playable,resolved,u,1,1,2026-11-01T00:00:00.000Z,,');
  });

  // An object or array whose String() opens with a formula character would get
  // through the typeof-string check. No admin CSV column carries one today
  // (the only array, downloads `channels`, is filtered to an enum and joined
  // to a string first); this pins what would happen if one were added.
  test('a non-string object is stringified unprefixed (no column carries one today)', async () => {
    expect(await catalogTitleCell(['=1+1'])).toBe('=1+1');
  });

  test('downloads channels are filtered to the enum, so a hostile channel never reaches the CSV', async () => {
    queryRaw.mockResolvedValueOnce([{
      track_id: 1n, title: 't', artist: 'a', permalink_url: null,
      downloads: 1, failures: 0, users: 1, channels: ['=evil()', 'direct'], last_at: null,
    }]);
    const res = await request(app).get('/api/admin/downloads/tracks?period=7d&format=csv');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('evil');
    expect(res.text.replace(/^﻿/, '').split('\n')[1]).toBe('1,t,a,1,0,1,direct,');
  });
});

describe('the feedback-items and beta-emails exports kept their shape', () => {
  test('feedback-items maps user.username into the username column, guarded', async () => {
    feedbackFindMany.mockResolvedValue([
      {
        id: 'fb-1', createdAt: new Date('2026-09-22T00:00:00Z'), type: 'bug', status: 'new',
        soundcloudId: 111, page: '-/combine', email: '+a@b.co', message: '@x',
        adminNote: '\tnote', user: { username: '=evil' },
      },
      {
        id: 'fb-2', createdAt: new Date('2026-09-23T00:00:00Z'), type: 'other', status: 'seen',
        soundcloudId: 222, page: null, email: null, message: 'plain, with comma', adminNote: null,
        user: null,
      },
    ]);
    const res = await request(app).get('/api/admin/feedback-items.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="feedback.csv"');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text.replace(/^﻿/, '')).toBe([
      'id,createdAt,type,status,username,soundcloudId,page,email,message,adminNote',
      "fb-1,2026-09-22T00:00:00.000Z,bug,new,'=evil,111,'-/combine,'+a@b.co,'@x,'\tnote",
      'fb-2,2026-09-23T00:00:00.000Z,other,seen,,222,,,"plain, with comma",',
    ].join('\n'));
  });

  test('beta-emails keeps its columns, order, booleans and ISO dates', async () => {
    betaFindMany.mockResolvedValue([{
      email: 'x@y.z', platform: 'mac', interest: 'very', wantsCall: true,
      rekordboxUse: 'no', createdAt: new Date('2026-09-22T00:00:00Z'),
    }]);
    const res = await request(app).get('/api/admin/feedback/beta-emails');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="beta-emails.csv"');
    expect(res.text).toBe(
      '﻿email,platform,interest,wantsCall,rekordboxUse,createdAt\n' +
      'x@y.z,mac,very,true,no,2026-09-22T00:00:00.000Z',
    );
  });
});
