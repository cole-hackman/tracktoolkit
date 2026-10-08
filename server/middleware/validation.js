import { body, param, query, validationResult } from 'express-validator';
import { parseKeywords } from '../lib/playlist-search.js';
import { isAllowedDownloadUrl } from '../lib/download-utils.js';
import { GENRE_FOCUS_SLUGS } from '../lib/genres.js';
import { isSoundCloudApiUrl } from '../lib/sc-cursor.js';

function validateSoundCloudUrl(value) {
  if (!value) return true;
  const normalized = value.startsWith('http') ? value : `https://${value}`;
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (!/(^|\.)soundcloud\.com$/.test(host) && host !== 'on.soundcloud.com') {
      throw new Error('URL must be a SoundCloud domain');
    }
    return true;
  } catch {
    throw new Error('Invalid URL format');
  }
}

/**
 * Middleware to handle validation errors
 */
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.path || err.param,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
};

/**
 * Validation rules for playlist ID parameter
 */
export const validatePlaylistId = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Playlist ID must be a positive integer')
    .toInt(),
  handleValidationErrors
];

/**
 * Validation rules for pagination query parameters
 */
export const validatePagination = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Limit must be between 1 and 200')
    .toInt(),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Offset must be a non-negative integer')
    .toInt(),
  handleValidationErrors
];

/**
 * Validation rules for resolve endpoint
 */
export const validateResolve = [
  body('url')
    .optional()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('URL must be between 1 and 2048 characters')
    .custom((value) => validateSoundCloudUrl(value)),
  query('url')
    .optional()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('URL must be between 1 and 2048 characters')
    .custom((value) => validateSoundCloudUrl(value)),
  handleValidationErrors
];

/**
 * Validation rules for merge playlists endpoint
 */
export const validateMergePlaylists = [
  body('sourcePlaylistIds')
    .isArray({ min: 2 })
    .withMessage('At least 2 playlist IDs are required')
    .custom((value) => {
      if (!Array.isArray(value) || value.length < 2) {
        throw new Error('sourcePlaylistIds must be an array with at least 2 items');
      }
      if (value.length > 20) {
        throw new Error('Cannot merge more than 20 playlists at once');
      }
      // Validate each ID is a positive integer
      for (const id of value) {
        const numId = typeof id === 'string' ? parseInt(id, 10) : id;
        if (!Number.isInteger(numId) || numId < 1) {
          throw new Error('All playlist IDs must be positive integers');
        }
      }
      return true;
    }),
  body('targetPlaylistId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('targetPlaylistId must be a positive integer')
    .toInt(),
  body('deleteAfterMerge')
    .optional()
    .isBoolean()
    .withMessage('deleteAfterMerge must be a boolean')
    .toBoolean(),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters')
    .escape(),
  // Custom: title is required when targetPlaylistId is absent
  body('title').custom((value, { req }) => {
    if (!req.body.targetPlaylistId && !value) {
      throw new Error('title is required when targetPlaylistId is not provided');
    }
    return true;
  }),
  // Custom: targetPlaylistId must not appear in sourcePlaylistIds (Requirement 1.6)
  body('targetPlaylistId').custom((value, { req }) => {
    if (value && Array.isArray(req.body.sourcePlaylistIds)) {
      const sourceIds = req.body.sourcePlaylistIds.map((id) =>
        typeof id === 'string' ? parseInt(id, 10) : id
      );
      if (sourceIds.includes(value)) {
        throw new Error('targetPlaylistId must not be one of the sourcePlaylistIds');
      }
    }
    return true;
  }),
  handleValidationErrors
];

/**
 * GET /playlists/:id — `access=all` asks for blocked tracks as well. The only
 * accepted value is `all`; `.isString()` leads because express-validator
 * applies a validator element-wise to an array, so `?access=all&access=all`
 * would otherwise satisfy `.isIn`.
 */
export const validateGetPlaylist = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Playlist ID must be a positive integer')
    .toInt(),
  query('access')
    .optional()
    .isString()
    .isIn(['all'])
    .withMessage('access must be "all" when provided'),
  handleValidationErrors
];

