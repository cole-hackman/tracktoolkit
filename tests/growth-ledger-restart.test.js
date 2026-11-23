import { jest } from '@jest/globals';

/**
 * What the follow budget still knows after the process restarts (every deploy
 * is one). `getGrowthBudget` takes the stricter of two sources:
 *
 *   - GrowthAction rows, keyed by the internal User.id. They survive a
 *     restart and cascade-delete with the account.
 *   - the in-memory ledger, keyed by the SoundCloud id. It survives account
 *     deletion and is empty after a restart.
 *
 * So a restart costs exactly what only the ledger knew. These pin both
 * halves: the first two must keep passing; the last three describe the
 * accepted limit (CLAUDE.md, Growth) and should be rewritten, not deleted,
 * if the ledger is ever made durable.
 */

const SC_ID = 4242;

/** A GrowthAction table in memory, answering the two queries the budget makes. */
function table() {
  const rows = [];
  return {
    rows,
    add: (userId, actionType, at = Date.now()) => rows.push({ userId, actionType, createdAt: new Date(at), sessionId: 'sess_1' }),
    deleteUser: (userId) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].userId === userId) rows.splice(i, 1);
    },
    prisma: {
      growthAction: {
        count: async ({ where }) => rows.filter((r) => r.userId === where.userId
          && r.actionType === where.actionType
          && r.createdAt >= where.createdAt.gte).length,
        findFirst: async ({ where }) => {
          const mine = rows.filter((r) => r.userId === where.userId).sort((a, b) => b.createdAt - a.createdAt);
          return mine[0] ? { createdAt: mine[0].createdAt, sessionId: mine[0].sessionId } : null;
        },
      },
    },
  };
}

/** A new process: the module is loaded again and its ledger starts empty. */
async function boot() {
  jest.resetModules();
  return import('../server/lib/growth-engine.js');
}

describe('after a restart, what the rows knew is still enforced', () => {
  test('an account that was not deleted is still at its cap', async () => {
    const db = table();
    const before = await boot();
    for (let i = 0; i < before.GROWTH_DAILY_FOLLOW_CAP; i += 1) {
      before.recordGrowthEvent(SC_ID, 'follow');
      db.add('user-a', 'follow');
    }

    const after = await boot();
    const budget = await after.getGrowthBudget(db.prisma, 'user-a', SC_ID);

    expect(budget.used24h).toBe(after.GROWTH_DAILY_FOLLOW_CAP);
    expect(budget.remaining).toBe(0);
  });

  test('the cooldown that runs from the last row is still running', async () => {
    const db = table();
    const before = await boot();
    before.recordGrowthEvent(SC_ID, 'follow');
    db.add('user-a', 'follow');

    const after = await boot();
    const budget = await after.getGrowthBudget(db.prisma, 'user-a', SC_ID);

    expect(budget.cooldownRemainingMs).toBeGreaterThan(after.GROWTH_SESSION_COOLDOWN_MS - 5000);
  });
});

describe('after a restart, what only the ledger knew is gone', () => {
  test('delete the account, log in again, restart: the budget is back to the full cap', async () => {
    const db = table();
    const before = await boot();
    for (let i = 0; i < before.GROWTH_DAILY_FOLLOW_CAP; i += 1) {
      before.recordGrowthEvent(SC_ID, 'follow');
      db.add('user-a', 'follow');
    }
    db.deleteUser('user-a');                      // the cascade
    // Same process: the ledger still refuses the new User row.
    expect((await before.getGrowthBudget(db.prisma, 'user-a-new', SC_ID)).remaining).toBe(0);

    const after = await boot();
    const budget = await after.getGrowthBudget(db.prisma, 'user-a-new', SC_ID);

    expect(budget.used24h).toBe(0);
    expect(budget.remaining).toBe(after.GROWTH_DAILY_FOLLOW_CAP);
    expect(budget.cooldownRemainingMs).toBe(0);
  });

  test('a follow SoundCloud accepted but whose row was never written is no longer counted', async () => {
    const db = table();
    const before = await boot();
    before.recordGrowthEvent(SC_ID, 'follow');     // the row write failed
    expect((await before.getGrowthBudget(db.prisma, 'user-a', SC_ID)).used24h).toBe(1);

    const after = await boot();

    expect((await after.getGrowthBudget(db.prisma, 'user-a', SC_ID)).used24h).toBe(0);
  });

  test('the cooldown of a session that wrote no row is gone', async () => {
    const db = table();
    const before = await boot();
    before.recordGrowthEvent(SC_ID, 'action');     // what a session start records
    expect((await before.getGrowthBudget(db.prisma, 'user-a', SC_ID)).cooldownRemainingMs).toBeGreaterThan(0);

    const after = await boot();

    expect((await after.getGrowthBudget(db.prisma, 'user-a', SC_ID)).cooldownRemainingMs).toBe(0);
  });
});
