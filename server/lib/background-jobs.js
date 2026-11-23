/**
 * Whether boot-time jobs may run in this process. They delete accounts and use
 * stored tokens, so a dev server left open on a hosted database must not start
 * them. Production sets NODE_ENV=production (infra/main.bicep).
 */
export function backgroundJobsAllowed(env = process.env) {
  return env.NODE_ENV === 'production';
}