/**
 * Validation rules for update playlist endpoint
 */
export const validateUpdatePlaylist = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Playlist ID must be a positive integer')
    .toInt(),
  body('tracks')
    .isArray()
    .withMessage('tracks must be an array')
    .custom((value) => {
      if (!Array.isArray(value)) {
        throw new Error('tracks must be an array');
      }
      if (value.length === 0) {
        throw new Error('tracks array cannot be empty');
      }
      if (value.length > 500) {
        throw new Error('Cannot have more than 500 tracks');
      }
      // Validate each track ID is a positive integer
      for (const trackId of value) {
        const numId = typeof trackId === 'string' ? parseInt(trackId, 10) : trackId;
        if (!Number.isInteger(numId) || numId < 1) {
          throw new Error('All track IDs must be positive integers');
        }
      }
      return true;
    }),
  // The ids the client is deliberately taking out of the playlist. The route
  // refuses a write that would drop anything the server read that is in
  // neither `tracks` nor `remove`.
  body('remove')
    .optional()
    .isArray({ max: 500 })
    .withMessage('remove must be an array of at most 500 track IDs')
    .custom((value, { req }) => {
      const toId = (v) => (typeof v === 'string' ? parseInt(v, 10) : v);
      for (const trackId of value) {
        const numId = toId(trackId);
        if (!Number.isInteger(numId) || numId < 1) {
          throw new Error('All remove IDs must be positive integers');
        }
      }
      const keep = new Set(
        (Array.isArray(req.body.tracks) ? req.body.tracks : []).map(toId),
      );
      if (value.some((trackId) => keep.has(toId(trackId)))) {
        throw new Error('A track cannot be in both tracks and remove');
      }
      return true;
    }),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters')
    .escape(),
  handleValidationErrors
];

/**
 * POST /api/playlists/transfer-track — move or duplicate one track between playlists
 */
export const validatePlaylistTrackTransfer = [
  body('action')
    .isIn(['move', 'duplicate'])
    .withMessage('action must be move or duplicate'),
  body('trackId')
    .isInt({ min: 1 })
    .withMessage('trackId must be a positive integer')
    .toInt(),
  body('sourcePlaylistId')
    .if(body('action').equals('move'))
    .isInt({ min: 1 })
    .withMessage('sourcePlaylistId is required for move action and must be a positive integer')
    .toInt(),
  body('sourcePlaylistId')
    .if(body('action').not().equals('move'))
    .optional()
    .isInt({ min: 1 })
    .withMessage('sourcePlaylistId must be a positive integer')
    .toInt(),
  body('targetPlaylistId')
    .isInt({ min: 1 })
    .withMessage('targetPlaylistId must be a positive integer')
    .toInt(),
  handleValidationErrors
];

/**
 * Validation rules for create playlist from likes endpoint
 */
export const validateCreateFromLikes = [
  body('trackIds')
    .isArray({ min: 1 })
    .withMessage('At least one track ID is required')
    .custom((value) => {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error('trackIds must be a non-empty array');
      }
      if (value.length > 5000) {
        throw new Error('Cannot have more than 5000 tracks in one request');
      }
      // Validate each track ID is a positive integer
      for (const trackId of value) {
        const numId = typeof trackId === 'string' ? parseInt(trackId, 10) : trackId;
        if (!Number.isInteger(numId) || numId < 1) {
          throw new Error('All track IDs must be positive integers');
        }
      }
      return true;
    }),
  body('targetPlaylistId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('targetPlaylistId must be a positive integer')
    .toInt(),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters')
    .escape(),
  // Custom: title is required when targetPlaylistId is absent
  body('title').custom((value, { req }) => {
    if (!req.body.targetPlaylistId && !value) {
      throw new Error('title is required when targetPlaylistId is not provided');
    }
    return true;
  }),
  handleValidationErrors
];

