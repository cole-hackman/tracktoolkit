import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { requireLocalTestDatabase } from './helpers/require-local-test-db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test.each([
  'postgresql://localhost:5432/tracktoolkit_test',
  'postgresql://127.0.0.1/test?schema=public',
  'postgresql://[::1]:5432/test',
])('accepts %s', (url) => {
  expect(() => requireLocalTestDatabase(url)).not.toThrow();
});

test.each([
  ['a hosted database', 'postgresql://db.example.com/tracktoolkit_test'],
  ['a hosted database with a local-looking user', 'postgresql://localhost@db.example.com/test'],
  ['a host that starts with localhost', 'postgresql://localhost.example.com/test'],
  ['a host override', 'postgresql://localhost/test?host=db.example.com'],
  ['several hosts', 'postgresql://localhost,db.example.com/test'],
  ['a local database that is not for tests', 'postgresql://localhost/tracktoolkit'],
  ['something that is not a URL', 'test'],
])('refuses %s', (_label, url) => {
  expect(() => requireLocalTestDatabase(url)).toThrow(/TT_TEST_DATABASE_URL/);
});

test('the error never repeats the URL', () => {
  expect(() => requireLocalTestDatabase('postgresql://db.example.com/test'))
    .toThrow(expect.not.objectContaining({ message: expect.stringContaining('example.com') }));
});

// setup-env.js runs before every suite, so one check there covers them all.
const loadSetup = (extra) => {
  const env = { ...process.env, ...extra };
  for (const key of ['TT_TEST_DATABASE_URL', 'DATABASE_URL']) if (!(key in extra)) delete env[key];
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(join(HERE, 'setup-env.js')).href)});`], { env, encoding: 'utf8' });
};

test('the Jest setup file stops a run aimed at a hosted database', () => {
  expect(loadSetup({}).status).toBe(0);
  expect(loadSetup({ TT_TEST_DATABASE_URL: 'postgresql://localhost/test' }).status).toBe(0);
  expect(loadSetup({ TT_TEST_DATABASE_URL: 'postgresql://db.example.com/test' }).status).not.toBe(0);
  expect(loadSetup({ DATABASE_URL: 'postgresql://db.example.com/app' }).status).not.toBe(0);
});
