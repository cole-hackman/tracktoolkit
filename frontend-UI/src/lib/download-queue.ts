/**
 * The Downloads page's queue for SoundCloud's own downloads — state only, no
 * I/O, so every rule here is unit-tested without a browser.
 *
 * Items are SoundCloud track download URLs (the artist enabled downloads);
 * free gates and stores never enter this queue. What is persisted is ids,
 * titles and statuses — never a file, never a CDN link (those are signed and
 * short-lived, fetched just before use).
 */

export type QueueItemStatus =
  | "pending" // waiting
  | "fetching" // its link is being asked for
  | "started" // the browser was handed the file (tab mode)
  | "saving" // the page is writing it into the chosen folder (folder mode)
  | "saved" // written in full, under `fileName` (folder mode)
  | "unavailable" // SoundCloud says no download (artist turned it off, track gone)
  | "failed" // something else went wrong; reason says what
  | "rate_limited"; // SoundCloud asked to slow down; retried on Resume

export interface QueueItem {
  trackId: number;
  title: string;
  artist: string;
  downloadUrl: string;
  status: QueueItemStatus;
  reason?: string;
  /** What the file was saved as, once `saved`. */
  fileName?: string;
}

/**
 * "tab": each CDN link is handed to a helper tab and the browser downloads
 * it under the CDN's name. "folder": the page fetches the file and writes
 * it, as "Artist - Title.ext", into a folder picked with the File System
 * Access API (see lib/download-folder.ts). Absent on queues saved before
 * the mode existed, which were all tab queues.
 */
export type QueueMode = "tab" | "folder";

export interface QueueState {
  version: 1;
  sourceTitle: string;
  items: QueueItem[];
  running: boolean;
  mode?: QueueMode;
  /** Why the queue stopped, in words, when it stopped before finishing. */
  pausedReason?: string;
  /**
   * Waiting for the user to say whether this file saved. Chrome lets a page
   * start ONE download by itself and asks ("This site is trying to download
   * multiple files") before the next — a prompt this page cannot see. So,
   * until the user has confirmed once, the queue stops after the second
   * file and asks.
   */
  check?: { trackId: number; title: string };
}

export type QueueAction =
  | { type: "load"; state: QueueState }
  | { type: "enqueue"; sourceTitle: string; items: Array<Omit<QueueItem, "status" | "reason" | "fileName">>; mode?: QueueMode }
  | { type: "start" }
  | { type: "pause"; reason?: string }
  | { type: "clear" }
  | { type: "fetching"; trackIds: number[] }
  | { type: "saving"; trackId: number }
  | { type: "result"; trackId: number; status: Exclude<QueueItemStatus, "pending" | "fetching" | "saving">; reason?: string; fileName?: string }
  | { type: "check"; trackId: number; title: string }
  | { type: "confirmSaved" }
  | { type: "retryChecked" };

export const EMPTY_QUEUE: QueueState = { version: 1, sourceTitle: "", items: [], running: false };
export const QUEUE_STORAGE_KEY = "track-toolkit-download-queue";
/** Links asked for per server call — the route accepts at most 10. */
export const BATCH_SIZE = 10;
/**
 * Fewer per call in folder mode: the links are signed and short-lived, and a
 * batch of wavs is written one after another, so the last link of ten could
 * expire while the first nine are still being saved.
 */
export const FOLDER_BATCH_SIZE = 5;

