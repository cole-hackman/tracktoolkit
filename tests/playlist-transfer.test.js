import { jest } from '@jest/globals';
import {
  extractOrderedTrackIds,
  readPlaylistForRewrite,
  PlaylistReadIncompleteError,
  duplicateTrackBetweenPlaylists,
  moveTrackBetweenPlaylists,
} from '../server/lib/playlist-transfer.js';

describe('playlist-transfer', () => {
  const accessToken = 'a';
  const refreshToken = 'r';

  test('extractOrderedTrackIds preserves order and parses ids', () => {
    expect(
      extractOrderedTrackIds({
        tracks: [{ id: 3 }, { id: '5' }, { id: 3 }],
      })
    ).toEqual([3, 5, 3]);
  });

  test('readPlaylistForRewrite refuses a playlist it could not fully read', async () => {
    // 98 usable ids out of a declared 100. Writing this list back would delete
    // the two entries the read dropped, while reporting a clean success.
    const tracks = Array.from({ length: 98 }, (_, i) => ({ id: i + 1 }));
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 1, title: 'Short', track_count: 100, tracks,
      }),
    };

    await expect(
      readPlaylistForRewrite(client, accessToken, refreshToken, 1)
    ).rejects.toThrow(PlaylistReadIncompleteError);

    const error = await readPlaylistForRewrite(client, accessToken, refreshToken, 1).catch((e) => e);
    expect(error.seen).toBe(98);
    expect(error.expected).toBe(100);
    expect(error.message).toMatch(/only 98 of the 100 tracks/);
  });

  test('readPlaylistForRewrite requests every access level', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 1, title: 'Whole', track_count: 1, tracks: [{ id: 7 }],
      }),
    };

    await readPlaylistForRewrite(client, accessToken, refreshToken, 1);

    expect(client.getPlaylistWithTracks).toHaveBeenCalledWith(accessToken, refreshToken, 1, { allAccess: true });
  });

  test('readPlaylistForRewrite does not refuse a playlist whose all-access read includes a blocked track', async () => {
    // The default read omits blocked tracks but track_count counts them, which
    // is what made every such playlist read "short". With all access the read
    // agrees with the count and the guard stays quiet.
    const client = {
      getPlaylistWithTracks: jest.fn(async (a, r, id, opts = {}) => ({
        id,
        track_count: 3,
        tracks: opts.allAccess ? [{ id: 1 }, { id: 2 }, { id: 3 }] : [{ id: 1 }, { id: 2 }],
      })),
    };

    const { ids } = await readPlaylistForRewrite(client, accessToken, refreshToken, 9);

    expect(ids).toEqual([1, 2, 3]);
  });

  test('readPlaylistForRewrite returns the ids when the counts agree', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 1, title: 'Whole', track_count: 3, tracks: [{ id: 7 }, { id: 8 }, { id: 9 }],
      }),
    };

    const { playlist, ids } = await readPlaylistForRewrite(client, accessToken, refreshToken, 1);

    expect(ids).toEqual([7, 8, 9]);
    expect(playlist.title).toBe('Whole');
  });

  test('readPlaylistForRewrite does not guard a playlist with no track_count', async () => {
    // No number to compare against. Inventing one would refuse valid writes.
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 1, title: 'Countless', tracks: [{ id: 7 }, { id: 'nope' }],
      }),
    };

    const { ids } = await readPlaylistForRewrite(client, accessToken, refreshToken, 1);

    expect(ids).toEqual([7]);
  });

  test('duplicate refuses to append to a playlist it could not fully read', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 10, title: 'Short', track_count: 5, tracks: [{ id: 1 }, { id: 2 }],
      }),
      addTracksToPlaylist: jest.fn(),
    };

    await expect(
      duplicateTrackBetweenPlaylists({
        accessToken, refreshToken, client, trackId: 99, targetPlaylistId: 10,
      })
    ).rejects.toThrow(PlaylistReadIncompleteError);

    expect(client.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('duplicate noop when track already in target', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 10,
        title: 'T',
        tracks: [{ id: 1 }, { id: 2 }],
      }),
      addTracksToPlaylist: jest.fn(),
    };

    const result = await duplicateTrackBetweenPlaylists({
      accessToken,
      refreshToken,
      client,
      trackId: 2,
      targetPlaylistId: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
    expect(client.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('duplicate appends track to target', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValue({
        id: 10,
        title: 'Dest',
        tracks: [{ id: 1 }],
      }),
      addTracksToPlaylist: jest.fn().mockResolvedValue({}),
    };

    const result = await duplicateTrackBetweenPlaylists({
      accessToken,
      refreshToken,
      client,
      trackId: 99,
      targetPlaylistId: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.noop).toBe(false);
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(
      accessToken,
      refreshToken,
      10,
      [1, 99]
    );
  });

  test('move refuses when either playlist read came back short', async () => {
    // Move does two full-list PUTs, so a short read on EITHER side deletes
    // whatever that read dropped. Source is complete here; target is not.
    const client = {
      getPlaylistWithTracks: jest.fn(async (_a, _r, id) => (id === 1
        ? { id: 1, title: 'src', track_count: 2, tracks: [{ id: 10 }, { id: 11 }] }
        : { id: 2, title: 'dst', track_count: 3, tracks: [{ id: 20 }, { id: 'x' }] })),
      addTracksToPlaylist: jest.fn(),
    };

    await expect(moveTrackBetweenPlaylists({
      accessToken, refreshToken, client, trackId: 10, sourcePlaylistId: 1, targetPlaylistId: 2,
    })).rejects.toBeInstanceOf(PlaylistReadIncompleteError);

    // Nothing was written to either playlist.
    expect(client.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('move rejects same source and target', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn(),
      addTracksToPlaylist: jest.fn(),
    };

    const result = await moveTrackBetweenPlaylists({
      accessToken,
      refreshToken,
      client,
      trackId: 1,
      sourcePlaylistId: 5,
      targetPlaylistId: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/different/);
    expect(client.getPlaylistWithTracks).not.toHaveBeenCalled();
  });

  test('move updates target then removes from source', async () => {
    const client = {
      getPlaylistWithTracks: jest
        .fn()
        .mockResolvedValueOnce({
          id: 1,
          title: 'Source',
          tracks: [{ id: 10 }, { id: 20 }],
        })
        .mockResolvedValueOnce({
          id: 2,
          title: 'Dest',
          tracks: [{ id: 30 }],
        }),
      addTracksToPlaylist: jest.fn().mockResolvedValue({}),
    };

    const result = await moveTrackBetweenPlaylists({
      accessToken,
      refreshToken,
      client,
      trackId: 10,
      sourcePlaylistId: 1,
      targetPlaylistId: 2,
    });

    expect(result.ok).toBe(true);
    expect(client.addTracksToPlaylist).toHaveBeenNthCalledWith(
      1,
      accessToken,
      refreshToken,
      2,
      [30, 10]
    );
    expect(client.addTracksToPlaylist).toHaveBeenNthCalledWith(
      2,
      accessToken,
      refreshToken,
      1,
      [20]
    );
  });

  test('move partial when source update fails after target succeeds', async () => {
    const client = {
      getPlaylistWithTracks: jest.fn().mockResolvedValueOnce({
        id: 1,
        title: 'Source',
        tracks: [{ id: 10 }],
      }).mockResolvedValueOnce({
        id: 2,
        title: 'Dest',
        tracks: [{ id: 30 }],
      }),
      addTracksToPlaylist: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('SC said no')),
    };

    const result = await moveTrackBetweenPlaylists({
      accessToken,
      refreshToken,
      client,
      trackId: 10,
      sourcePlaylistId: 1,
      targetPlaylistId: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.stage).toBe('source_update');
    expect(result.targetUpdated).toBe(true);
    expect(result.message).toBeTruthy();
  });

  test('move when target already has track only updates source', async () => {
    const client = {
      getPlaylistWithTracks: jest
        .fn()
        .mockResolvedValueOnce({
          id: 1,
          title: 'Source',
          tracks: [{ id: 10 }, { id: 20 }],
        })
        .mockResolvedValueOnce({
          id: 2,
          title: 'Dest',
          tracks: [{ id: 10 }, { id: 99 }],
        }),
      addTracksToPlaylist: jest.fn().mockResolvedValue({}),
    };

    const result = await moveTrackBetweenPlaylists({
      accessToken,
      refreshToken,
      client,
      trackId: 10,
      sourcePlaylistId: 1,
      targetPlaylistId: 2,
    });

    expect(result.ok).toBe(true);
    expect(client.addTracksToPlaylist).toHaveBeenNthCalledWith(
      1,
      accessToken,
      refreshToken,
      2,
      [10, 99]
    );
    expect(client.addTracksToPlaylist).toHaveBeenNthCalledWith(
      2,
      accessToken,
      refreshToken,
      1,
      [20]
    );
  });
});