/**
 * Validation rules for likes pagination
 */
/**
 * Offset pagination for collections that have no upstream cursor (reposts,
 * which we assemble ourselves from two crawls).
 */
export const validateOffsetPagination = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Limit must be between 1 and 200')
    .toInt(),
  query('offset')
    .optional()
    .isInt({ min: 0, max: 100000 })
    .withMessage('Offset must be between 0 and 100000')
    .toInt(),
  handleValidationErrors,
];

export const validateLikesPagination = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Limit must be between 1 and 200')
    .toInt(),
  query('next')
    .optional()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('Next cursor must be a valid URL')
    .custom((value) => {
      if (!value) return true;
      // A SoundCloud API next_href and nothing else; the route also checks it
      // continues the same request (lib/sc-cursor.js).
      if (!isSoundCloudApiUrl(value)) throw new Error('Next cursor must be a SoundCloud API URL');
      return true;
    }),
  handleValidationErrors
];

/**
 * Validation rules for followed-user library routes.
 */
export const validateFollowingUserId = [
  param('userId')
    .isInt({ min: 1 })
    .withMessage('User ID must be a positive integer')
    .toInt(),
  handleValidationErrors
];

export const validateFollowedUserLibraryPagination = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Limit must be between 1 and 200')
    .toInt(),
  query('next')
    .optional()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('Next cursor must be a valid URL')
    .custom((value) => {
      if (!value) return true;
      // A SoundCloud API next_href and nothing else; the route also checks it
      // continues the same request (lib/sc-cursor.js).
      if (!isSoundCloudApiUrl(value)) throw new Error('Next cursor must be a SoundCloud API URL');
      return true;
    }),
  handleValidationErrors
];

export const validateCreateFromFollowedLikes = [
  body('mode')
    .isIn(['selected', 'all'])
    .withMessage('mode must be selected or all'),
  body('trackIds')
    .optional()
    .isArray({ min: 1, max: 5000 })
    .withMessage('trackIds must be an array with 1-5000 items'),
  body('trackIds.*')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Each trackId must be a positive integer'),
  body('targetPlaylistId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('targetPlaylistId must be a positive integer')
    .toInt(),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters')
    .escape(),
  body('trackIds').custom((value, { req }) => {
    if (req.body.mode === 'selected' && (!Array.isArray(value) || value.length === 0)) {
      throw new Error('trackIds is required when mode is selected');
    }
    return true;
  }),
  body('title').custom((value, { req }) => {
    if (!req.body.targetPlaylistId && !value) {
      throw new Error('title is required when targetPlaylistId is not provided');
    }
    return true;
  }),
  handleValidationErrors
];

export const validateCloneFollowedPlaylists = [
  body('playlistIds')
    .isArray({ min: 1, max: 20 })
    .withMessage('playlistIds must be an array with 1-20 items'),
  body('playlistIds.*')
    .isInt({ min: 1 })
    .withMessage('Each playlistId must be a positive integer'),
  body('titlePrefix')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title prefix must be between 1 and 200 characters')
    .escape(),
  handleValidationErrors
];

/**
 * Validate batch resolve request
 */
export const validateBatchResolve = [
  body('urls')
    .isArray({ min: 1, max: 50 })
    .withMessage('urls must be an array with 1-50 items'),
  body('urls.*')
    .isString()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('Each URL must be a non-empty string')
    .custom((value) => validateSoundCloudUrl(value)),
  handleValidationErrors
];

/**
 * Validate clone playlist request
 */
export const validateClonePlaylist = [
  body('url')
    .isString()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('url must be a valid SoundCloud URL string')
    .custom((value) => validateSoundCloudUrl(value)),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters')
    .escape(),
  handleValidationErrors
];

/**
 * Validate activities request
 */
export const validateActivities = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 500 })
    .withMessage('Limit must be between 1 and 500')
    .toInt(),
  handleValidationErrors
];

