import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const findFirst = jest.fn().mockResolvedValue(null);
const create = jest.fn().mockResolvedValue({ id: 'fb-1', createdAt: new Date('2026-09-22T00:00:00Z') });
const findMany = jest.fn().mockResolvedValue([]);
const rebrandFindUnique = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { feedback: { findFirst, create, findMany }, rebrandVote: { findUnique: rebrandFindUnique } },
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: function authenticateUser(req, res, next) {
    req.user = { id: 'user-a', soundcloudId: 111 };
    next();
  },
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  extractClientInfo: () => ({ device: 'desktop', browser: 'chrome', platform: 'mac' }),
}));
// Mocked both to keep this suite's output clean and, more usefully, so the
// "nothing the user wrote reaches the log" rule below can actually be asserted
// rather than eyeballed.
const logInfo = jest.fn();
const logDebug = jest.fn();
const logError = jest.fn();
jest.unstable_mockModule('../../server/lib/logger.js', () => ({
  default: { info: logInfo, debug: logDebug, error: logError, warn: jest.fn() },
}));
// The limiters are real in this process: createLimiter() only returns a
// pass-through when NODE_ENV === 'development', and Jest runs as 'test'. Left
// unmocked, the sixth POST in this file would 429 on the hourly budget — they
// all key on the same mocked user. Their configuration is asserted in
// tests/rate-limiter-config.test.js; what matters here is that they are
// mounted, and where, which the middleware-order test below checks directly.
jest.unstable_mockModule('../../server/middleware/rateLimiter.js', () => ({
  feedbackHourlyLimiter: function feedbackHourlyLimiter(req, res, next) { next(); },
  feedbackDailyLimiter: function feedbackDailyLimiter(req, res, next) { next(); },
}));

const { default: feedbackRoutes } = await import('../../server/routes/feedback.js');

const app = express();
app.use(express.json()); // mirrors prod: express.json() is the ONLY body parser
app.use('/api/feedback', feedbackRoutes);

const validBody = {
  type: 'bug',
  message: 'Merging two playlists stalled at 400 tracks and never finished.',
  page: '/combine',
};

beforeEach(() => {
  findFirst.mockClear().mockResolvedValue(null);
  create.mockClear().mockResolvedValue({ id: 'fb-1', createdAt: new Date('2026-09-22T00:00:00Z') });
  findMany.mockClear().mockResolvedValue([]);
  logInfo.mockClear();
  logDebug.mockClear();
  logError.mockClear();
});

describe('POST /api/feedback writes what the session says, not what the body says', () => {
  test('a valid body is stored and answered 201', async () => {
    const res = await request(app).post('/api/feedback').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('fb-1');
    expect(res.body.createdAt).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);

    const { data } = create.mock.calls[0][0];
    expect(data.userId).toBe('user-a');
    expect(data.soundcloudId).toBe(111);
    expect(data.type).toBe('bug');
    expect(data.page).toBe('/combine');
  });

  test('email is null when the user did not give one', async () => {
    await request(app).post('/api/feedback').send(validBody);

    expect(create.mock.calls[0][0].data.email).toBeNull();
  });

  test('an empty page is stored as null rather than rejected', async () => {
    // The form posts '' when it has no route to report. Before checkFalsy this
    // failed the route regex and 400'd an otherwise valid submission.
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, page: '' });

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].data.page).toBeNull();
  });

  test('a client-supplied userId and soundcloudId are ignored', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, userId: 'user-b', soundcloudId: 999 });

    expect(res.status).toBe(201);
    const { data } = create.mock.calls[0][0];
    // The principal comes from the session. Nothing in the body can move a
    // row onto another account.
    expect(data.userId).toBe('user-a');
    expect(data.soundcloudId).toBe(111);
  });

  test('the dedupe lookup is scoped to the session user', async () => {
    await request(app).post('/api/feedback').send({ ...validBody, userId: 'user-b' });

    expect(findFirst).toHaveBeenCalledTimes(1);
    const { where } = findFirst.mock.calls[0][0];
    expect(where.userId).toBe('user-a');
    expect(where.messageHash).toEqual(expect.any(String));
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  test('the stored messageHash is the sha256 of the normalized message', async () => {
    const { createHash } = await import('crypto');
    await request(app)
      .post('/api/feedback')
      .send({ ...validBody, message: '  The   SAME   Report  ' });

    const expected = createHash('sha256').update('the same report').digest('hex');
    expect(create.mock.calls[0][0].data.messageHash).toBe(expected);
  });

  test('control characters are stripped from the stored message', async () => {
    await request(app)
      .post('/api/feedback')
      .send({ ...validBody, message: 'Line one' + String.fromCharCode(0, 7) + ' and\r\nline two, long enough.' });

    const stored = create.mock.calls[0][0].data.message;
    expect(stored).not.toMatch(/[\u0000-\u0008\u000B-\u000D\u000E-\u001F]/);
    // \n survives: a multi-line report should stay multi-line.
    expect(stored).toContain('\n');
  });

  test('clientInfo is attached from the request, not the body', async () => {
    await request(app)
      .post('/api/feedback')
      .send({ ...validBody, clientInfo: { device: 'injected' } });

    expect(create.mock.calls[0][0].data.clientInfo).toEqual({
      device: 'desktop', browser: 'chrome', platform: 'mac',
    });
  });
});

