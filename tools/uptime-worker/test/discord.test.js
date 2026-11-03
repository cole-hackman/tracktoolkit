import { describe, expect, it, vi } from 'vitest';
import { formatAlert, sendAlert } from '../src/discord.js';

const down = (id, detail = 'NXDOMAIN', since = '2026-11-04T10:05:00Z') => ({ type: 'down', id, detail, since });
const up = (id, since = '2026-11-04T10:05:00Z') => ({ type: 'up', id, detail: 'ok', since });

describe('formatAlert', () => {
  it('formats down and up lines', () => {
    const text = formatAlert([down('dns:soundcloudtoolkit.com'), up('health')]);
    expect(text).toBe(
      'DOWN dns:soundcloudtoolkit.com: NXDOMAIN (since 2026-11-04T10:05:00Z)\nUP health (down since 2026-11-04T10:05:00Z)',
    );
  });

  it('never exceeds 2000 characters and notes omitted lines', () => {
    const events = Array.from({ length: 100 }, (_, i) => down(`check-${i}`, 'x'.repeat(40)));
    const text = formatAlert(events);
    expect(text.length).toBeLessThanOrEqual(2000);
    const lines = text.split('\n');
    const m = lines.at(-1).match(/^…and (\d+) more$/);
    expect(m).not.toBeNull();
    expect(lines.length - 1 + Number(m[1])).toBe(100);
  });

  it('leaves short output untouched', () => {
    expect(formatAlert([down('a')])).not.toContain('more');
  });
});

describe('sendAlert', () => {
  it('returns true without fetching for no events', async () => {
    const f = vi.fn();
    expect(await sendAlert('https://hook', [], f)).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the content as json', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const events = [down('health', 'HTTP 500')];
    expect(await sendAlert('https://hook', events, f)).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://hook');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ content: formatAlert(events) });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns false on non-2xx', async () => {
    const f = vi.fn().mockResolvedValue(new Response('rate', { status: 429 }));
    expect(await sendAlert('https://hook', [down('a')], f)).toBe(false);
  });

  it('returns false and never rejects on a throw', async () => {
    const f = vi.fn().mockRejectedValue(new Error('net'));
    await expect(sendAlert('https://hook', [down('a')], f)).resolves.toBe(false);
  });
});