/**
 * Validate bulk unlike request
 */
export const validateBulkUnlike = [
  body('trackIds')
    .isArray({ min: 1, max: 100 })
    .withMessage('trackIds must be an array with 1-100 items'),
  body('trackIds.*')
    .isInt({ min: 1 })
    .withMessage('Each trackId must be a positive integer'),
  handleValidationErrors
];

/**
 * Validate bulk like request
 */
export const validateBulkLike = [
  body('trackIds')
    .isArray({ min: 1, max: 100 })
    .withMessage('trackIds must be an array with 1-100 items'),
  body('trackIds.*')
    .isInt({ min: 1 })
    .withMessage('Each trackId must be a positive integer'),
  handleValidationErrors
];

/**
 * POST /api/downloads/links — up to 10 SoundCloud track download URLs per
 * call. Small on purpose: the CDN links that come back are signed and
 * short-lived, so the queue asks just before it uses them. `.isString()`
 * first, as everywhere: express-validator applies validators element-wise.
 */
export const validateDownloadLinks = [
  body('urls')
    .isArray({ min: 1, max: 10 })
    .withMessage('urls must be an array with 1-10 items'),
  body('urls.*')
    .isString()
    .bail()
    .custom((value) => isAllowedDownloadUrl(value))
    .withMessage('Each url must be a SoundCloud track download URL'),
  handleValidationErrors
];

/**
 * GET /api/users/:userUrn/related — the segment is interpolated into a
 * SoundCloud path, so only a numeric id or soundcloud:users:N gets through.
 */
export const validateUserUrnParam = [
  param('userUrn')
    .matches(/^(?:soundcloud:users:)?\d{1,20}$/)
    .withMessage('userUrn must be a SoundCloud user id'),
  handleValidationErrors
];

/**
 * Validate bulk unfollow request
 */
export const validateBulkUnfollow = [
  body('userIds')
    .isArray({ min: 1, max: 100 })
    .withMessage('userIds must be an array with 1-100 items'),
  body('userIds.*')
    .isInt({ min: 1 })
    .withMessage('Each userId must be a positive integer'),
  handleValidationErrors
];

/**
 * Validate bulk unrepost request
 */
export const validateBulkUnrepost = [
  body('items')
    .isArray({ min: 1, max: 100 })
    .withMessage('items must be an array with 1-100 items'),
  body('items.*.id')
    .isInt({ min: 1 })
    .withMessage('Each item id must be a positive integer'),
  body('items.*.resourceType')
    .isIn(['track', 'playlist'])
    .withMessage('Each item resourceType must be track or playlist'),
  handleValidationErrors
];

/**
 * Validation rules for track search endpoint (GET /api/tracks/search)
 */
export const validateTrackSearch = [
  query('genres')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('genres must be at most 200 characters'),
  query('tags')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('tags must be at most 200 characters'),
  query('q')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('q must be at most 200 characters'),
  query('bpm_from')
    .optional()
    .isInt({ min: 1, max: 300 })
    .withMessage('bpm_from must be an integer between 1 and 300')
    .toInt(),
  query('bpm_to')
    .optional()
    .isInt({ min: 1, max: 300 })
    .withMessage('bpm_to must be an integer between 1 and 300')
    .toInt(),
  query('duration_from')
    .optional()
    .isInt({ min: 0 })
    .withMessage('duration_from must be a non-negative integer')
    .toInt(),
  query('duration_to')
    .optional()
    .isInt({ min: 0 })
    .withMessage('duration_to must be a non-negative integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('limit must be between 1 and 200')
    .toInt(),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('offset must be a non-negative integer')
    .toInt(),
  // Require at least one of genres, tags, or q
  query('genres').custom((value, { req }) => {
    if (!value && !req.query.tags && !req.query.q) {
      throw new Error('At least one of genres, tags, or q is required');
    }
    return true;
  }),
  // Validate bpm_from <= bpm_to when both provided
  query('bpm_from').custom((value, { req }) => {
    if (value && req.query.bpm_to) {
      const from = Number(value);
      const to = Number(req.query.bpm_to);
      if (from > to) {
        throw new Error('bpm_from must be less than or equal to bpm_to');
      }
    }
    return true;
  }),
  // Validate duration_from <= duration_to when both provided
  query('duration_from').custom((value, { req }) => {
    if (value && req.query.duration_to) {
      const from = Number(value);
      const to = Number(req.query.duration_to);
      if (from > to) {
        throw new Error('duration_from must be less than or equal to duration_to');
      }
    }
    return true;
  }),
  handleValidationErrors
];

/**
 * Validation rules for delete playlist endpoint (DELETE /api/playlists/:id)
 */
export const validateDeletePlaylist = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Playlist ID must be a positive integer')
    .toInt(),
  handleValidationErrors
];

