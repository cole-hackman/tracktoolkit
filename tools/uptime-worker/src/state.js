export const DOWN_AFTER = 2;

export function emptyState() {
  return { checks: {}, pending: [] };
}

export function nextState(prev, results, now) {
  const checks = {};
  const events = [];

  for (const { id, ok, detail } of results) {
    const before = prev.checks[id] ?? { failures: 0, down: false, since: null };

    if (ok) {
      if (before.down) events.push({ type: 'up', id, detail, since: before.since });
      checks[id] = { failures: 0, down: false, since: null };
      continue;
    }

    const failures = before.failures + 1;
    const since = before.since ?? now;
    const down = failures >= DOWN_AFTER;
    if (down && !before.down) events.push({ type: 'down', id, detail, since });
    checks[id] = { failures, down, since };
  }

  return { state: { checks, pending: prev.pending ?? [] }, events };
}
