const MAX_CONTENT = 2000;
const TIMEOUT_MS = 10_000;

const MAX_DETAIL = 200;

const formatLine = (e) =>
  e.type === 'down' ? `DOWN ${e.id}: ${String(e.detail).slice(0, MAX_DETAIL)} (since ${e.since})` : `UP ${e.id} (down since ${e.since})`;

export function formatAlert(events) {
  const lines = events.map(formatLine);
  const full = lines.join('\n');
  if (full.length <= MAX_CONTENT) return full;

  for (let keep = lines.length - 1; keep >= 0; keep--) {
    const tail = `…and ${lines.length - keep} more`;
    const text = [...lines.slice(0, keep), tail].join('\n');
    if (text.length <= MAX_CONTENT) return text;
  }
  return `…and ${lines.length} more`;
}

export async function sendAlert(webhookUrl, events, fetchFn = fetch) {
  if (events.length === 0) return true;
  try {
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: formatAlert(events), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
