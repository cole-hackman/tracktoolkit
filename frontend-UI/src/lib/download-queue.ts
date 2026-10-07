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
  | "started" // the browser was handed the file
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
}

export interface QueueState {
  version: 1;
  sourceTitle: string;
  items: QueueItem[];
  running: boolean;
  /** Why the queue stopped, in words, when it stopped before finishing. */
  pausedReason?: string;
}

export type QueueAction =
  | { type: "load"; state: QueueState }
  | { type: "enqueue"; sourceTitle: string; items: Array<Omit<QueueItem, "status" | "reason">> }
  | { type: "start" }
  | { type: "pause"; reason?: string }
  | { type: "clear" }
  | { type: "fetching"; trackIds: number[] }
  | { type: "result"; trackId: number; status: Exclude<QueueItemStatus, "pending" | "fetching">; reason?: string };

export const EMPTY_QUEUE: QueueState = { version: 1, sourceTitle: "", items: [], running: false };
export const QUEUE_STORAGE_KEY = "track-toolkit-download-queue";
/** Links asked for per server call — the route accepts at most 10. */
export const BATCH_SIZE = 10;

const OPEN: QueueItemStatus[] = ["pending", "rate_limited"];

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "load":
      return action.state;
    case "enqueue": {
      // A new source replaces the queue; the same track is never queued twice.
      const seen = new Set<number>();
      const items: QueueItem[] = [];
      for (const item of action.items) {
        if (seen.has(item.trackId)) continue;
        seen.add(item.trackId);
        items.push({ ...item, status: "pending" });
      }
      return { version: 1, sourceTitle: action.sourceTitle, items, running: false };
    }
    case "start":
      return state.items.some((i) => OPEN.includes(i.status))
        ? { ...state, running: true, pausedReason: undefined }
        : { ...state, running: false };
    case "pause":
      return {
        ...state,
        running: false,
        pausedReason: action.reason,
        // Anything mid-request goes back to waiting, so Resume asks again.
        items: state.items.map((i) => (i.status === "fetching" ? { ...i, status: "pending" } : i)),
      };
    case "clear":
      return EMPTY_QUEUE;
    case "fetching": {
      const ids = new Set(action.trackIds);
      return { ...state, items: state.items.map((i) => (ids.has(i.trackId) ? { ...i, status: "fetching", reason: undefined } : i)) };
    }
    case "result": {
      const items = state.items.map((i) =>
        i.trackId === action.trackId ? { ...i, status: action.status, reason: action.reason } : i,
      );
      const done = !items.some((i) => OPEN.includes(i.status) || i.status === "fetching");
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
  const unavailable = count("unavailable");
  const failed = count("failed");
  const waiting = count("pending") + count("rate_limited") + count("fetching");
  return { total: state.items.length, started, unavailable, failed, waiting, finished: started + unavailable + failed };
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
      pausedReason: parsed.items.some((i) => OPEN.includes(i.status) || i.status === "fetching")
        ? parsed.pausedReason || "The page was reloaded. Resume to carry on."
        : parsed.pausedReason,
      items: parsed.items.map((i) => (i.status === "fetching" ? { ...i, status: "pending" } : i)),
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
