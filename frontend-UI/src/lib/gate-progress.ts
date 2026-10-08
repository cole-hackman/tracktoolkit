/**
 * Progress through free-download gates done by hand, one at a time.
 *
 * Kept in this browser only (localStorage): it is a per-person checklist,
 * not account data, and losing it costs a re-check, not a download. Every
 * read and write tolerates storage being missing or throwing (private
 * windows, blocked site data).
 */

export const GATE_PROGRESS_KEY = "track-toolkit-gate-progress";

export type GateMark = "done" | "skipped";

export interface GateProgress {
  /** Keyed by SoundCloud track id. */
  marks: Record<string, { mark: GateMark; at: string }>;
  /** Most recent last, for Undo. */
  history: string[];
}

export const EMPTY_PROGRESS: GateProgress = { marks: {}, history: [] };

type Store = Pick<Storage, "getItem" | "setItem"> | null | undefined;

function browserStorage(): Store {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadGateProgress(storage: Store = browserStorage()): GateProgress {
  try {
    const raw = storage?.getItem(GATE_PROGRESS_KEY);
    if (!raw) return EMPTY_PROGRESS;
    const parsed = JSON.parse(raw);
    const marks: GateProgress["marks"] = {};
    for (const [id, value] of Object.entries(parsed?.marks ?? {})) {
      const mark = (value as { mark?: unknown })?.mark;
      if (mark === "done" || mark === "skipped") marks[id] = { mark, at: String((value as { at?: unknown }).at ?? "") };
    }
    const history = Array.isArray(parsed?.history) ? parsed.history.map(String).filter((id: string) => id in marks) : [];
    return { marks, history };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function saveGateProgress(progress: GateProgress, storage: Store = browserStorage()) {
  try {
    storage?.setItem(GATE_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    /* Progress just won't survive a reload. */
  }
}

export function markGate(progress: GateProgress, trackId: number, mark: GateMark, now = new Date()): GateProgress {
  const id = String(trackId);
  return {
    marks: { ...progress.marks, [id]: { mark, at: now.toISOString() } },
    history: [...progress.history.filter((h) => h !== id), id],
  };
}

/** Takes back the most recent mark. */
export function undoLast(progress: GateProgress): { progress: GateProgress; trackId: number | null } {
  const id = progress.history[progress.history.length - 1];
  if (!id) return { progress, trackId: null };
  const marks = { ...progress.marks };
  delete marks[id];
  return { progress: { marks, history: progress.history.slice(0, -1) }, trackId: Number(id) };
}

/** Puts every skipped gate in `ids` back in line; done ones stay done. */
export function clearSkips(progress: GateProgress, ids: number[]): GateProgress {
  const skip = new Set(ids.map(String).filter((id) => progress.marks[id]?.mark === "skipped"));
  const marks = { ...progress.marks };
  for (const id of skip) delete marks[id];
  return { marks, history: progress.history.filter((h) => !skip.has(h)) };
}

/** The first gate with no mark, in the order given. */
export function nextGate<T extends { id: number }>(gates: T[], progress: GateProgress): T | null {
  return gates.find((g) => !progress.marks[String(g.id)]) ?? null;
}

export function gateCounts(gates: Array<{ id: number }>, progress: GateProgress) {
  let done = 0;
  let skipped = 0;
  for (const g of gates) {
    const mark = progress.marks[String(g.id)]?.mark;
    if (mark === "done") done++;
    else if (mark === "skipped") skipped++;
  }
  return { total: gates.length, done, skipped, left: gates.length - done - skipped };
}
