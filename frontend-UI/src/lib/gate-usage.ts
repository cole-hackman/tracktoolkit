/**
 * Forwarding how each gate in an extension run ended to the server, so the
 * admin console can count gate downloads next to the direct ones.
 *
 * The extension never talks to the server. It does tell the page, per track,
 * how each gate went (progress v2: `{ runId, items: [{ id, site, status, … }] }`,
 * dispatched by its content script as `sc-toolkit-progress-update` and kept in
 * `sc-toolkit-hypeddit-progress`). This turns that into the outcomes not yet
 * reported. No I/O: the reporter component owns the fetch and the storage.
 *
 * "done" is the extension's own meaning: Chrome reported that download
 * complete (it sits in "saving" until then). A gate that did its account
 * actions but never delivered a file is "failed", with the reason.
 */

import type { GateSite } from "@/lib/gate-queue";

export const GATE_PROGRESS_KEY = "sc-toolkit-hypeddit-progress";
export const GATE_REPORTED_KEY = "track-toolkit-gate-reported";
/** The server takes at most this many outcomes per call. */
export const GATE_REPORT_BATCH = 50;
/** The reported set is remembered for this many outcomes, newest kept. */
export const GATE_REPORTED_CAP = 1000;

const SITES: readonly GateSite[] = ["hypeddit", "droploud", "cobrand"];
const ACTIONS = ["follow", "like", "comment", "repost", "email-signup", "sms-signup"] as const;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface GateResult {
  id: number;
  site: GateSite;
  status: "done" | "failed";
  title?: string;
  artist?: string;
  reason?: string;
  actions?: string[];
}

export interface GateReport {
  runId: string;
  results: GateResult[];
}

/** The same key the server uses to recognise a repeat, with the run in front. */
export const gateReportKey = (runId: string, id: number, status: string) => `${runId}:${id}:${status}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * What a progress payload says has ended and has not been reported. Anything it
 * does not recognise (an old extension's v1 payload, a site we do not log, a
 * track that is still waiting or running, one skipped by the extension) is left
 * out, never guessed.
 */
export function pendingGateResults(progress: unknown, reported: ReadonlySet<string>): GateReport | null {
  if (!isRecord(progress) || progress.version !== 2) return null;
  const runId = progress.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return null;
  if (!Array.isArray(progress.items)) return null;

  const results: GateResult[] = [];
  const seen = new Set<string>();
  for (const item of progress.items) {
    if (!isRecord(item)) continue;
    const { id, site, status } = item;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) continue;
    if (typeof site !== "string" || !SITES.includes(site as GateSite)) continue;
    if (status !== "done" && status !== "failed") continue;
    const key = gateReportKey(runId, id, status);
    if (reported.has(key) || seen.has(key)) continue;
    seen.add(key);

    const actions = Array.isArray(item.actions)
      ? item.actions.filter((a): a is string => typeof a === "string" && (ACTIONS as readonly string[]).includes(a))
      : [];
    results.push({
      id,
      site: site as GateSite,
      status,
      ...(text(item.title, 200) ? { title: text(item.title, 200) } : {}),
      ...(text(item.artist, 200) ? { artist: text(item.artist, 200) } : {}),
      ...(status === "failed" && text(item.reason, 300) ? { reason: text(item.reason, 300) } : {}),
      ...(actions.length ? { actions } : {}),
    });
  }
  return results.length ? { runId, results } : null;
}

/** Splits a report into calls the server accepts. */
export function batchReport(report: GateReport, size = GATE_REPORT_BATCH): GateReport[] {
  const batches: GateReport[] = [];
  for (let i = 0; i < report.results.length; i += size) {
    batches.push({ runId: report.runId, results: report.results.slice(i, i + size) });
  }
  return batches;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function loadReported(storage: ReadStorage | null): Set<string> {
  try {
    const raw = storage?.getItem(GATE_REPORTED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveReported(storage: WriteStorage | null, reported: ReadonlySet<string>) {
  try {
    storage?.setItem(GATE_REPORTED_KEY, JSON.stringify([...reported].slice(-GATE_REPORTED_CAP)));
  } catch {
    /* storage blocked: the server de-duplicates anyway */
  }
}
