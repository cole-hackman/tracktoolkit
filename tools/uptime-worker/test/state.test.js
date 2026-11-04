import { describe, expect, it } from 'vitest';
import { DOWN_AFTER, emptyState, nextState } from '../src/state.js';

const res = (id, ok, detail = ok ? 'ok' : 'boom') => ({ id, ok, detail, ms: 5 });
const T1 = '2026-11-04T10:00:00Z';
const T2 = '2026-11-04T10:05:00Z';
const T3 = '2026-11-04T10:10:00Z';
const T4 = '2026-11-04T10:15:00Z';

describe('nextState', () => {
  it('pins DOWN_AFTER to 2', () => {
    expect(DOWN_AFTER).toBe(2);
  });

  it('starts empty', () => {
    expect(emptyState()).toEqual({ checks: {}, pending: [] });
  });

  it('gives no event on a single failure', () => {
    const { state, events } = nextState(emptyState(), [res('health', false)], T1);
    expect(events).toEqual([]);
    expect(state.checks.health).toEqual({ failures: 1, down: false, since: T1 });
  });

  it('alerts down on the second consecutive failure with the first failure time, then stays quiet', () => {
    let s = nextState(emptyState(), [res('health', false)], T1).state;
    const second = nextState(s, [res('health', false, 'HTTP 500')], T2);
    expect(second.events).toEqual([{ type: 'down', id: 'health', detail: 'HTTP 500', since: T1 }]);
    expect(second.state.checks.health).toEqual({ failures: 2, down: true, since: T1 });
    const third = nextState(second.state, [res('health', false)], T3);
    expect(third.events).toEqual([]);
    expect(third.state.checks.health).toEqual({ failures: 3, down: true, since: T1 });
  });

  it('alerts up on the next pass and resets', () => {
    let s = nextState(emptyState(), [res('health', false)], T1).state;
    s = nextState(s, [res('health', false)], T2).state;
    const up = nextState(s, [res('health', true)], T3);
    expect(up.events).toEqual([{ type: 'up', id: 'health', detail: 'ok', since: T1 }]);
    expect(up.state.checks.health).toEqual({ failures: 0, down: false, since: null });
  });

  it('never alerts on fail, pass, fail', () => {
    let s = nextState(emptyState(), [res('health', false)], T1);
    expect(s.events).toEqual([]);
    s = nextState(s.state, [res('health', true)], T2);
    expect(s.events).toEqual([]);
    s = nextState(s.state, [res('health', false)], T3);
    expect(s.events).toEqual([]);
    expect(s.state.checks.health).toEqual({ failures: 1, down: false, since: T3 });
  });

  it('drops ids absent from results without an event', () => {
    let s = nextState(emptyState(), [res('a', false), res('b', true)], T1).state;
    s = nextState(s, [res('a', false)], T2).state;
    const out = nextState(s, [res('b', true)], T3);
    expect(Object.keys(out.state.checks)).toEqual(['b']);
    expect(out.events).toEqual([]);
  });

  it('preserves pending and does not mutate prev', () => {
    const pending = [{ type: 'down', id: 'x', detail: 'd', since: T1 }];
    const prev = { checks: {}, pending };
    const { state } = nextState(prev, [res('health', false)], T2);
    expect(state.pending).toEqual(pending);
    expect(prev.checks).toEqual({});
  });
});
