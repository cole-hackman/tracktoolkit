import { accessFor } from '../server/lib/download-access.js';

const KEYS = ['ADMIN_IDS', 'DOWNLOAD_ALLOWLIST'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('accessFor — the one definition behind canDownload', () => {
  test('fails closed when nothing is configured', () => {
    delete process.env.ADMIN_IDS;
    delete process.env.DOWNLOAD_ALLOWLIST;
    expect(accessFor(111)).toEqual({ isAdmin: false, canDownload: false });
    expect(accessFor(undefined)).toEqual({ isAdmin: false, canDownload: false });
  });

  test('allowlisted ids can download; admins always can', () => {
    process.env.ADMIN_IDS = '1';
    process.env.DOWNLOAD_ALLOWLIST = ' 111 , 222,junk';
    expect(accessFor(111)).toEqual({ isAdmin: false, canDownload: true });
    expect(accessFor('222')).toEqual({ isAdmin: false, canDownload: true });
    expect(accessFor(1)).toEqual({ isAdmin: true, canDownload: true });
    expect(accessFor(333)).toEqual({ isAdmin: false, canDownload: false });
  });

  test('a BigInt soundcloudId from Prisma is accepted', () => {
    process.env.DOWNLOAD_ALLOWLIST = '111';
    expect(accessFor(111n)).toEqual({ isAdmin: false, canDownload: true });
  });
});
