/**
 * The Content-Security-Policy is the enforcement behind a promise the privacy
 * policy makes in plain words: "We run no analytics or advertising scripts and
 * set no third-party cookies."
 *
 * These assertions fail the moment somebody re-adds an analytics tag, a widget
 * CDN or an external font host to the policy, which is the only way such a
 * script could load at all.
 */

const { cspDirectives, securityHeaders, ADMIN_FRAME_SRC } = await import('../server/middleware/security.js');

/** Hosts that have been in this CSP before, or would be if tracking came back. */
const FORBIDDEN_HOSTS = [
  'buymeacoffee',
  'googletagmanager',
  'google-analytics',
  'vercel',
  'googleapis',
  'gstatic',
];

describe('Content-Security-Policy directives', () => {
  test('scriptSrc allows nothing but our own origin and inline bootstrap', () => {
    // 'unsafe-inline' stays: Next.js's static export inlines its bootstrap.
    expect(cspDirectives.scriptSrc).toEqual(["'self'", "'unsafe-inline'"]);
  });

  // `frameSrc` is in this list, and was not until 2026-09-22. It is the one
  // directive with a second, wider value — `ADMIN_FRAME_SRC`, served to the
  // /admin document — so leaving it out left the only widened directive in
  // the app entirely unswept. `securityHeaders` derives the admin policy by
  // spreading `cspDirectives`, so the other four are literally the same
  // arrays on both policies and one pass over the base object covers them;
  // `frameSrc` is not, which is exactly why it needs its own check below.
  test.each(['scriptSrc', 'styleSrc', 'connectSrc', 'fontSrc', 'frameSrc'])(
    '%s names no tracking, widget or external-font host',
    (directive) => {
      const sources = cspDirectives[directive];
      expect(Array.isArray(sources)).toBe(true);
      for (const source of sources) {
        for (const host of FORBIDDEN_HOSTS) {
          expect(source).not.toContain(host);
        }
      }
    },
  );

  test('the admin frame-src allowance is SoundCloud’s player and nothing else', () => {
    // By value, not `toBe(ADMIN_FRAME_SRC)`: asserting a constant against
    // itself passes for any value it is ever given. Editing the constant is
    // the whole failure mode this guards, and every other test that touches
    // it compared it to itself.
    expect(ADMIN_FRAME_SRC).toBe('https://w.soundcloud.com');
    for (const host of FORBIDDEN_HOSTS) {
      expect(ADMIN_FRAME_SRC).not.toContain(host);
    }
  });

  test('styleSrc and fontSrc load from our own origin only', () => {
    // next/font self-hosts the webfonts into the static export, so neither
    // fonts.googleapis.com nor fonts.gstatic.com is ever contacted.
    expect(cspDirectives.styleSrc).toEqual(["'self'", "'unsafe-inline'"]);
    expect(cspDirectives.fontSrc).toEqual(["'self'", 'data:']);
  });

  test('connectSrc names SoundCloud and localhost as its only hosts', () => {
    // Scheme-only sources like `wss:` name no host; everything with a `//`
    // authority does, and each one has to be SoundCloud or local dev.
    const hosts = cspDirectives.connectSrc.filter((source) => source.includes('//'));
    expect(hosts.length).toBeGreaterThan(0);
    for (const source of hosts) {
      // Match on the parsed HOSTNAME, not on the source string. An unanchored
      // substring test passes `https://api.soundcloud.com.evil.example`, which
      // is a different site entirely. CSP allows a `:*` port wildcard, which
      // is not a legal URL port, so drop it before parsing.
      const { hostname } = new URL(source.replace(/:\*(?=$|\/)/, ''));
      expect({ source, hostname }).toEqual({
        source,
        hostname: expect.stringMatching(/^(([\w-]+\.)*soundcloud\.com|localhost)$/),
      });
    }
  });

  test('securityHeaders is still wired up as middleware', () => {
    expect(typeof securityHeaders).toBe('function');
  });
});