/**
 * Validation rules for monetization survey submission
 */
export const validateSurveySubmit = [
  body('preference')
    .isIn(['ads', 'pro', 'donation', 'none', 'other'])
    .withMessage('preference must be one of: ads, pro, donation, none, other'),
  body('lifetimeInterest')
    .optional({ nullable: true })
    .isIn(['interested', 'not_interested', 'maybe'])
    .withMessage('lifetimeInterest must be interested, not_interested, or maybe'),
  body('comment')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 2000 })
    .withMessage('comment must be a string of at most 2000 characters'),
  body('context')
    .isIn(['dashboard', 'post-merge', 'post-from-likes'])
    .withMessage('context must be dashboard, post-merge, or post-from-likes'),
  body('trackCount')
    .optional({ nullable: true })
    .isInt({ min: 0, max: 100000 })
    .withMessage('trackCount must be an integer between 0 and 100000')
    .toInt(),
  handleValidationErrors
];

/**
 * Validation for lightweight feature-usage events (POST /api/events).
 * `feature` is a short slug; the route namespaces it as `view:<feature>`.
 */
export const validateEvent = [
  body('feature')
    .isString()
    .trim()
    .matches(/^[a-z0-9-]{2,40}$/)
    .withMessage('feature must be a slug (a-z, 0-9, dashes; 2-40 chars)'),
  handleValidationErrors
];

/**
 * Validation for the SongSwipe beta signup / feedback survey
 * (POST /api/feedback/survey). Email is required only when wantsBeta is true.
 */
/**
 * Rebrand name vote — now closed (routes/feedback.js answers 410), kept so
 * the POST still fails closed at the validator for non-JSON bodies. The
 * slugs are the shortlist voters saw; REBRAND_NAME_ORDER in the admin page
 * mirrors it for the read-only tally. The client modal is gone.
 */
export const REBRAND_NAME_SLUGS = [
  'tracktidy',
  'tracktoolkit',
  'deckdig',
  'sortwave',
  'deckhaul',
  'none',
];

/**
 * Library audit paging. The audit fetches every playlist's full track list, so
 * the page size stays small; offset is what lets a user walk a library larger
 * than one page (playlists 20-40, 40-60, and so on).
 */
export const validateLibraryAudit = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be between 1 and 50')
    .toInt(),
  query('offset')
    .optional()
    .isInt({ min: 0, max: 10000 })
    .withMessage('offset must be between 0 and 10000')
    .toInt(),
  handleValidationErrors
];

/**
 * Keyword search across playlist track lists. Same paging shape as the audit,
 * for the same reason — each page pulls full track lists from SoundCloud.
 */
