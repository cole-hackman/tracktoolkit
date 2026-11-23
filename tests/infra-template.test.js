import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra');
const read = (name) => readFileSync(join(INFRA, name), 'utf8');

test('the live parameters keep the managed certificates attached', () => {
  expect(read('main.cutover.bicepparam')).toMatch(/^param bindManagedCertificates = true$/m);
});
