import { jest } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// The pre-registration document repeats, as text, things the code also
// defines: the list of write actions, the success statuses, the window, the
// flag key. Cole runs the document's SQL by hand against production, so a
// list that drifted from the code would make his numbers disagree with the
// console's with nothing to say why. This fails first.
//
// (That the SQL and the route return the same NUMBERS is checked against a
// real database in tests/routes/experiment-readout.integration.test.js.)

jest.unstable_mockModule('../server/lib/prisma.js', () => ({ default: {} }));

const { WRITE_ACTIONS, SUCCESS_STATUSES } = await import('../server/lib/experiments.js');
const { FLAGS, ACTIVATION_WINDOW_DAYS, variantBucketFor, variantFor } = await import('../server/lib/flags.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'guided-first-run';
const docPath = join(root, FLAGS[KEY].doc);
const doc = readFileSync(docPath, 'utf8');

/** Named ```sql blocks, indentation removed. */
function sqlBlocks(text) {
  const blocks = {};
  const re = /^([ \t]*)```sql\n\1-- name: ([a-z-]+)\n([\s\S]*?)^\1```/gm;
  let m;
  while ((m = re.exec(text)) !== null) blocks[m[2]] = m[3];
  return blocks;
}

const quoted = (text) => [...text.matchAll(/'([a-z][a-z0-9:-]*)'/g)].map((m) => m[1]);

/** The contents of the first `action IN ( … )` list in a block. */
function actionList(block) {
  const m = block.match(/ol\.action IN \(([\s\S]*?)\)\s*\n\s*AND ol\.status IN \(([^)]*)\)/);
  if (!m) return null;
  return { actions: quoted(m[1]), statuses: quoted(m[2]) };
}

describe('the pre-registration document matches the code', () => {
  const blocks = sqlBlocks(doc);

  test('the flag points at a document that exists, with the queries the checklist names', () => {
    expect(existsSync(docPath)).toBe(true);
    expect(Object.keys(blocks).sort()).toEqual(['analysis', 'assignment-audit', 'baseline', 'readout']);
  });

  test.each(['baseline', 'readout', 'analysis'])(
    'the %s query uses exactly the code’s write actions and success statuses',
    (name) => {
      const list = actionList(blocks[name]);
      expect(list).not.toBeNull();
      expect([...list.actions].sort()).toEqual([...WRITE_ACTIONS].sort());
      expect(list.statuses).toEqual([...SUCCESS_STATUSES]);
    },
  );

  test('the prose list of write actions is the same list', () => {
    const section = doc.slice(doc.indexOf('## 5. Primary metric'), doc.indexOf('## 6. Guardrails'));
    const listed = [...section.matchAll(/`([a-z][a-z-]+)`/g)]
      .map((m) => m[1])
      .filter((name) => !['success', 'split', 'partial'].includes(name));
    expect([...new Set(listed)].sort()).toEqual([...WRITE_ACTIONS].sort());
  });

  test('every query is about this flag and this window', () => {
    for (const name of ['readout', 'analysis', 'assignment-audit']) {
      expect(blocks[name]).toContain(`'${KEY}`);
    }
    for (const name of ['baseline', 'readout', 'analysis']) {
      expect(blocks[name]).toContain(`interval '${ACTIVATION_WINDOW_DAYS} days'`);
    }
    expect(blocks.readout).toContain(`experiment\\_enrolled:${KEY}:`);
  });

  test('the operation filter excludes page opens, probes and logins in the readout', () => {
    for (const prefix of ['view:%', 'read:%', 'auth-%']) {
      expect(blocks.readout).toContain(`ol.action NOT LIKE '${prefix}'`);
    }
    expect(blocks.readout).toContain("f.status <> 'spam'");
  });

  test('the assignment audit hashes the way variantFor does', () => {
    // The SQL splits at 50 on sha256("<key>:variant:<soundcloudId>"). Both
    // halves of that have to stay true of the code for the audit to mean
    // anything.
    expect(blocks['assignment-audit']).toContain(`'${KEY}:variant:' || u."soundcloudId"`);
    expect(blocks['assignment-audit']).toMatch(/% 100 < 50\s+THEN 'control' ELSE 'guided'/);
    expect(FLAGS[KEY].variants).toEqual([{ name: 'control', weight: 50 }, { name: 'guided', weight: 50 }]);
    for (let id = 1; id <= 500; id++) {
      expect(variantFor(KEY, id)).toBe(variantBucketFor(KEY, id) < 50 ? 'control' : 'guided');
    }
  });

  test('no query in the document can write', () => {
    for (const [name, text] of Object.entries(blocks)) {
      // Quoted strings out first: 'delete-playlist' is an action, not a verb.
      const statements = text.replace(/'[^']*'/g, "''");
      expect(`${name}: ${statements.match(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i)?.[0]}`)
        .toBe(`${name}: undefined`);
    }
  });

  test('the baseline, sample size and duration are still blanks for Cole', () => {
    // They come from production data this repo has never seen. If a number
    // appears here before the experiment is launched, somebody guessed.
    for (const blank of ['baseline', 'mde', 'n per arm', 'arrivals per day', 'duration', 'start', 'end', 'end + 7 days']) {
      expect(doc).toContain(`[ BLANK: ${blank} ]`);
    }
  });

  test('what the document fixes is what the code does', () => {
    expect(doc).toContain('| Split | 50 / 50 |');
    expect(doc).toContain(`within ${ACTIVATION_WINDOW_DAYS} days of first login`);
    expect(doc).toContain('docs/sql/2026-11-experiment-exposures.sql');
    expect(existsSync(join(root, 'docs/sql/2026-11-experiment-exposures.sql'))).toBe(true);
    expect(existsSync(join(root, 'docs/experiments/staged-rollout-runbook.md'))).toBe(true);
    expect(FLAGS[KEY].rolloutPercent).toBe(0);
  });

  test('every screenshot the document shows is in the repo', () => {
    const images = [...doc.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(`${image}: ${existsSync(join(dirname(docPath), image))}`).toBe(`${image}: true`);
    }
  });
});
