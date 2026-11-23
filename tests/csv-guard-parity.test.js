import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The spreadsheet formula guard exists twice: `csvCell` in
 * server/routes/admin.js (admin exports) and `csvEscape` in
 * frontend-UI/src/lib/csv.ts (everything the browser writes). They are in
 * different module systems and cannot share a file, so this compares the one
 * thing that must not drift: the pattern that decides whether a cell gets the
 * apostrophe. tests/genre-list-parity.test.js does the same for genres.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

function guardPattern(source, file) {
  const match = /^const CSV_FORMULA_PREFIX_RE = (\/.+\/[a-z]*);$/m.exec(source);
  if (!match) throw new Error(`CSV_FORMULA_PREFIX_RE not found in ${file}`);
  return match[1];
}

const SERVER = 'server/routes/admin.js';
const BROWSER = 'frontend-UI/src/lib/csv.ts';

test('the server and the browser guard the same cells', () => {
  expect(guardPattern(read(SERVER), SERVER)).toBe(guardPattern(read(BROWSER), BROWSER));
});

describe('the shared pattern', () => {
  // Evaluated from the source text, so this is the pattern both sides run.
  const literal = guardPattern(read(SERVER), SERVER);
  const flags = literal.slice(literal.lastIndexOf('/') + 1);
  const pattern = new RegExp(literal.slice(1, literal.lastIndexOf('/')), flags);

  test.each([
    '=1+1', '+cmd', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '\n=1', '\tplain', '\nplain',
    ' =1+1', ' =1', '　=1', '﻿=1', '​=1', '‎=1', '‮=1', '⁦=1', '\u0000=1', '­=1',
    '＝1+1', '＋cmd', '－2+3', '＠SUM(A1)', ' \t ＝1',
  ])('guards %j', (value) => {
    expect(pattern.test(value)).toBe(true);
  });

  test.each([
    '', '   ', 'plain', ' plain', 'a=b', 're-edit', 'x@y.z', 'Artist - Title', "'=1", '#1', '0', '1e5',
    '— Intro', '– Intro', '− Intro', '１２', '　plain', '(=1)', '"=1"',
  ])('leaves %j alone', (value) => {
    expect(pattern.test(value)).toBe(false);
  });
});
