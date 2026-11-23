import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);
process.env.SESSION_SECRET ||= 's'.repeat(40);
process.env.APP_URL ||= 'https://www.soundcloudtoolkit.com';

// The two ciphertext columns that must never reach the response.
const CIPHERTEXT_ACCESS = 'ENCRYPTED-ACCESS-TOKEN-CIPHERTEXT';
const CIPHERTEXT_REFRESH = 'ENCRYPTED-REFRESH-TOKEN-CIPHERTEXT';
const TOKEN_EXPIRY = new Date('2026-10-01T00:00:00.000Z');

// Every delegate returns rows so a missing scope shows up as a leak rather
// than as an empty array that happens to look correct.
const findMany = (rows) => jest.fn().mockResolvedValue(rows);

const tokenFindFirst = jest.fn();
const operationLogFindMany = findMany([{ id: 'op-1', userId: 'user-a', action: 'merge' }]);
const growthActionFindMany = findMany([{ id: 'g-1', userId: 'user-a', targetId: 10n }]);
const feedbackFindMany = findMany([{ id: 'f-1', userId: 'user-a', body: 'nice' }]);
const rebrandVoteFindMany = findMany([{ id: 'r-1', userId: 'user-a', soundcloudId: 555n }]);
const surveyResponseFindMany = findMany([{ id: 's-1', userId: 'user-a', soundcloudId: 555n }]);
const betaSignupFindMany = findMany([{ id: 'b-1', userId: 'user-a', email: 'dj@example.com' }]);
const cacheStateFindMany = findMany([{ id: 'st-1', userId: 'user-a', resource: 'likes' }]);
const cachePageFindMany = findMany([
  { resource: 'likes', pageIndex: 0, itemCount: 2, items: [{ id: 1 }, { id: 2 }] },
]);
// The four cross-branch tables the privacy policy lists as stored and keyed to
// the account. They are declared in this schema so `prisma db push` does not
// drop them, and the export has to carry them for the promise to be true.
const chatConversationFindMany = findMany([{
  id: 'c-1', userId: 'user-a', title: 'what did I like in June',
  chat_messages: [{ id: 'm-1', conversationId: 'c-1', role: 'user', content: 'hello' }],
}]);
const indexedLikeFindMany = findMany([{ id: 'il-1', userId: 'user-a', trackId: 42n }]);
const indexedPlaylistTrackFindMany =
  findMany([{ id: 'ipt-1', userId: 'user-a', playlistId: 7n, trackId: 42n }]);
const librarySnapshotFindMany = findMany([{ id: 'ls-1', userId: 'user-a', status: 'synced' }]);
const experimentExposureFindMany =
  findMany([{ id: 'ee-1', userId: 'user-a', experimentKey: 'guided-first-run', variant: 'guided' }]);

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    token: { findFirst: tokenFindFirst },
    operationLog: { findMany: operationLogFindMany },
    growthAction: { findMany: growthActionFindMany },
    feedback: { findMany: feedbackFindMany },
    rebrandVote: { findMany: rebrandVoteFindMany },
    surveyResponse: { findMany: surveyResponseFindMany },
    betaSignup: { findMany: betaSignupFindMany },
    libraryCacheState: { findMany: cacheStateFindMany },
    libraryCachePage: { findMany: cachePageFindMany },
    chat_conversations: { findMany: chatConversationFindMany },
    indexed_likes: { findMany: indexedLikeFindMany },
    indexed_playlist_tracks: { findMany: indexedPlaylistTrackFindMany },
    library_snapshots: { findMany: librarySnapshotFindMany },
    experimentExposure: { findMany: experimentExposureFindMany },
  },
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {},
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
  signOut: jest.fn(async () => true),
  // account-lifecycle.js drops the rotation memo alongside the auth memo.
  forgetRecentRotation: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/snapshot-cache.js', () => ({
  dropSnapshots: jest.fn().mockResolvedValue(undefined),
  readSnapshot: jest.fn(),
  writeSnapshot: jest.fn(),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
}));
jest.unstable_mockModule('../../server/middleware/rateLimiter.js', () => ({
  heavyOperationRateLimiter: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  // Shaped like the real middleware: req.user is the full row WITH its tokens
  // included, which is exactly why the route must pick fields rather than
  // spread it.
  authenticateUser: (req, _res, next) => {
    req.user = {
      id: 'user-a',
      soundcloudId: 555,
      username: 'dj',
      displayName: 'DJ',
      avatarUrl: 'https://cdn/a.jpg',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: new Date('2026-09-01T00:00:00.000Z'),
      disconnectedAt: null,
      tokens: [{
        id: 'tok-1',
        userId: 'user-a',
        encrypted: CIPHERTEXT_ACCESS,
        refresh: CIPHERTEXT_REFRESH,
        expiresAt: TOKEN_EXPIRY,
      }],
    };
    req.accessToken = 'PLAINTEXT-ACCESS-TOKEN';
    req.refreshToken = 'PLAINTEXT-REFRESH-TOKEN';
    next();
  },
}));

