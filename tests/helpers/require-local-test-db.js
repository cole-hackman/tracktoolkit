/**
 * The integration suites start by deleting every user, so the database they
 * are given must be a local one whose name says it is for tests.
 *
 * Throws without repeating any part of the URL, which holds a password.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function requireLocalHost(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  // `?host=` overrides the host in the authority part, so it is refused too.
  const overridden = url.searchParams.has('host') || url.searchParams.has('hostaddr');
  if (!LOCAL_HOSTS.has(url.hostname) || overridden) {
    throw new Error(
      `${name} must point at localhost. These suites delete every row in users, so they never run against a hosted database.`,
    );
  }
  return url;
}

export function requireLocalTestDatabase(value, name = 'TT_TEST_DATABASE_URL') {
  const url = requireLocalHost(value, name);
  if (!url.pathname.toLowerCase().includes('test')) {
    throw new Error(`${name} must name a database with "test" in it: the suites delete every row in users.`);
  }
}
