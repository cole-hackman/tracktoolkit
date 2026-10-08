import { buildFileName } from "@/lib/download-file-name";

/**
 * The Downloads page's folder mode: the page fetches each file from
 * SoundCloud's CDN (CORS-open, verified live 2026-10-08) and writes it into a
 * folder the user picked once, through the File System Access API. Two
 * things fall out of writing instead of downloading: the file gets the
 * track's name, and Chrome never shows its "download multiple files" prompt,
 * so the queue never has to stop and ask whether a file saved.
 *
 * Chromium-only (Chrome, Edge, Arc…). Where `showDirectoryPicker` is missing
 * the page keeps the helper-tab flow. The handle lives in memory only: a
 * reload means picking the folder again on Resume.
 */

type DirectoryPickerOptions = { id?: string; mode?: "read" | "readwrite"; startIn?: string };
type PickerWindow = Window & { showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle> };

export function supportsFolderSave(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Call from a click handler (the picker needs the user's gesture). Null when closed or refused. */
export async function pickDownloadFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker.call(window, { id: "track-toolkit-downloads", mode: "readwrite", startIn: "downloads" });
  } catch {
    // AbortError (the user closed it), SecurityError (no gesture), NotAllowedError.
    return null;
  }
}

export class FolderSaveError extends Error {}

/** A name not already taken in the folder: "x.wav", then "x (2).wav", … */
async function freeName(dir: FileSystemDirectoryHandle, base: string): Promise<string> {
  const dot = base.lastIndexOf(".");
  const stem = base.slice(0, dot);
  const ext = base.slice(dot);
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${stem} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (error) {
      if ((error as DOMException)?.name === "NotFoundError") return candidate;
      throw error;
    }
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * Fetches one CDN link and writes it into `dir` under the track's name.
 * Resolves with the name used. Aborting `signal` discards the partial file.
 */
export async function saveToFolder(
  dir: FileSystemDirectoryHandle,
  item: { artist: string; title: string },
  link: string,
  signal: AbortSignal,
): Promise<{ fileName: string }> {
  let response: Response;
  try {
    response = await fetch(link, { signal, credentials: "omit" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new FolderSaveError("Could not reach SoundCloud's download server from this page.");
  }
  if (!response.ok || !response.body) {
    throw new FolderSaveError(
      response.status === 403 ? "SoundCloud's download link had expired. Resume to ask for it again." : `SoundCloud's download server answered ${response.status}.`,
    );
  }
  const reader = response.body.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array(0);
  const fileName = await freeName(
    dir,
    buildFileName(item, { head, contentType: response.headers.get("content-type"), disposition: response.headers.get("content-disposition") }),
  );
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writer = (await handle.createWritable()).getWriter();
  try {
    if (head.length > 0) await writer.write(head);
    while (!first.done) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await writer.write(value);
    }
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
  return { fileName };
}
