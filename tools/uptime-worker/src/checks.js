export const APP_ORIGIN = 'https://tracktoolkit.com';
export const LEGACY_HOSTS = [
  'www.tracktoolkit.com',
  'soundcloudtoolkit.com',
  'www.soundcloudtoolkit.com',
  'api.soundcloudtoolkit.com',
];
export const ALL_HOSTS = ['tracktoolkit.com', ...LEGACY_HOSTS];

const TIMEOUT_MS = 10_000;
const USER_AGENT = 'tracktoolkit-uptime/1';
const REDIRECT_TARGET = `${APP_ORIGIN}/faq/?monitor=1`;
const INJECTION_MARKERS = ['/cdn-cgi/', 'cloudflareinsights'];

export function buildChecks({ drillHost } = {}) {
  const dnsHosts = drillHost ? [...ALL_HOSTS, drillHost] : ALL_HOSTS;
  return [
    ...dnsHosts.map((host) => ({
      id: `dns:${host}`,
      kind: 'dns',
      host,
      url: `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
    })),
    { id: 'health', kind: 'health', host: 'tracktoolkit.com', url: `${APP_ORIGIN}/health` },
    { id: 'home', kind: 'home', host: 'tracktoolkit.com', url: `${APP_ORIGIN}/` },
    ...LEGACY_HOSTS.map((host) => ({
      id: `redirect:${host}`,
      kind: 'redirect',
      host,
      url: `https://${host}/faq?monitor=1`,
    })),
  ];
}

function setCookieNames(headers) {
  const lines = headers.getSetCookie?.() ?? [headers.get('set-cookie')].filter(Boolean);
  return lines.map((line) => line.split('=')[0].trim());
}

const fail = (detail) => ({ ok: false, detail });
const pass = { ok: true, detail: 'ok' };

async function evaluate(check, fetchFn) {
  const init = {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (check.kind === 'dns') init.headers.accept = 'application/dns-json';
  if (check.kind === 'redirect') init.redirect = 'manual';

  const res = await fetchFn(check.url, init);

  switch (check.kind) {
    case 'dns': {
      const body = await res.json();
      if (body.Status === 3) return fail('NXDOMAIN');
      if (body.Status === 5) return fail('REFUSED');
      if (body.Status !== 0) return fail(`DNS status ${body.Status}`);
      return (body.Answer ?? []).some((a) => a.type === 1) ? pass : fail('no A record');
    }
    case 'health': {
      if (res.status !== 200) return fail(`HTTP ${res.status}`);
      let body;
      try {
        body = await res.json();
      } catch {
        return fail('health body is not JSON');
      }
      return body?.status === 'ok' ? pass : fail('health status not ok');
    }
    case 'home': {
      if (res.status !== 200) return fail(`HTTP ${res.status}`);
      if (!(res.headers.get('content-type') ?? '').includes('text/html')) return fail('not text/html');
      if (!res.headers.get('content-security-policy')) return fail('missing content-security-policy');
      const cookie = setCookieNames(res.headers).find((n) => n.startsWith('__cf') || n.startsWith('cf_'));
      if (cookie) return fail(`injected: cookie ${cookie}`);
      const body = await res.text();
      const marker = INJECTION_MARKERS.find((m) => body.includes(m));
      return marker ? fail(`injected: ${marker}`) : pass;
    }
    case 'redirect': {
      if (res.status !== 301) return fail(`HTTP ${res.status}`);
      const location = res.headers.get('location');
      return location === REDIRECT_TARGET ? pass : fail(`location ${location ?? 'missing'}`);
    }
    default:
      return fail(`unknown check kind ${check.kind}`);
  }
}

export async function runCheck(check, fetchFn = fetch) {
  const start = Date.now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail('timeout')), TIMEOUT_MS);
  });
  let outcome;
  try {
    outcome = await Promise.race([evaluate(check, fetchFn), timeout]);
  } catch (err) {
    outcome = fail(err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? String(err)));
  } finally {
    clearTimeout(timer);
  }
  return { id: check.id, ok: outcome.ok, detail: outcome.detail, ms: Date.now() - start };
}

export async function runAll(checks, fetchFn = fetch) {
  const settled = await Promise.allSettled(checks.map((c) => runCheck(c, fetchFn)));
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { id: checks[i].id, ok: false, detail: s.reason?.message ?? String(s.reason), ms: 0 },
  );
}
