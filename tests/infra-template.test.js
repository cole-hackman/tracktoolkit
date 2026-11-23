import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra');
const read = (name) => readFileSync(join(INFRA, name), 'utf8');

test('the live parameters keep the managed certificates attached', () => {
  expect(read('main.cutover.bicepparam')).toMatch(/^param bindManagedCertificates = true$/m);
});

test('the template locks the database and the vault against deletion', () => {
  const bicep = read('main.bicep');
  expect(bicep).toMatch(/enablePurgeProtection: true/);
  for (const scope of ['pg', 'kv']) {
    expect(bicep).toMatch(new RegExp(`Microsoft\\.Authorization/locks@[^=]+= \\{[\\s\\S]{0,80}scope: ${scope}\\n[\\s\\S]{0,40}level: 'CanNotDelete'`));
  }
});
