/**
 * Make supertest reach the server it just started.
 *
 * supertest calls `listen(0)` with no host and then connects to
 * `127.0.0.1:<port>`. With no host Node binds the wildcard address (`::`,
 * dual-stack), and on macOS the kernel can hand a wildcard bind a port that
 * another local process already holds on 127.0.0.1 itself. The more specific
 * listener wins, so the request is answered by that other process: a 404
 * "not found", a reset, a 200 with someone else's HTML. Measured on the
 * machine this was written on, with 25 such listeners in the ephemeral range
 * (developer tools and a browser): 84 of 40,000 supertest requests to a bare
 * Express app, and 1 to 3 failed tests in most runs of this suite, a
 * different test each time.
 *
 * Over the IPv6 loopback the same wildcard socket is reached and an IPv4
 * listener on 127.0.0.1 is not in the way: 0 of 40,000. A process listening
 * on `[::1]:<the same port>` would still shadow it.
 *
 * Two conditions, and both are needed:
 *   - the server really is bound to `::`. A server a test bound itself, or an
 *     IPv4-only bind, keeps supertest's own address.
 *   - `::1` exists on an interface. A `::` bind does not prove it: Linux with
 *     IPv6 switched off by sysctl (`net.ipv6.conf.all.disable_ipv6=1`, or
 *     `lo` alone) still binds `::`, has no `::1`, and every request would
 *     fail with EADDRNOTAVAIL. There the stock 127.0.0.1 address is kept,
 *     which is fine: the collision above is how macOS hands out ports.
 *
 * A test that opens its own server should bind it to 127.0.0.1:
 * `app.listen(0, '127.0.0.1', done)`. That cannot be shadowed at all, but it
 * binds asynchronously, which supertest's own `listen(0)` cannot wait for.
 */
import os from 'node:os';
import request from 'supertest';

const { Test } = request;
const PATCHED = Symbol.for('tracktoolkit.tests.loopbackServerAddress');

const hasIpv6Loopback = Object.values(os.networkInterfaces())
  .some((addresses) => (addresses || []).some((entry) => entry.address === '::1'));

if (hasIpv6Loopback && !Test.prototype[PATCHED]) {
  const serverAddress = Test.prototype.serverAddress;
  Test.prototype.serverAddress = function loopbackServerAddress(app, path) {
    const url = serverAddress.call(this, app, path);
    const bound = app.address();
    return bound && bound.family === 'IPv6' && bound.address === '::'
      ? url.replace('://127.0.0.1:', '://[::1]:')
      : url;
  };
  Test.prototype[PATCHED] = true;
}
