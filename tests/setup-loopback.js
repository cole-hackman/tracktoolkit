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
 * listener on 127.0.0.1 is not in the way: 0 of 40,000. This applies only
 * when the server really is bound to `::`; anything else (an IPv4-only
 * machine, a server a test bound itself) keeps supertest's own address.
 * A process listening on `[::1]:<the same port>` would still shadow it.
 *
 * A test that opens its own server should bind it to 127.0.0.1:
 * `app.listen(0, '127.0.0.1', done)`. That cannot be shadowed at all, but it
 * binds asynchronously, which supertest's own `listen(0)` cannot wait for.
 */
import request from 'supertest';

const { Test } = request;
const PATCHED = Symbol.for('tracktoolkit.tests.loopbackServerAddress');

if (!Test.prototype[PATCHED]) {
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