// BigInt columns (growth target ids, the vote tables' soundcloudId) would make
// JSON.stringify throw; server/index.js patches this globally in production.
BigInt.prototype.toJSON = function () { return Number(this); };

const { default: authRoutes } = await import('../../server/routes/auth.js');

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authRoutes);

// Keyed by the Prisma delegate name, because the completeness test below
// derives exactly those names from prisma/schema.prisma.
const allQueries = [
  ['operationLog', operationLogFindMany],
  ['growthAction', growthActionFindMany],
  ['feedback', feedbackFindMany],
  ['rebrandVote', rebrandVoteFindMany],
  ['surveyResponse', surveyResponseFindMany],
  ['betaSignup', betaSignupFindMany],
  ['libraryCacheState', cacheStateFindMany],
  ['libraryCachePage', cachePageFindMany],
  ['chat_conversations', chatConversationFindMany],
  ['indexed_likes', indexedLikeFindMany],
  ['indexed_playlist_tracks', indexedPlaylistTrackFindMany],
  ['library_snapshots', librarySnapshotFindMany],
  ['experimentExposure', experimentExposureFindMany],
];

/**
 * Models that relate to User but are deliberately NOT a `findMany` section of
 * their own, each with the reason. Anything else the schema turns up has to be
 * queried, or this suite fails.
 */
const EXPORT_EXCEPTIONS = {
  // Exported as `token`, via findFirst and selecting expiresAt only: the two
  // ciphertext columns are live credentials and never leave Postgres.
  Token: 'exported as `token`, expiry only — see the token-secrets tests',
};

beforeEach(() => {
  tokenFindFirst.mockClear().mockResolvedValue({ expiresAt: TOKEN_EXPIRY });
  for (const [, mock] of allQueries) mock.mockClear();
});

describe('GET /api/auth/export — completeness, derived from the schema', () => {
  // The policy and the account page both say the file contains everything
  // keyed to the account. The deletion side has had a schema-driven test since
  // it was written (tests/account-deletion-cascade.test.js); the export had
  // none, and had silently drifted four tables behind the schema. This reads
  // the same source of truth so the same drift cannot happen again.
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'schema.prisma'
  );
  const schema = readFileSync(schemaPath, 'utf8');

  // Scope, stated so nobody assumes more than it checks: this recognises the
  // one relation spelling today's schema uses, `@relation(fields: [userId]`.
  // A per-user table whose foreign key is named something else, or that is
  // reached only through a join table, is invisible to it — and to
  // tests/account-deletion-cascade.test.js, which parses the same way. If a
  // future model breaks that convention, both files need widening together.
  function perUserModels(source) {
    const names = [];
    const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      if (m[1] !== 'User' && /@relation\(fields:\s*\[userId\]/.test(m[2])) names.push(m[1]);
    }
    return names;
  }

  // Prisma lowercases the first letter of a model name to make the delegate;
  // a name that is already snake_case comes through unchanged.
  const delegateFor = (model) => model[0].toLowerCase() + model.slice(1);

  const models = perUserModels(schema);

  test('the schema actually parsed', () => {
    expect(models.length).toBeGreaterThan(8);
  });

  test('every per-user table is either exported or an explicit exception', async () => {
    await request(app).get('/api/auth/export');

    const queried = new Map(allQueries);
    const missing = [];
    for (const model of models) {
      if (EXPORT_EXCEPTIONS[model]) continue;
      const mock = queried.get(delegateFor(model));
      if (!mock || mock.mock.calls.length === 0) missing.push(model);
    }

    // Named, so a failure says which table the export would have dropped.
    expect(missing).toEqual([]);
  });

  test('chat_messages travels with its conversation', async () => {
    // It is the one per-user table with no userId of its own: it hangs off
    // chat_conversations, which is also how the deletion cascade reaches it.
    expect(schema).toMatch(/model\s+chat_messages\s*\{/);
    await request(app).get('/api/auth/export');
    expect(chatConversationFindMany.mock.calls[0][0].include)
      .toEqual({ chat_messages: true });
  });

  test('an absent delegate degrades to an empty array, not a 500', async () => {
    // A model can belong to a branch that has not landed in this checkout.
    // Asking Prisma for it would throw and cost the caller the whole export.
    jest.resetModules();
    jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
      default: {
        token: { findFirst: jest.fn().mockResolvedValue(null) },
        operationLog: { findMany: jest.fn().mockResolvedValue([]) },
        growthAction: { findMany: jest.fn().mockResolvedValue([]) },
        rebrandVote: { findMany: jest.fn().mockResolvedValue([]) },
        surveyResponse: { findMany: jest.fn().mockResolvedValue([]) },
        betaSignup: { findMany: jest.fn().mockResolvedValue([]) },
        libraryCacheState: { findMany: jest.fn().mockResolvedValue([]) },
        libraryCachePage: { findMany: jest.fn().mockResolvedValue([]) },
        // feedback, chat_conversations, indexed_* and library_snapshots absent
      },
    }));
    const { default: bareRoutes } = await import('../../server/routes/auth.js');
    const bareApp = express();
    bareApp.use(cookieParser());
    bareApp.use(express.json());
    bareApp.use('/api/auth', bareRoutes);

    const res = await request(bareApp).get('/api/auth/export');
    expect(res.status).toBe(200);
    expect(res.body.feedback).toEqual([]);
    expect(res.body.chatConversations).toEqual([]);
    expect(res.body.indexedLikes).toEqual([]);
    expect(res.body.indexedPlaylistTracks).toEqual([]);
    expect(res.body.librarySnapshots).toEqual([]);
  });
});

