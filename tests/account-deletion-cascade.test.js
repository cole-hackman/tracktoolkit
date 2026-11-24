import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// The account-deletion route (DELETE /api/auth/account) relies on a single
// prisma.user.delete cascading to every table that stores per-user data.
// This test guards that guarantee: any model that relates to User must
// declare onDelete: Cascade, so adding a new per-user table without cascade
// fails CI instead of silently orphaning data (or blocking deletion with an
// FK violation).

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');

function extractModels(source) {
  const models = [];
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    models.push({ name: m[1], body: m[2] });
  }
  return models;
}

describe('account deletion cascade coverage', () => {
  const models = extractModels(schema);

  it('parses the schema', () => {
    expect(models.length).toBeGreaterThan(5);
  });

  // Same scope note as tests/routes/export.test.js, which parses the schema
  // the same way: this recognises the one relation spelling today's models
  // use. A per-user table whose foreign key is named something other than
  // `userId`, or reached only through a join table, is invisible to both. Widen
  // them together if that ever changes.
  const userRelated = models.filter(
    model => model.name !== 'User' && /@relation\(fields:\s*\[userId\]/.test(model.body)
  );

  it('finds the per-user tables', () => {
    const names = userRelated.map(model => model.name).sort();
    // Every table that stores per-user data today. If this list shrinks
    // unexpectedly, a relation was probably reshaped — re-verify deletion.
    for (const expected of [
      'BetaSignup',
      'ExperimentExposure',
      'Feedback',
      'GrowthAction',
      'LibraryCachePage',
      'LibraryCacheState',
      'OperationLog',
      'RebrandVote',
      'SurveyResponse',
      'Token',
      'chat_conversations',
      'indexed_likes',
      'indexed_playlist_tracks',
      'library_snapshots',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(
    userRelated.map(model => [model.name, model.body])
  )('%s cascades on user deletion', (_name, body) => {
    const relationLine = body.match(/@relation\(fields:\s*\[userId\][^)]*\)/)[0];
    expect(relationLine).toContain('onDelete: Cascade');
  });

  it('chat_messages cascades via its conversation', () => {
    const chatMessages = models.find(model => model.name === 'chat_messages');
    expect(chatMessages).toBeDefined();
    expect(chatMessages.body).toContain('onDelete: Cascade');
  });

  it('catalog tables are deliberately NOT per-user', () => {
    const track = models.find(model => model.name === 'Track');
    const playlist = models.find(model => model.name === 'Playlist');
    expect(track.body).not.toContain('userId');
    expect(playlist.body).not.toContain('userId');
  });
});