export const validatePlaylistTrackSearch = [
  query('q')
    .isString()
    .withMessage('q is required')
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage('q must be 2-200 characters')
    // The whole-string bound above is not the bound that matters: "a,b" is
    // four characters and passes it, then splits into two one-character terms
    // that match most of the library. Each term has to clear the floor.
    .custom((q) => parseKeywords(q).every((keyword) => keyword.length >= 2))
    .withMessage('each keyword must be at least 2 characters'),
  query('playlistId')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('playlistId must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be between 1 and 50')
    .toInt(),
  query('offset')
    .optional()
    .isInt({ min: 0, max: 10000 })
    .withMessage('offset must be between 0 and 10000')
    .toInt(),
  handleValidationErrors
];

/**
 * Bulk removal of tracks from playlists. Capped at 20 playlists and 200 track
 * removals per request: each playlist costs a read plus a paced write, so a
 * larger batch would sit past any sane request timeout.
 */
export const validateBulkRemovePlaylistTracks = [
  body('items')
    .isArray({ min: 1, max: 20 })
    .withMessage('items must be an array with 1-20 entries'),
  body('items.*.playlistId')
    .isInt({ min: 1 })
    .withMessage('Each playlistId must be a positive integer')
    .toInt(),
  body('items.*.trackIds')
    .isArray({ min: 1, max: 500 })
    .withMessage('Each trackIds must be an array with 1-500 items'),
  body('items.*.trackIds.*')
    .isInt({ min: 1 })
    .withMessage('Each trackId must be a positive integer')
    .toInt(),
  body('items').custom((items) => {
    const total = items.reduce(
      (sum, item) => sum + (Array.isArray(item?.trackIds) ? item.trackIds.length : 0),
      0
    );
    if (total > 200) {
      throw new Error('Cannot remove more than 200 tracks in one request');
    }
    const seen = new Set();
    for (const item of items) {
      const id = String(item?.playlistId);
      if (seen.has(id)) {
        throw new Error('Each playlist may appear only once per request');
      }
      seen.add(id);
    }
    return true;
  }),
  handleValidationErrors
];

/**
 * Bulk copy of tracks into one existing playlist.
 */
export const validateBulkAddPlaylistTracks = [
  body('targetPlaylistId')
    .isInt({ min: 1 })
    .withMessage('targetPlaylistId must be a positive integer')
    .toInt(),
  body('trackIds')
    .isArray({ min: 1, max: 200 })
    .withMessage('trackIds must be an array with 1-200 items'),
  body('trackIds.*')
    .isInt({ min: 1 })
    .withMessage('Each trackId must be a positive integer')
    .toInt(),
  handleValidationErrors
];

export const validateRebrandVote = [
  body('nameChoice')
    .isIn(REBRAND_NAME_SLUGS)
    .withMessage('nameChoice is not one of the shortlisted names'),
  body('nameIdea')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 120 })
    .withMessage('nameIdea must be at most 120 characters'),
  body('featureIdea')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 2000 })
    .withMessage('featureIdea must be at most 2000 characters'),
  body('context')
    .isIn(['dashboard', 'post-merge', 'post-from-likes'])
    .withMessage('context must be dashboard, post-merge, or post-from-likes'),
  handleValidationErrors
];

/**
 * Validation rules for discover suggested follows (POST /api/growth/discover)
 */
export const validateGrowthDiscover = [
  body('inspirationUserIds')
    .isArray({ min: 1, max: 5 })
    .withMessage('inspirationUserIds must be an array of 1 to 5 items')
    .custom((value) => {
      for (const id of value) {
        const numId = typeof id === 'string' ? parseInt(id, 10) : id;
        if (!Number.isInteger(numId) || numId < 1) {
          throw new Error('All inspiration user IDs must be positive integers');
        }
      }
      return true;
    }),
  body('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be an integer between 1 and 100')
    .toInt(),
  body('strategy')
    .optional()
    .isIn(['followers', 'followings', 'both'])
    .withMessage('strategy must be one of: followers, followings, both'),
  // .isString() leads: express-validator applies validators element-wise to
  // an array, so `genre: ['house']` would otherwise satisfy .isIn().
  body('genre')
    .optional()
    .isString()
    .withMessage('genre must be a string')
    .isIn(GENRE_FOCUS_SLUGS)
    .withMessage('genre must be one of the supported genre focus options'),
  handleValidationErrors
];

