# Track Toolkit uptime monitor

A standalone Cloudflare Worker that checks Track Toolkit's five hostnames every
five minutes and posts to Discord when something breaks. It runs outside the
App Service on purpose, so an outage there or a broken DNS delegation cannot
take the monitor down with it.

## What it checks

Eleven checks per run:

- DNS: an A lookup over DNS-over-HTTPS (Cloudflare's resolver) for each of the
  five hostnames: `tracktoolkit.com`, `www.tracktoolkit.com`,
  `soundcloudtoolkit.com`, `www.soundcloudtoolkit.com` and
  `api.soundcloudtoolkit.com`.
- `https://tracktoolkit.com/health` answers.
- `https://tracktoolkit.com/` serves the app's HTML with no injected
  Cloudflare scripts.
- Each of the four legacy hostnames redirects to the apex at the right path.

Each check times out after 10 seconds, and one hanging check does not stop the
others.

## When it alerts

A check counts as down after 2 consecutive failures, so a single blip stays
quiet. You get one Discord message when it goes down and one when it
recovers. If Discord is unreachable or rate-limited, the events are kept in
state and sent on the next run, together with any new ones. Without a webhook
URL they simply accumulate (newest 100 kept).

A `GET /` on the Worker returns the last run as JSON (`lastRun` and each
check's `id`, `ok` and `detail`). Everything else is a 404.

## Deploy

From this directory:

```
npm ci
npx wrangler login
npx wrangler kv namespace create STATE
```

Paste the printed namespace id into `kv_namespaces[0].id` in `wrangler.jsonc`
in place of `REPLACE_WITH_KV_NAMESPACE_ID`, then:

```
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler deploy
```

The Worker writes KV once per run, 288 times a day, under the free plan's
1,000.

## Drill

To prove the alert path end to end, add a hostname that does not resolve as a
sixth DNS check:

```
npx wrangler deploy --var DRILL_HOST:monitor-drill.tracktoolkit.com
```

Expect a DOWN message after the second failing run (about 10 minutes). Then
redeploy without the variable to remove it:

```
npx wrangler deploy
```

`DRILL_HOST` is deliberately not in `wrangler.jsonc`.

## DNS caching caveat

DNS answers come from 1.1.1.1's cache. A broken delegation only shows once the
cached records expire: that is the 30-minute TTL at Spaceship today, and 300
seconds once the zones are proxied through Cloudflare. Worst-case detection of
real DNS breakage is therefore about the TTL plus 10 minutes, roughly 40
minutes now and roughly 15 after the move. The drill measures an NXDOMAIN
host, which is not cached the same way, so its timing is not the timing for a
real delegation failure. Quote the drill time as the alert path's latency, not
as the detection time for DNS breakage.

## Tests

```
npm test
```

## Not part of the app deploy

Changes under `tools/uptime-worker/` are in `paths-ignore` for
`.github/workflows/azure-deploy.yml`, so merging them does not deploy the App
Service. This Worker is deployed by hand with Wrangler.