describe('nothing the user wrote reaches the log', () => {
  test('the receipt line carries the user id and type, and nothing else', async () => {
    await request(app).post('/api/feedback').send({
      ...validBody,
      message: 'my-secret-bug-report-text that is plenty long',
      email: 'someone@example.com',
    });

    expect(logInfo).toHaveBeenCalledTimes(1);
    const [message, data] = logInfo.mock.calls[0];
    expect(message).toBe('feedback received');
    expect(data).toEqual({ userId: 'user-a', type: 'bug' });

    // The message and the reply address are the two pieces of user content
    // this route handles, and the log is the one place neither belongs.
    const logged = JSON.stringify(logInfo.mock.calls);
    expect(logged).not.toContain('my-secret-bug-report-text');
    expect(logged).not.toContain('someone@example.com');
  });

  test('the honeypot counter is debug-level and names no content', async () => {
    await request(app)
      .post('/api/feedback')
      .send({ ...validBody, website: 'http://spam.example.com' });

    // Debug-only: logger.debug is a no-op outside development, so spam cannot
    // fill the log in place of the table.
    expect(logInfo).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledTimes(1);
    expect(logDebug.mock.calls[0][1]).toEqual({ userId: 'user-a' });
  });
});

describe('POST /api/feedback fails closed', () => {
  test('a cross-site form-encoded POST cannot submit feedback', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .type('form')
      .send('type=bug&message=this+is+long+enough+to+pass');

    // express.json() ignores urlencoded bodies -> req.body empty -> validator
    // rejects. This is the same CSRF invariant the survey route relies on.
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  test('a 9-character message is rejected', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, message: '123456789' });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test('an unknown type is rejected', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, type: 'complaint' });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test('a message of only control characters is rejected, not stored blank', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, message: String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8, 11, 12) });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test('an array type never reaches Prisma', async () => {
    // express-validator 7 checks arrays element-wise, so ['bug'] satisfied
    // isIn() and used to reach create() as an array, 500-ing on a type error.
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, type: ['bug'] });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test('an array email never reaches Prisma', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, email: ['someone@example.com'] });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the honeypot swallows automated submissions', () => {
  test('a filled website field is answered 202 and stores nothing', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, website: 'http://spam.example.com' });

    // 202, not 400: a bot must not be able to tell which field gave it away.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(create).not.toHaveBeenCalled();
    // It does not even reach the duplicate lookup — no query, no row.
    expect(findFirst).not.toHaveBeenCalled();
  });

  test('an empty website field is treated as a real submission', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, website: '' });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('a whitespace-only website field is still a real submission', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...validBody, website: '   ' });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('the same message twice in a day is refused', () => {
  test('an existing recent row answers 409 and writes nothing', async () => {
    findFirst.mockResolvedValue({ id: 'fb-earlier' });

    const res = await request(app).post('/api/feedback').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('You already sent this recently');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('middleware order on POST /api/feedback', () => {
  test('the validator runs before the rate limiters', () => {
    const layer = feedbackRoutes.stack.find(
      (l) => l.route && l.route.path === '/' && l.route.methods.post
    );
    expect(layer).toBeDefined();

    const names = layer.route.stack.map((s) => s.handle.name);
    const validatorEnd = names.indexOf('handleValidationErrors');
    const hourly = names.indexOf('feedbackHourlyLimiter');
    const daily = names.indexOf('feedbackDailyLimiter');

    expect(names[0]).toBe('authenticateUser');
    expect(validatorEnd).toBeGreaterThan(-1);
    expect(hourly).toBeGreaterThan(-1);
    expect(daily).toBeGreaterThan(-1);
    // Validation first, so a forged cross-site post dies at the 400 instead of
    // spending a real user's feedback budget.
    expect(validatorEnd).toBeLessThan(hourly);
    expect(hourly).toBeLessThan(daily);
  });
});

describe('GET /api/feedback/mine is scoped to the session user', () => {
  test('a client-supplied userId in the query cannot select another user', async () => {
    const res = await request(app).get('/api/feedback/mine?userId=user-b');

    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.where.userId).toBe('user-a');
    expect(Object.keys(args.where)).toEqual(['userId']);
  });

  test('it returns at most 20 rows, newest first', async () => {
    await request(app).get('/api/feedback/mine');

    const args = findMany.mock.calls[0][0];
    expect(args.take).toBe(20);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('it never selects the admin note', async () => {
    await request(app).get('/api/feedback/mine');

    const { select } = findMany.mock.calls[0][0];
    expect(select.adminNote).toBeUndefined();
    expect(select.message).toBeUndefined();
    expect(select).toEqual({
      id: true, type: true, page: true, status: true, createdAt: true,
    });
  });

  test('it hands back the rows under an items key', async () => {
    findMany.mockResolvedValue([
      { id: 'fb-1', type: 'bug', page: '/combine', status: 'new', createdAt: new Date() },
    ]);

    const res = await request(app).get('/api/feedback/mine');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('fb-1');
  });
});

describe('a 500 never carries internal error text', () => {
  // What Prisma actually throws when the database is unreachable: the message
  // names the host and port. safeError() keeps err.message for the log, so
  // passing its result to res.json put this in front of the user.
  const prismaDown = () => Object.assign(
    new Error("Can't reach database server at `db.internal:5432`"),
    { code: 'P1001' },
  );
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  beforeEach(() => { process.env.NODE_ENV = 'production'; });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    rebrandFindUnique.mockReset().mockResolvedValue(null);
  });

  test('POST /api/feedback answers exactly the fixed message', async () => {
    create.mockRejectedValueOnce(prismaDown());
    const res = await request(app).post('/api/feedback').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to submit feedback' });
    expect(JSON.stringify(res.body)).not.toMatch(/db\.internal|5432|P1001/);
    // The detail still reaches the log.
    expect(JSON.stringify(logError.mock.calls)).toMatch(/db\.internal:5432/);
  });

  test('GET /api/feedback/mine answers exactly the fixed message', async () => {
    findMany.mockRejectedValueOnce(prismaDown());
    const res = await request(app).get('/api/feedback/mine');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load your feedback' });
  });

  test('GET /api/feedback/survey/status answers exactly the fixed message', async () => {
    rebrandFindUnique.mockRejectedValueOnce(prismaDown());
    const res = await request(app).get('/api/feedback/survey/status');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load survey status' });
  });
});
