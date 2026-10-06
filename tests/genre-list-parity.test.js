import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { GENRE_FOCUS_OPTIONS } from '../server/lib/genres.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(
  path.join(here, '..', 'frontend-UI', 'src', 'lib', 'genres.ts'),
  'utf8',
);

// Same approach as the contrast gate's TONE_SOFT parse: read the literal out
// of the TS source rather than importing it.
function parseClientOptions(source) {
  const block = source.match(/GENRE_FOCUS_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\]/);
  if (!block) throw new Error('GENRE_FOCUS_OPTIONS array not found in genres.ts');
  const out = [];
  const re = /slug:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) out.push({ slug: m[1], label: m[2] });
  return out;
}

describe('genre focus list parity (server vs client)', () => {
  test('client list has the same slugs, labels and order as the server', () => {
    const client = parseClientOptions(clientSource);
    const server = GENRE_FOCUS_OPTIONS.map(({ slug, label }) => ({ slug, label }));
    expect(client.length).toBeGreaterThan(0);
    expect(client).toEqual(server);
  });
});
