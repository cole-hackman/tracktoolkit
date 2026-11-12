import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Written by .github/workflows/azure-deploy.yml just before the zip is made
// (`{"commit":"<sha>"}`), so the running app can say which commit it is. It is
// not in git; a local run or a test run has no file and reports null.
export const BUILD_INFO_PATH = join(__dirname, '..', 'build-info.json');

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Read the deployed commit from the build-info file; null when it is absent or unusable. */
export function readBuildCommit(path = BUILD_INFO_PATH) {
  try {
    const { commit } = JSON.parse(readFileSync(path, 'utf8'));
    return typeof commit === 'string' && SHA_PATTERN.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** Express handler for GET /health. `commit` is the deployed git SHA, or null. */
export function createHealthHandler(commit = readBuildCommit()) {
  return (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), commit });
  };
}
