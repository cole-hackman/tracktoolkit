import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_HOSTS, LEGACY_HOSTS, buildChecks, runAll, runCheck } from '../src/checks.js';

const byId = (id, opts) => buildChecks(opts).find((c) => c.id === id);
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('buildChecks', () => {
  it('returns 11 checks', () => {
    const checks = buildChecks();
    expect(checks).toHaveLength(11);
    const ids = checks.map((c) => c.id);
    expect(ALL_HOSTS).toHaveLength(5);
    for (const h of ALL_HOSTS) expect(ids).toContain(`dns:${h}`);
    expect(ids).toContain('health');
    expect(ids).toContain('home');
    for (const h of LEGACY_HOSTS) expect(ids).toContain(`redirect:${h}`);
  });

  it('adds a drill dns check', () => {
    const checks = buildChecks({ drillHost: 'monitor-drill.tracktoolkit.com' });
    expect(checks).toHaveLength(12);
    expect(checks.map((c) => c.id)).toContain('dns:monitor-drill.tracktoolkit.com');
  });

  it('uses the faq monitor url for redirects', () => {
    expect(byId('redirect:soundcloudtoolkit.com').url).toBe('https://soundcloudtoolkit.com/faq?monitor=1');
  });
});

describe('runCheck dns', () => {
  const check = byId('dns:tracktoolkit.com');
  const run = (body) => runCheck(check, async () => json(body));

  it('passes with an A answer', async () => {
    expect((await run({ Status: 0, Answer: [{ type: 5 }, { type: 1 }] })).ok).toBe(true);
  });
  it('fails NXDOMAIN', async () => {
    const r = await run({ Status: 3 });
    expect(r).toMatchObject({ ok: false, detail: 'NXDOMAIN' });
  });
  it('fails REFUSED', async () => {
    expect(await run({ Status: 5 })).toMatchObject({ ok: false, detail: 'REFUSED' });
  });
  it('fails with no A record', async () => {
    expect(await run({ Status: 0, Answer: [{ type: 5 }] })).toMatchObject({ ok: false, detail: 'no A record' });
    expect(await run({ Status: 0 })).toMatchObject({ ok: false, detail: 'no A record' });
  });
  it('queries DoH with the dns-json accept header', async () => {
    const fn = vi.fn(async () => json({ Status: 0, Answer: [{ type: 1 }] }));
    await runCheck(check, fn);
    expect(fn.mock.calls[0][0]).toBe('https://cloudflare-dns.com/dns-query?name=tracktoolkit.com&type=A');
    expect(fn.mock.calls[0][1].headers.accept).toBe('application/dns-json');
    expect(fn.mock.calls[0][1].headers['user-agent']).toBe('tracktoolkit-uptime/1');
    expect(fn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('runCheck health', () => {
  const check = byId('health');
  it('passes on ok json', async () => {
    expect((await runCheck(check, async () => json({ status: 'ok', timestamp: 'x' }))).ok).toBe(true);
  });
  it('fails on 500', async () => {
    expect((await runCheck(check, async () => json({ status: 'ok' }, { status: 500 }))).ok).toBe(false);
  });
  it('fails on 200 with an html body', async () => {
    const r = await runCheck(check, async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(r.ok).toBe(false);
  });
});

describe('runCheck home', () => {
  const check = byId('home');
  const page = (body = '<html>ok</html>', headers = {}) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=UTF-8', 'content-security-policy': "default-src 'self'", ...headers },
    });

  it('passes on a clean page', async () => {
    expect((await runCheck(check, async () => page())).ok).toBe(true);
  });
  it.each(['<script src="/cdn-cgi/x.js"></script>', '<script>cloudflareinsights</script>'])(
    'fails with injected: for %s',
    async (body) => {
      const r = await runCheck(check, async () => page(body));
      expect(r.ok).toBe(false);
      expect(r.detail.startsWith('injected:')).toBe(true);
    },
  );
  it('fails without a csp header', async () => {
    const res = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await runCheck(check, async () => res)).ok).toBe(false);
  });
  it.each(['__cf_bm=abc; Path=/', 'cf_clearance=abc; Path=/'])('fails on cookie %s', async (cookie) => {
    const headers = new Headers({ 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" });
    headers.append('set-cookie', 'tt_session=1; Path=/');
    headers.append('set-cookie', cookie);
    const r = await runCheck(check, async () => new Response('<html></html>', { status: 200, headers }));
    expect(r.ok).toBe(false);
  });
  it('passes with only app cookies', async () => {
    const headers = new Headers({ 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" });
    headers.append('set-cookie', 'tt_session=1; Path=/');
    expect((await runCheck(check, async () => new Response('<html></html>', { status: 200, headers }))).ok).toBe(true);
  });
});

describe('runCheck redirect', () => {
  const check = byId('redirect:www.tracktoolkit.com');
  const redirect = (status, location) =>
    new Response(null, { status, headers: location ? { location } : {} });
  const GOOD = 'https://tracktoolkit.com/faq/?monitor=1';

  it('passes on the exact 301', async () => {
    expect((await runCheck(check, async () => redirect(301, GOOD))).ok).toBe(true);
  });
  it('uses manual redirect mode', async () => {
    const fn = vi.fn(async () => redirect(301, GOOD));
    await runCheck(check, fn);
    expect(fn.mock.calls[0][1].redirect).toBe('manual');
  });
  it('fails on 302', async () => {
    expect((await runCheck(check, async () => redirect(302, GOOD))).ok).toBe(false);
  });
  it('fails on 200', async () => {
    expect((await runCheck(check, async () => new Response('hi', { status: 200 }))).ok).toBe(false);
  });
  it('fails on a 301 elsewhere', async () => {
    expect((await runCheck(check, async () => redirect(301, 'https://tracktoolkit.com/faq?monitor=1'))).ok).toBe(false);
  });
});

describe('runAll', () => {
  afterEach(() => vi.useRealTimers());

  it('times out a hung check after 10s while others pass', async () => {
    vi.useFakeTimers();
    const fetchFn = (url) =>
      url.includes('/health') ? new Promise(() => {}) : Promise.resolve(json({ Status: 0, Answer: [{ type: 1 }] }));
    const checks = [byId('health'), byId('dns:tracktoolkit.com')];
    const p = runAll(checks, fetchFn);
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await p;
    expect(results.find((r) => r.id === 'health')).toMatchObject({ ok: false, detail: 'timeout' });
    expect(results.find((r) => r.id === 'dns:tracktoolkit.com').ok).toBe(true);
  });

  it('reports a thrown fetch with its message', async () => {
    const fetchFn = (url) => (url.includes('/health') ? Promise.reject(new Error('boom')) : Promise.resolve(json({ Status: 0, Answer: [{ type: 1 }] })));
    const results = await runAll([byId('health'), byId('dns:tracktoolkit.com')], fetchFn);
    expect(results[0]).toMatchObject({ id: 'health', ok: false, detail: 'boom' });
    expect(results[1].ok).toBe(true);
  });

  it('leaves no pending timer after checks settle', async () => {
    vi.useFakeTimers();
    await runAll([byId('dns:tracktoolkit.com')], async () => json({ Status: 0, Answer: [{ type: 1 }] }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