/** Validation rules for a scoped or full follow-back check. */
export const validateGrowthCheckFollowbacks = [
  body('sessionId')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage('sessionId must be a string between 1 and 120 characters'),
  handleValidationErrors
];

/**
 * Validation rules for engagement batches (POST /api/growth/engage)
 */
export const validateGrowthEngageBatch = [
  body('targets')
    .isArray({ min: 1, max: 50 })
    .withMessage('targets must be an array of 1 to 50 items'),
  body('targets.*.userId')
    .isInt({ min: 1 })
    .withMessage('Each target userId must be a positive integer')
    .toInt(),
  body('targets.*.likeTrackId')
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage('likeTrackId must be a positive integer')
    .toInt(),
  body('targets.*.targetName')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('targetName must be at most 200 characters'),
  body('targets.*.targetAvatar')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 1, max: 2048 })
    .withMessage('targetAvatar must be a valid URL'),
  body('targets.*.targetFollowers')
    .optional({ nullable: true })
    .isInt({ min: 0 })
    .toInt(),
  body('targets.*.targetFollowings')
    .optional({ nullable: true })
    .isInt({ min: 0 })
    .toInt(),
  body('likeTracks')
    .optional()
    .isBoolean()
    .withMessage('likeTracks must be a boolean')
    .toBoolean(),
  body('sessionLabel')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('sessionLabel must be at most 200 characters'),
  body('inspirationIds')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('inspirationIds must be at most 200 characters'),
  body('inspirationNames')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('inspirationNames must be at most 500 characters'),
  handleValidationErrors
];

/**
 * Validation rules for reversing growth actions (POST /api/growth/reverse)
 */
export const validateReverseGrowthActions = [
  body('actionIds')
    .optional()
    .isArray()
    .withMessage('actionIds must be an array'),
  body('filter')
    .optional()
    .isObject()
    .withMessage('filter must be an object'),
  body('filter.sessionId')
    .optional()
    .isString()
    .withMessage('filter.sessionId must be a string'),
  body('filter.followedBack')
    .optional()
    .isBoolean()
    .withMessage('filter.followedBack must be a boolean'),
  body('filter.actionType')
    .optional()
    .isIn(['follow', 'like'])
    .withMessage('filter.actionType must be follow or like'),
  // Custom check: require either actionIds or filter
  body().custom((value) => {
    if (!value.actionIds && !value.filter) {
      throw new Error('Either actionIds or filter must be provided');
    }
    return true;
  }),
  handleValidationErrors
];

/**
 * The in-app feedback vocabulary. Exported so the routes, the admin patch
 * validator and the Prisma model's comments all agree on one list instead of
 * three drifting copies — the columns are plain strings, so nothing at the
 * database level enforces these.
 */
export const FEEDBACK_TYPES = ['bug', 'feature', 'other'];
export const FEEDBACK_STATUSES = ['new', 'seen', 'done', 'spam'];

/**
 * Every C0 control character except the two that are legitimate in a
 * multi-line message: \n (0x0A) and \t (0x09). \r (0x0D) IS stripped, so a
 * CRLF body normalizes to LF — otherwise the identical report pasted from a
 * Windows client would hash differently and slip past the duplicate check.
 */
const C0_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F]/g;

/**
 * Remove control characters from a submitted string.
 *
 * Used as an express-validator sanitizer so it runs BEFORE the length check:
 * otherwise a message of ten control characters satisfies `min: 10`, then
 * strips down to the empty string and is stored as a blank row. The route
 * applies it again as belt-and-braces, since it is the last thing standing
 * between user text and the database.
 */
export function stripControlChars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(C0_CONTROL_CHARS, '');
}

