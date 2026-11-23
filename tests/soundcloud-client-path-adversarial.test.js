import { jest } from '@jest/globals';
import { Response } from 'node-fetch';

/**
 * ADVERSARIAL (independent verifier) — playlist ids interpolated into
 * SoundCloud paths. No real network: global.fetch is a mock.
 */
jest.unstable_mockModule('../server/lib/prisma.js', () => ({
  default: { token: { update: jest.fn(), findUnique: jest.fn() } },
}));
const { soundcloudClient } = await import('../server/lib/soundcloud-client.js');

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
});

const helpers = {
  getPlaylistWithTracks: (id) => soundcloudClient.getPlaylistWithTracks('a', 'r', id),
  addTracksToPlaylist: (id) => soundcloudClient.addTracksToPlaylist('a', 'r', id, [5]),
  deletePlaylist: (id) => soundcloudClient.deletePlaylist('a', 'r', id),
};

describe.each(Object.keys(helpers))('%s', (name) => {
  test.each([
    ['nested array', [[2]]],
    ['array', [2]],
    ['boolean true', true],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['whitespace only', '   '],
    ['bigint 0', 0n],
    ['huge bigint', 2n ** 64n],
    ['unicode digit', '٢'],
  ])('%s throws without fetching', async (_l, bad) => {
    await expect(helpers[name](bad)).rejects.toThrow(/playlist id/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a bigint id is sent as its number', async () => {
    await helpers[name](12n);
    expect(fetch.mock.calls[0][0]).toMatch(/\/playlists\/12(\?|$)/);
  });

  // Lenient but safe: Number() accepts these spellings, and the NUMBER is what
  // reaches the path, so nothing can be smuggled. Recorded so a reviewer sees
  // the helper is a path guard, not a canonical-spelling check.
  test.each([[' 2', 2], ['0x10', 16], ['2e3', 2000], ['1.0', 1]])(
    '%p is coerced to %p in the path (never the raw string)', async (input, n) => {
      await helpers[name](input);
      expect(fetch.mock.calls[0][0]).toMatch(new RegExp(`/playlists/${n}(\\?|$)`));
    },
  );
});

describe('deleteRepost (a sibling that interpolates a playlist id)', () => {
  // DEFECT: deleteRepost builds `/reposts/playlists/${id}` from the raw value.
  // The brief requires every playlist-path helper to refuse anything but a
  // positive safe integer. Expected to FAIL until it uses the same guard.
  test('a traversal id for a playlist repost throws without fetching', async () => {
    await expect(
      soundcloudClient.deleteRepost('a', 'r', '2/../../../playlists/777', 'playlist'),
    ).rejects.toThrow(/playlist id/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an array id for a playlist repost throws without fetching', async () => {
    await expect(soundcloudClient.deleteRepost('a', 'r', [5, 6], 'playlist')).rejects.toThrow(/playlist id/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
