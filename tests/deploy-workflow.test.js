import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'azure-deploy.yml'),
  'utf8',
);

test('the deploy job runs for main only', () => {
  expect(workflow).toMatch(/build-and-deploy:\n {4}if: github\.ref == 'refs\/heads\/main'\n/);
});

test('a requested ref must be on main before anything is built', () => {
  const check = workflow.indexOf('git merge-base --is-ancestor HEAD FETCH_HEAD');
  expect(check).toBeGreaterThan(workflow.indexOf('actions/checkout'));
  expect(check).toBeLessThan(workflow.indexOf('npm ci'));
  expect(workflow).toContain('fetch-depth: 0');
});
