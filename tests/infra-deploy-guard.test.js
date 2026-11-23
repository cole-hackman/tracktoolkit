import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * infra/deploy.sh rewrites the live app. It must name its parameter file, show
 * a what-if, and wait for the target host to be typed. Every run here uses a
 * stub `az` on PATH that only records its arguments, so nothing reaches Azure.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'infra', 'deploy.sh');
const CUTOVER = join(ROOT, 'infra', 'main.cutover.bicepparam');
const PLAIN = join(ROOT, 'infra', 'main.bicepparam');

// Runs the script on a pseudo-terminal and types `answer`.
const PTY = `
import os, pty, sys
answer = os.environ['TT_TYPED'].encode() + b'\\n'
sent = False
seen = b''
def read(fd):
    global sent, seen
    data = os.read(fd, 1024)
    seen += data
    if not sent and b'to continue: ' in seen:
        os.write(fd, answer)
        sent = True
    return data
def no_stdin(fd):
    return b''
status = pty.spawn(['bash', sys.argv[1]], read, no_stdin)
sys.exit(os.waitstatus_to_exitcode(status))
`;

let dir;
let log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-deploy-'));
  log = join(dir, 'az.log');
  writeFileSync(join(dir, 'az'), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "group exists"*) echo true ;;
  *"show --query id"*) echo stub-id ;;
esac
`);
  chmodSync(join(dir, 'az'), 0o755);
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = (params) => ({
  PATH: `${dir}:${process.env.PATH}`,
  HOME: dir,
  TT_PG_ADMIN_PASSWORD: 'stub',
  ...(params ? { TT_PARAMS: params } : {}),
});
const azCalls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const run = (params) => spawnSync('bash', [SCRIPT], { env: env(params), input: 'tracktoolkit.com\n', encoding: 'utf8' });
const runTyped = (params, answer) => spawnSync('python3', ['-c', PTY, SCRIPT], {
  env: { ...env(params), TT_TYPED: answer }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000,
});

test('refuses to run without TT_PARAMS', () => {
  const res = run();
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('TT_PARAMS must name');
  expect(azCalls()).toBe('');
});

test('refuses without a terminal, so piped input cannot confirm', () => {
  const res = run(CUTOVER);
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('run it from a terminal');
  expect(azCalls()).toBe('');
});

test('shows the what-if and changes nothing on a wrong answer', () => {
  const res = runTyped(CUTOVER, 'yes');
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('Type tracktoolkit.com to continue');
  expect(res.stdout).toContain('RETENTION_DRY_RUN');
  expect(azCalls()).toContain('deployment group what-if');
  expect(azCalls()).not.toMatch(/deployment group create|keyvault secret set|appsettings set|group create/);
});

test('deploys the named parameter file once the host is typed', () => {
  const res = runTyped(CUTOVER, 'tracktoolkit.com');
  expect(res.status).toBe(0);
  expect(azCalls()).toMatch(/deployment group create .*main\.cutover\.bicepparam/);
});

test('the parameter file without a domain asks for the default host and warns', () => {
  const res = runTyped(PLAIN, 'tracktoolkit.com');
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('Type tracktoolkit.azurewebsites.net to continue');
  expect(res.stdout).toContain('sets no appUrl');
  expect(azCalls()).not.toContain('deployment group create');
});
