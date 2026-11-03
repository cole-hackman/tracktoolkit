import { buildChecks, runAll } from './checks.js';
import { emptyState, nextState } from './state.js';
import { sendAlert } from './discord.js';

const KEY = 'state';
const MAX_PENDING = 100;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function readStored(kv) {
  try {
    const parsed = JSON.parse(await kv.get(KEY));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const usable = (s) => s && isObject(s.checks) && Array.isArray(s.pending);

export default {
  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime ?? Date.now()).toISOString();
    const stored = await readStored(env.STATE);
    const prev = usable(stored) ? { checks: stored.checks, pending: stored.pending } : emptyState();

    const results = await runAll(buildChecks({ drillHost: env.DRILL_HOST || undefined }));
    const { state, events } = nextState(prev, results, now);

    const toSend = [...state.pending, ...events];
    let alert = 'none';
    if (toSend.length > 0 && env.DISCORD_WEBHOOK_URL) {
      const ok = await sendAlert(env.DISCORD_WEBHOOK_URL, toSend);
      alert = ok ? 'sent' : 'failed';
      state.pending = ok ? [] : toSend;
    } else {
      state.pending = toSend;
    }
    state.pending = state.pending.slice(-MAX_PENDING);

    await env.STATE.put(KEY, JSON.stringify({ ...state, lastRun: now, lastResults: results }));

    const okCount = results.filter((r) => r.ok).length;
    console.log(`uptime: ${okCount}/${results.length} ok, ${events.length} events, alert ${alert}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/') {
      return new Response('Not found', { status: 404 });
    }
    const stored = await readStored(env.STATE);
    const lastResults = Array.isArray(stored?.lastResults) ? stored.lastResults : [];
    const body = {
      lastRun: typeof stored?.lastRun === 'string' ? stored.lastRun : null,
      checks: lastResults.map(({ id, ok, detail }) => ({ id, ok, detail })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },
};
