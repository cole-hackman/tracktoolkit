import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

const HOOK = 'https://discord.test/webhook';

function makeKv(initial) {
  const store = new Map(initial === undefined ? [] : [['state', initial]]);
  return {
    store,
    get: vi.fn(async (k) => store.get(k) ?? null),
    put: vi.fn(async (k, v) => void store.set(k, v)),
  };
}

const envWith = (kv, extra = {}) => ({ STATE: kv, DISCORD_WEBHOOK_URL: HOOK, ...extra });
const controller = (t = Date.UTC(2026, 10, 4, 10, 0, 0)) => ({ scheduledTime: t });

function healthy(url) {
  if (url.includes('cloudflare-dns.com')) return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] });
  if (url.endsWith('/health')) return Response.json({ status: 'ok' });
  if (url.includes('monitor=1')) {
    return new Response(null, { status: 301, headers: { location: 'https://tracktoolkit.com/faq/?monitor=1' } });
  }
  return new Response('<html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" },
  });
}

// Every site check fails (500); the webhook answers with `hookStatus`.
function stubFetch({ hookStatus = 204, sitesDown = true } = {}) {
  const hook = vi.fn(async () => new Response(null, { status: hookStatus }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (String(url) === HOOK) return hook(url, init);
      if (sitesDown) throw new Error('boom');
      return healthy(String(url));
    }),
  );
  return hook;
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scheduled', () => {
  it.each([[undefined], ['not json'], ['null'], ['{}']])('starts fresh from stored %s', async (stored) => {
    stubFetch();
    const kv = makeKv(stored);
    await worker.scheduled(controller(), envWith(kv));
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(kv.store.get('state'));
    expect(saved.lastResults).toHaveLength(11);
    expect(saved.lastRun).toBe('2026-11-04T10:00:00.000Z');
    expect(saved.checks['dns:tracktoolkit.com'].failures).toBe(1);
    expect(saved.pending).toEqual([]);
  });

  it('rejects without writing when the KV read fails', async () => {
    stubFetch();
    const kv = makeKv('{"checks":{},"pending":[]}');
    kv.get.mockRejectedValue(new Error('kv unavailable'));
    await expect(worker.scheduled(controller(), envWith(kv))).rejects.toThrow('kv unavailable');
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('calls the webhook once after two failing runs', async () => {
    const hook = stubFetch();
    const kv = makeKv();
    await worker.scheduled(controller(), envWith(kv));
    expect(hook).not.toHaveBeenCalled();
    await worker.scheduled(controller(), envWith(kv));
    expect(hook).toHaveBeenCalledTimes(1);
    await worker.scheduled(controller(), envWith(kv));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.store.get('state')).pending).toEqual([]);
  });

  it('keeps events pending when the webhook fails and resends them with new ones', async () => {
    const hook = stubFetch({ hookStatus: 500 });
    const kv = makeKv();
    await worker.scheduled(controller(), envWith(kv));
    await worker.scheduled(controller(), envWith(kv));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.store.get('state')).pending).toHaveLength(11);

    const hook2 = stubFetch({ hookStatus: 204, sitesDown: false });
    await worker.scheduled(controller(), envWith(kv));
    expect(hook2).toHaveBeenCalledTimes(1);
    const body = JSON.parse(hook2.mock.calls[0][1].body);
    expect(body.content).toContain('DOWN dns:tracktoolkit.com');
    expect(body.content).toContain('UP dns:tracktoolkit.com');
    expect(JSON.parse(kv.store.get('state')).pending).toEqual([]);
  });

  it('keeps events pending when no webhook is configured, capped at 100', async () => {
    stubFetch();
    const old = Array.from({ length: 150 }, (_, i) => ({ type: 'down', id: `old-${i}`, detail: 'x', since: 's' }));
    const kv = makeKv(JSON.stringify({ checks: {}, pending: old }));
    await worker.scheduled(controller(), { STATE: kv });
    const saved = JSON.parse(kv.store.get('state'));
    expect(saved.pending).toHaveLength(100);
    expect(saved.pending.at(-1).id).toBe('old-149');
  });

  it('logs a summary without the webhook URL', async () => {
    stubFetch();
    await worker.scheduled(controller(), envWith(makeKv()));
    const lines = console.log.mock.calls.map((c) => c.join(' '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^uptime: 0\/11 ok, 0 events, alert none$/);
    expect(lines[0]).not.toContain('discord.test');
  });

  it('passes DRILL_HOST through as an extra dns check', async () => {
    stubFetch({ sitesDown: false });
    const kv = makeKv();
    await worker.scheduled(controller(), envWith(kv, { DRILL_HOST: 'monitor-drill.tracktoolkit.com' }));
    const saved = JSON.parse(kv.store.get('state'));
    expect(saved.lastResults.map((r) => r.id)).toContain('dns:monitor-drill.tracktoolkit.com');
  });
});

describe('fetch', () => {
  const req = (path = '/', method = 'GET') => new Request(`https://uptime.test${path}`, { method });

  it('serves stored results without ms or the webhook URL', async () => {
    stubFetch();
    const kv = makeKv();
    await worker.scheduled(controller(), envWith(kv));
    const res = await worker.fetch(req(), envWith(kv));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('discord.test');
    const body = JSON.parse(text);
    expect(body.lastRun).toBe('2026-11-04T10:00:00.000Z');
    expect(body.checks).toHaveLength(11);
    expect(Object.keys(body.checks[0]).sort()).toEqual(['detail', 'id', 'ok']);
  });

  it('returns an empty body when nothing is stored', async () => {
    const res = await worker.fetch(req(), envWith(makeKv()));
    expect(await res.json()).toEqual({ lastRun: null, checks: [] });
  });

  it('returns 503 json when the KV read fails', async () => {
    const kv = makeKv('{}');
    kv.get.mockRejectedValue(new Error('kv down'));
    const res = await worker.fetch(req(), envWith(kv));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'state unavailable' });
  });

  it('still returns the empty 200 for unparseable stored state', async () => {
    const res = await worker.fetch(req(), envWith(makeKv('not json')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastRun: null, checks: [] });
  });

  it.each([['/other', 'GET'], ['/', 'POST'], ['/health', 'GET']])('404s %s %s', async (path, method) => {
    const res = await worker.fetch(req(path, method), envWith(makeKv()));
    expect(res.status).toBe(404);
  });
});