describe('GET /api/auth/export — scoping', () => {
  test('every query is scoped to the session user', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(res.status).toBe(200);

    for (const [name, mock] of allQueries) {
      expect(mock).toHaveBeenCalledTimes(1);
      const { where } = mock.mock.calls[0][0];
      // Named in the assertion so a failure says which table lost its scope.
      expect({ [name]: where }).toEqual({ [name]: expect.objectContaining({ userId: 'user-a' }) });
    }

    expect(tokenFindFirst.mock.calls[0][0].where).toEqual({ userId: 'user-a' });
  });

  test('takes no user identifier from the request', async () => {
    // A query string must not be able to redirect the export at someone else.
    await request(app).get('/api/auth/export?userId=user-b&id=user-b');

    for (const [, mock] of allQueries) {
      expect(mock.mock.calls[0][0].where.userId).toBe('user-a');
    }
  });
});

describe('GET /api/auth/export — token secrets', () => {
  test('the token ciphertext never appears anywhere in the payload', async () => {
    const res = await request(app).get('/api/auth/export');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(CIPHERTEXT_ACCESS);
    expect(serialized).not.toContain(CIPHERTEXT_REFRESH);
    expect(serialized).not.toContain('PLAINTEXT-ACCESS-TOKEN');
    expect(serialized).not.toContain('PLAINTEXT-REFRESH-TOKEN');
    expect(serialized).not.toMatch(/"encrypted"|"refresh"/);
  });

  test('the token block is expiry and nothing else', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(Object.keys(res.body.token)).toEqual(['expiresAt']);
    expect(res.body.token.expiresAt).toBe(TOKEN_EXPIRY.toISOString());
  });

  test('the token query asks the database for expiry only', async () => {
    await request(app).get('/api/auth/export');
    // Defence in depth: the ciphertext never even leaves Postgres.
    expect(tokenFindFirst.mock.calls[0][0].select).toEqual({ expiresAt: true });
  });

  test('a disconnected user with no token row exports token: null', async () => {
    tokenFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/auth/export');
    expect(res.body.token).toBeNull();
  });

  test('the user block carries no tokens relation', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(res.body.user.tokens).toBeUndefined();
    expect(Object.keys(res.body.user).sort()).toEqual([
      'avatarUrl', 'createdAt', 'displayName', 'id', 'lastLoginAt', 'soundcloudId', 'username',
    ]);
  });
});

describe('GET /api/auth/export — response shape', () => {
  test('sets the dated attachment header', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="track-toolkit-export-\d{4}-\d{2}-\d{2}\.json"$/
    );
  });

  test('carries every section plus its schema version', async () => {
    const res = await request(app).get('/api/auth/export');

    // 2 since the four cross-branch tables were added, 3 since
    // experimentExposures was; the number is the reader's only signal that
    // the shape of the file changed.
    expect(res.body.schemaVersion).toBe(3);
    expect(typeof res.body.generatedAt).toBe('string');
    for (const key of [
      'user', 'token', 'operationLogs', 'growthActions', 'feedback', 'rebrandVotes',
      'surveyResponses', 'betaSignups', 'libraryCacheState', 'libraryCachePages',
      'chatConversations', 'indexedLikes', 'indexedPlaylistTracks', 'librarySnapshots',
      'experimentExposures',
    ]) {
      expect(res.body).toHaveProperty(key);
    }
  });

  test('chat messages come through with their conversation', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(res.body.chatConversations[0].chat_messages[0].content).toBe('hello');
  });

  test('BigInt columns survive serialization', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(res.body.growthActions[0].targetId).toBe(10);
    expect(res.body.rebrandVotes[0].soundcloudId).toBe(555);
  });

  test('cache pages carry their items, not just their counts', async () => {
    const res = await request(app).get('/api/auth/export');
    expect(res.body.libraryCachePages[0]).toEqual({
      resource: 'likes', pageIndex: 0, itemCount: 2, items: [{ id: 1 }, { id: 2 }],
    });
    expect(cachePageFindMany.mock.calls[0][0].select).toEqual({
      resource: true, pageIndex: true, itemCount: true, items: true,
    });
  });
});
