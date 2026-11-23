import { requireLocalHost, requireLocalTestDatabase } from './helpers/require-local-test-db.js';

/**
 * Test environment defaults.
 *
 * Five suites import modules that validate SoundCloud credentials at module
 * scope (`new SoundCloudClient()` throws on missing config). Without these set,
 * those suites fail to LOAD — which reads as "5 failed suites" and looks like a
 * broken test suite rather than a missing .env. That has already misled a
 * reader once.
 *
 * These are dummy values, deliberately not real credentials, and they never
 * override a value that is already set — so a developer with a real server/.env
 * keeps whatever they configured.
 */
process.env.SOUNDCLOUD_CLIENT_ID ||= 'test-client-id';
process.env.SOUNDCLOUD_CLIENT_SECRET ||= 'test-client-secret';
process.env.SOUNDCLOUD_REDIRECT_URI ||= 'http://localhost:3001/api/auth/callback';
process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);   // AES-256 needs exactly 32
process.env.SESSION_SECRET ||= 'y'.repeat(36);   // HMAC signing needs >= 32

// Stops the run before any suite loads. Prisma reads ./.env by itself when
// DATABASE_URL is unset, so an unset value is pinned to a closed local port.
if (process.env.TT_TEST_DATABASE_URL) requireLocalTestDatabase(process.env.TT_TEST_DATABASE_URL);
if (process.env.DATABASE_URL) requireLocalHost(process.env.DATABASE_URL, 'DATABASE_URL');
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/test';
