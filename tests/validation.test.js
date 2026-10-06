import {
  validateCloneFollowedPlaylists,
  validateCreateFromFollowedLikes,
  validateFollowedUserLibraryPagination,
  validateFollowingUserId,
  validateGrowthDiscover,
  validateGrowthCheckFollowbacks,
  validateGrowthEngageBatch,
  validateReverseGrowthActions,
  validateRebrandVote,
  validateEvent,
  validateBulkLike,
  validateFeedback,
  validateFeedbackPatch,
} from '../server/middleware/validation.js';

async function runValidation(middlewares, { params = {}, query = {}, body = {} } = {}) {
  const req = { params, query, body };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };

  for (const middleware of middlewares) {
    let nextCalled = false;
    await middleware(req, res, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }

  return { statusCode, payload, req };
}

describe('followed user library validators', () => {
  test('accepts a positive followed user id param', async () => {
    const result = await runValidation(validateFollowingUserId, { params: { userId: '42' } });

    expect(result.statusCode).toBeNull();
    expect(result.req.params.userId).toBe(42);
  });

  test('rejects an invalid followed user id param', async () => {
    const result = await runValidation(validateFollowingUserId, { params: { userId: '0' } });

    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toBe('Validation failed');
  });

  test('accepts followed library pagination query values', async () => {
    const result = await runValidation(validateFollowedUserLibraryPagination, {
      query: {
        limit: '25',
        next: 'https://api.soundcloud.com/users/42/likes/tracks?cursor=abc',
      },
    });

    expect(result.statusCode).toBeNull();
    expect(result.req.query.limit).toBe(25);
  });

  test('rejects followed library pagination with an invalid next cursor', async () => {
    const result = await runValidation(validateFollowedUserLibraryPagination, {
      query: { next: 'not-a-url' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('accepts selected followed likes with a title', async () => {
    const result = await runValidation(validateCreateFromFollowedLikes, {
      body: { mode: 'selected', trackIds: [1, 2, 3], title: 'Coolio Likes' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('accepts all followed likes with a target playlist', async () => {
    const result = await runValidation(validateCreateFromFollowedLikes, {
      body: { mode: 'all', targetPlaylistId: 123 },
    });

    expect(result.statusCode).toBeNull();
    expect(result.req.body.targetPlaylistId).toBe(123);
  });

  test('rejects selected followed likes without track ids', async () => {
    const result = await runValidation(validateCreateFromFollowedLikes, {
      body: { mode: 'selected', title: 'Coolio Likes' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects followed likes creation without a title or target playlist', async () => {
    const result = await runValidation(validateCreateFromFollowedLikes, {
      body: { mode: 'all' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('accepts selected followed playlist clone ids', async () => {
    const result = await runValidation(validateCloneFollowedPlaylists, {
      body: { playlistIds: [11, 12], titlePrefix: 'DJ Coolio' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('rejects too many followed playlists to clone at once', async () => {
    const result = await runValidation(validateCloneFollowedPlaylists, {
      body: { playlistIds: Array.from({ length: 21 }, (_, index) => index + 1) },
    });

    expect(result.statusCode).toBe(400);
  });
});

describe('growth discovery validators', () => {
  test('accepts valid growth discovery payload', async () => {
    const result = await runValidation(validateGrowthDiscover, {
      body: { inspirationUserIds: [1, 2], limit: 25, strategy: 'followers' },
    });
    expect(result.statusCode).toBeNull();
  });

  test('rejects empty inspirationUserIds list', async () => {
    const result = await runValidation(validateGrowthDiscover, {
      body: { inspirationUserIds: [], limit: 25 },
    });
    expect(result.statusCode).toBe(400);
  });

  test('rejects strategy not in list', async () => {
    const result = await runValidation(validateGrowthDiscover, {
      body: { inspirationUserIds: [1], strategy: 'invalid_strategy' },
    });
    expect(result.statusCode).toBe(400);
  });

  test('accepts a known genre focus slug', async () => {
    const result = await runValidation(validateGrowthDiscover, {
      body: { inspirationUserIds: [1], genre: 'house' },
    });
    expect(result.statusCode).toBeNull();
  });

  test('rejects an unknown genre focus slug', async () => {
    const result = await runValidation(validateGrowthDiscover, {
      body: { inspirationUserIds: [1], genre: 'polka' },
    });
    expect(result.statusCode).toBe(400);
  });

  test('rejects a genre focus sent as an array (element-wise validator bypass)', async () => {
    const result = await runValidation(validateGrowthDiscover, {
      body: { inspirationUserIds: [1], genre: ['house'] },
    });
    expect(result.statusCode).toBe(400);
  });

  test('accepts a valid engagement batch payload', async () => {
    const result = await runValidation(validateGrowthEngageBatch, {
      body: {
        targets: [
          { userId: 42, likeTrackId: 101, targetName: 'DJ Cool' },
          { userId: 43 },
        ],
        likeTracks: true,
        sessionLabel: 'Seed: DJ Cool',
      },
    });
    expect(result.statusCode).toBeNull();
  });

  test('rejects an engagement batch with an invalid target userId', async () => {
    const result = await runValidation(validateGrowthEngageBatch, {
      body: { targets: [{ userId: 'not_an_int' }] },
    });
    expect(result.statusCode).toBe(400);
  });

  test('rejects an engagement batch over the 50-target cap', async () => {
    const targets = Array.from({ length: 51 }, (_, i) => ({ userId: i + 1 }));
    const result = await runValidation(validateGrowthEngageBatch, {
      body: { targets },
    });
    expect(result.statusCode).toBe(400);
  });

  test('accepts valid reverse filter', async () => {
    const result = await runValidation(validateReverseGrowthActions, {
      body: { filter: { sessionId: 'sess123', actionType: 'follow' } },
    });
    expect(result.statusCode).toBeNull();
  });

  test('rejects reverse request when both actionIds and filter are absent', async () => {
    const result = await runValidation(validateReverseGrowthActions, {
      body: {},
    });
    expect(result.statusCode).toBe(400);
  });

  test('accepts an optional follow-back session id and rejects an invalid one', async () => {
    const valid = await runValidation(validateGrowthCheckFollowbacks, {
      body: { sessionId: 'sess_123' },
    });
    const invalid = await runValidation(validateGrowthCheckFollowbacks, {
      body: { sessionId: 123 },
    });

    expect(valid.statusCode).toBeNull();
    expect(invalid.statusCode).toBe(400);
  });
});

describe('rebrand vote validator', () => {
  test('accepts a vote with no write-ins', async () => {
    const result = await runValidation(validateRebrandVote, {
      body: { nameChoice: 'tracktidy', context: 'dashboard' },
    });
    expect(result.statusCode).toBeNull();
  });

  test('accepts a vote with a write-in name and a feature request', async () => {
    const result = await runValidation(validateRebrandVote, {
      body: {
        nameChoice: 'none',
        nameIdea: 'Cratewerk',
        featureIdea: 'Sort a playlist by BPM',
        context: 'post-merge',
      },
    });
    expect(result.statusCode).toBeNull();
  });

  test('rejects a nameChoice outside the shortlist', async () => {
    const result = await runValidation(validateRebrandVote, {
      body: { nameChoice: 'cratekit', context: 'dashboard' },
    });
    expect(result.statusCode).toBe(400);
  });

  test('requires a nameChoice', async () => {
    const result = await runValidation(validateRebrandVote, {
      body: { nameIdea: 'Something', context: 'dashboard' },
    });
    expect(result.statusCode).toBe(400);
  });

  test('rejects an over-long nameIdea', async () => {
    const result = await runValidation(validateRebrandVote, {
      body: { nameChoice: 'deckdig', nameIdea: 'x'.repeat(121), context: 'dashboard' },
    });
    expect(result.statusCode).toBe(400);
  });

  test('rejects an unknown context', async () => {
    const result = await runValidation(validateRebrandVote, {
      body: { nameChoice: 'deckdig', context: 'settings' },
    });
    expect(result.statusCode).toBe(400);
  });
});

describe('feature usage event validator', () => {
  test('accepts a short feature slug', async () => {
    const result = await runValidation(validateEvent, {
      body: { feature: 'playlist-cloner' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('rejects arbitrary event names', async () => {
    const result = await runValidation(validateEvent, {
      body: { feature: 'playlist cloner?playlist=123' },
    });

    expect(result.statusCode).toBe(400);
  });
});

describe('bulk like validator', () => {
  test('accepts 1-100 positive integer track ids', async () => {
    const result = await runValidation(validateBulkLike, {
      body: { trackIds: [1, 2, 3] },
    });

    expect(result.statusCode).toBeNull();
  });

  test('rejects an empty track id array', async () => {
    const result = await runValidation(validateBulkLike, {
      body: { trackIds: [] },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects more than 100 track ids', async () => {
    const result = await runValidation(validateBulkLike, {
      body: { trackIds: Array.from({ length: 101 }, (_, i) => i + 1) },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects non-positive track ids', async () => {
    const result = await runValidation(validateBulkLike, {
      body: { trackIds: [0] },
    });

    expect(result.statusCode).toBe(400);
  });
});

describe('feedback validator', () => {
  const validBody = {
    type: 'bug',
    message: 'The merge tool stalled at 400 tracks and never finished.',
    page: '/combine',
  };

  test('accepts a well-formed feedback body', async () => {
    const result = await runValidation(validateFeedback, { body: { ...validBody } });

    expect(result.statusCode).toBeNull();
  });

  test('accepts a body with no page and no email', async () => {
    const result = await runValidation(validateFeedback, {
      body: { type: 'feature', message: 'Please add a dark mode toggle to the sidebar.' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('rejects a message of 9 characters', async () => {
    // 10 is the floor: shorter than that is almost always a mis-click or a
    // test submission, and there is nothing to act on.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, message: '123456789' },
    });

    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toBe('Validation failed');
  });

  test('rejects a 9-character message padded out with whitespace', async () => {
    // .trim() runs before .isLength(), so padding cannot buy length.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, message: '          123456789          ' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects a message over 2000 characters', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, message: 'a'.repeat(2001) },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects an unknown type', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, type: 'complaint' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects a missing type', async () => {
    const result = await runValidation(validateFeedback, {
      body: { message: validBody.message },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects an absolute URL as the page', async () => {
    // page is an app route, not somewhere to smuggle a link into the inbox.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, page: 'https://evil.example.com/phish' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects a page with a query string', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, page: '/combine?playlist=123' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects a page that does not start with a slash', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, page: 'combine' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects a malformed email when one is supplied', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, email: 'not-an-address' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('accepts an empty-string email as "no email given"', async () => {
    // checkFalsy: an untouched optional input posts '' rather than being absent.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, email: '' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('accepts an empty-string page as "no page given"', async () => {
    // Same reason as email: the form posts '' when it has no route to report,
    // and an empty route is "absent", not "malformed". Without checkFalsy this
    // failed the route regex and rejected an otherwise valid submission.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, page: '' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('rejects a 10-character message made entirely of control characters', async () => {
    // The strip runs BEFORE the length check. Were it the other way round,
    // this would satisfy min:10 and then be stored as an empty message.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, message: String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8, 11, 12) },
    });

    expect(result.statusCode).toBe(400);
  });

  test('a message padded to length with control characters is measured clean', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, message: 'short' + String.fromCharCode(1, 2, 3, 4, 5, 6, 7) },
    });

    expect(result.statusCode).toBe(400);
  });

  test('strips control characters from a message that is long enough without them', async () => {
    const result = await runValidation(validateFeedback, {
      body: {
        ...validBody,
        message: 'Playback' + String.fromCharCode(0, 7) + ' stops after ten tracks.',
      },
    });

    expect(result.statusCode).toBeNull();
    expect(result.req.body.message).toBe('Playback stops after ten tracks.');
  });

  test('rejects an array type instead of letting it through element-wise', async () => {
    // express-validator 7 applies isIn() to each element, so ['bug'] passed
    // and reached Prisma as an array. The leading isString() is what stops it.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, type: ['bug'] },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects an array email instead of letting it through element-wise', async () => {
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, email: ['someone@example.com'] },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects an array website, message and page', async () => {
    for (const field of ['website', 'message', 'page']) {
      const result = await runValidation(validateFeedback, {
        body: { ...validBody, [field]: ['/combine'] },
      });

      expect(result.statusCode).toBe(400);
    }
  });

  test('a filled honeypot still passes validation', async () => {
    // The route, not the validator, decides what a filled `website` means. A
    // 400 here would tell a bot exactly which field to leave alone next time.
    const result = await runValidation(validateFeedback, {
      body: { ...validBody, website: 'http://spam.example.com' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('an empty body fails closed', async () => {
    // This is the CSRF invariant: a cross-site form-encoded post parses to an
    // empty req.body under express.json(), and the validator rejects it.
    const result = await runValidation(validateFeedback, { body: {} });

    expect(result.statusCode).toBe(400);
  });
});

describe('admin feedback patch validator', () => {
  test('accepts a status change', async () => {
    const result = await runValidation(validateFeedbackPatch, {
      params: { id: 'fb-1' },
      body: { status: 'done' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('accepts an admin note', async () => {
    const result = await runValidation(validateFeedbackPatch, {
      params: { id: 'fb-1' },
      body: { adminNote: 'Reproduced — fixed in the next deploy.' },
    });

    expect(result.statusCode).toBeNull();
  });

  test('rejects an unknown status', async () => {
    const result = await runValidation(validateFeedbackPatch, {
      params: { id: 'fb-1' },
      body: { status: 'archived' },
    });

    expect(result.statusCode).toBe(400);
  });

  test('rejects an admin note over 2000 characters', async () => {
    const result = await runValidation(validateFeedbackPatch, {
      params: { id: 'fb-1' },
      body: { adminNote: 'a'.repeat(2001) },
    });

    expect(result.statusCode).toBe(400);
  });
});