const OPEN: QueueItemStatus[] = ["pending", "rate_limited"];
/** Mid-request: put back to waiting by a pause or a reload. */
const IN_FLIGHT: QueueItemStatus[] = ["fetching", "saving"];
const backToPending = (items: QueueItem[]) =>
  items.map((i) => (IN_FLIGHT.includes(i.status) ? { ...i, status: "pending" as const } : i));

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "load":
      return action.state;
    case "enqueue": {
      // A check is answered, not restarted around: replacing the queue here
      // used to drop it, so a browser that never answered stopped at two
      // files on every run. `start` refuses for the same reason.
      if (state.check) return state;
      // A new source replaces the queue; the same track is never queued twice.
      const seen = new Set<number>();
      const items: QueueItem[] = [];
      for (const item of action.items) {
        if (seen.has(item.trackId)) continue;
        seen.add(item.trackId);
        items.push({ ...item, status: "pending" });
      }
      return { version: 1, sourceTitle: action.sourceTitle, items, running: false, mode: action.mode ?? "tab" };
    }
    case "start":
      if (state.check) return state; // answer the check first
      return state.items.some((i) => OPEN.includes(i.status))
        ? { ...state, running: true, pausedReason: undefined }
        : { ...state, running: false };
    case "check":
      return {
        ...state,
        running: false,
        pausedReason: undefined,
        check: { trackId: action.trackId, title: action.title },
        items: backToPending(state.items),
      };
    case "confirmSaved":
      return { ...state, check: undefined };
    case "retryChecked": {
      const id = state.check?.trackId;
      return {
        ...state,
        check: undefined,
        items: state.items.map((i) => (i.trackId === id ? { ...i, status: "pending", reason: undefined } : i)),
      };
    }
    case "pause":
      return {
        ...state,
        running: false,
        pausedReason: action.reason,
        // Anything mid-request goes back to waiting, so Resume asks again.
        items: backToPending(state.items),
      };
    case "clear":
      return EMPTY_QUEUE;
    case "fetching": {
      const ids = new Set(action.trackIds);
      return { ...state, items: state.items.map((i) => (ids.has(i.trackId) ? { ...i, status: "fetching", reason: undefined } : i)) };
    }
    case "saving":
      return { ...state, items: state.items.map((i) => (i.trackId === action.trackId ? { ...i, status: "saving", reason: undefined } : i)) };
    case "result": {
      const items = state.items.map((i) =>
        i.trackId === action.trackId ? { ...i, status: action.status, reason: action.reason, fileName: action.fileName } : i,
      );
      const done = !items.some((i) => OPEN.includes(i.status) || IN_FLIGHT.includes(i.status));
      return { ...state, items, running: done ? false : state.running };
    }
  }
}

/** The next items to ask links for: waiting, or held back by a 429 earlier. */
export function nextBatch(state: QueueState, size = BATCH_SIZE): QueueItem[] {
  return state.items.filter((i) => OPEN.includes(i.status)).slice(0, size);
}

export function summarize(state: QueueState) {
  const count = (s: QueueItemStatus) => state.items.filter((i) => i.status === s).length;
  const started = count("started");
  const saved = count("saved");
  const unavailable = count("unavailable");
  const failed = count("failed");
  const waiting = count("pending") + count("rate_limited") + count("fetching") + count("saving");
  return { total: state.items.length, started, saved, unavailable, failed, waiting, finished: started + saved + unavailable + failed };
}

/** Reads the saved queue, tolerating storage that is blocked or corrupt. */
export function loadQueue(storage: Pick<Storage, "getItem"> | null): QueueState {
  try {
    const raw = storage?.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return EMPTY_QUEUE;
    const parsed = JSON.parse(raw) as QueueState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return EMPTY_QUEUE;
    // A reload interrupts the queue: nothing is running any more, and a
    // request that was in flight is asked again.
    return {
      ...parsed,
      running: false,
      pausedReason: parsed.items.some((i) => OPEN.includes(i.status) || IN_FLIGHT.includes(i.status))
        ? parsed.pausedReason || "The page was reloaded. Resume to carry on."
        : parsed.pausedReason,
      items: backToPending(parsed.items),
    };
  } catch {
    return EMPTY_QUEUE;
  }
}

export function saveQueue(storage: Pick<Storage, "setItem" | "removeItem"> | null, state: QueueState) {
  try {
    if (state.items.length === 0) storage?.removeItem(QUEUE_STORAGE_KEY);
    else storage?.setItem(QUEUE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked: the queue still works, it just won't survive a reload */
  }
}

/**
 * Whether this browser has already been through Chrome's "download multiple
 * files" prompt with this site (the user said a second file saved). Per
 * browser, in localStorage, because it mirrors a per-browser Chrome setting.
 */
export const MULTI_DOWNLOAD_OK_KEY = "track-toolkit-multi-download-ok";

export function readMultiDownloadOk(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(MULTI_DOWNLOAD_OK_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveMultiDownloadOk(storage: Pick<Storage, "setItem"> | null) {
  try {
    storage?.setItem(MULTI_DOWNLOAD_OK_KEY, "1");
  } catch {
    /* blocked storage: it will just ask again next time */
  }
}

/**
 * Links to ask for next. Before the user has confirmed the multiple-downloads
 * prompt once, only up to the second file of the queue, so the check lands
 * exactly there and no link is fetched (and logged as downloaded) for a file
 * that would then sit behind the prompt.
 */
export function nextBatchSize(state: QueueState, multiDownloadOk: boolean): number {
  // Folder mode writes files; it never triggers Chrome's prompt, so no check.
  if (state.mode === "folder") return FOLDER_BATCH_SIZE;
  if (multiDownloadOk) return BATCH_SIZE;
  const started = state.items.filter((i) => i.status === "started").length;
  return started >= 2 ? BATCH_SIZE : 2 - started;
}
