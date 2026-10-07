import { apiFetch } from "@/lib/api";

export type SoundCloudDownloadResult = { ok: true } | { ok: false; error: string };

const FALLBACK_ERROR =
  "SoundCloud did not provide a download link for this track. Try opening it on SoundCloud.";

/**
 * Starts a SoundCloud-sanctioned download — the track's own `download_url`,
 * exchanged by `/api/proxy-download` for a short-lived CDN link.
 *
 * The tab is opened synchronously, inside the click, and only pointed at the
 * CDN once the link arrives. Opening it after the `await` (as both pages used
 * to) is outside the user gesture, and Safari and Firefox block that as a
 * popup. `noopener` cannot be passed here — with it `window.open` returns
 * null and the tab cannot be navigated afterwards — so the opener is cut by
 * hand instead, before anything is loaded into it.
 */
export async function startSoundCloudDownload(downloadUrl: string): Promise<SoundCloudDownloadResult> {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;

  try {
    const response = await apiFetch(
      `/api/proxy-download?format=json&url=${encodeURIComponent(downloadUrl)}`,
    );
    const data = await response.json().catch(() => null);
    const url = typeof data?.url === "string" ? data.url : null;

    if (!response.ok || !url) {
      tab?.close();
      return { ok: false, error: typeof data?.error === "string" ? data.error : FALLBACK_ERROR };
    }

    if (tab) {
      tab.location.href = url;
    } else {
      // The browser refused even the in-gesture tab. The CDN serves the file
      // as an attachment, so navigating this page starts the download without
      // leaving it.
      window.location.assign(url);
    }
    return { ok: true };
  } catch {
    tab?.close();
    return { ok: false, error: "Could not start the download. Try again or open the track on SoundCloud." };
  }
}