/**
 * Validation rules for POST /api/feedback.
 *
 * This runs BEFORE the per-user rate limiters on the route, for the same
 * reason validateRebrandVote runs before the closed-campaign gate: a
 * cross-site form-encoded post parses to an empty req.body under
 * express.json(), and the validator is what turns that into a 400. Moving it
 * behind the limiters would spend a user's feedback budget on requests they
 * never made.
 *
 * `website` is the honeypot. It validates successfully — the route, not the
 * validator, decides what a filled-in one means, so a bot gets the same
 * shaped answer as a human rather than a 400 that tells it which field to
 * leave alone next time.
 *
 * Every field leads with `.isString()`, including the two that look like they
 * do not need it. express-validator 7 applies a validator element-wise to an
 * array, so `{ type: ['bug'] }` satisfies `.isIn(FEEDBACK_TYPES)` and
 * `{ email: ['a@b.co'] }` satisfies `.isEmail()` — both would then reach
 * Prisma as arrays and 500 on a type error. `.isString()` checks the value as
 * a whole and is the only thing that closes that door.
 */
export const validateFeedback = [
  body('type')
    .isString()
    .withMessage('type must be a string')
    .isIn(FEEDBACK_TYPES)
    .withMessage(`type must be one of: ${FEEDBACK_TYPES.join(', ')}`),
  body('message')
    .isString()
    .withMessage('message must be a string')
    // Strip BEFORE measuring, or ten control characters pass `min: 10` and
    // then collapse to an empty stored message.
    .customSanitizer(stripControlChars)
    .trim()
    .isLength({ min: 10, max: 2000 })
    .withMessage('message must be between 10 and 2000 characters'),
  body('page')
    // checkFalsy: an untouched optional input posts '' rather than being
    // absent, and an empty route is "no route", not a malformed one.
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('page must be a string')
    .trim()
    .matches(/^\/[a-z0-9\-\/]{0,199}$/)
    .withMessage('page must be an app route path'),
  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('email must be a string')
    .isEmail()
    .withMessage('email must be a valid email address')
    .normalizeEmail()
    .isLength({ max: 254 })
    .withMessage('email must be at most 254 characters'),
  body('website')
    .optional()
    .isString()
    .withMessage('website must be a string')
    .isLength({ max: 200 })
    .withMessage('website must be at most 200 characters'),
  handleValidationErrors
];

/**
 * Validation rules for PATCH /api/admin/feedback-items/:id — triage only.
 * Nothing the user wrote is editable from here; status and adminNote are the
 * only two columns this route may touch.
 */
export const validateFeedbackPatch = [
  param('id')
    .isString()
    .withMessage('id must be a string')
    .trim()
    .isLength({ min: 1, max: 64 })
    .withMessage('id must be between 1 and 64 characters'),
  body('status')
    .optional()
    // .isString() FIRST, as everywhere else in this file: express-validator 7
    // applies a validator element-wise to an array, so `{ status: ['new'] }`
    // satisfies .isIn() and then reaches Prisma as an array.
    .isString()
    .withMessage('status must be a string')
    .isIn(FEEDBACK_STATUSES)
    .withMessage(`status must be one of: ${FEEDBACK_STATUSES.join(', ')}`),
  body('adminNote')
    .optional({ nullable: true })
    .isString()
    .withMessage('adminNote must be a string')
    .isLength({ max: 2000 })
    .withMessage('adminNote must be at most 2000 characters'),
  handleValidationErrors
];

/**
 * Admin catalog re-resolve: an explicit list of track ids to refetch from
 * SoundCloud. Capped at 200 (four enrichment batches) so one click cannot
 * queue an unbounded crawl.
 */
export const validateAdminReResolve = [
  body('trackIds')
    .isArray({ min: 1, max: 200 })
    .withMessage('trackIds must be an array with 1-200 items'),
  body('trackIds.*')
    .isInt({ min: 1 })
    .withMessage('Each trackId must be a positive integer'),
  handleValidationErrors
];
