/**
 * Who may use the download features beyond a single click: admins plus the
 * SoundCloud ids in DOWNLOAD_ALLOWLIST (comma-separated). One definition, so
 * the flag /api/auth/me hands the page and the gate the server enforces can
 * never disagree — the page used to be the only thing checking it.
 */
const parseIds = (value) =>
  (value || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);

export function accessFor(soundcloudId) {
  const id = Number(soundcloudId);
  const known = !!soundcloudId && Number.isSafeInteger(id) && id > 0;
  const isAdmin = known && parseIds(process.env.ADMIN_IDS).includes(id);
  const canDownload = isAdmin || (known && parseIds(process.env.DOWNLOAD_ALLOWLIST).includes(id));
  return { isAdmin, canDownload };
}
