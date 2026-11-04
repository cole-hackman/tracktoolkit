/**
 * What the browser extension reports about a gate run (Hypeddit, Droploud,
 * Cobrand), as the page reads it: the `sc-toolkit-progress-update` window
 * event's detail, and the same JSON stored under `sc-toolkit-hypeddit-progress`.
 *
 * Version 1 is a counts-only payload (no `version`); version 2 adds per-item
 * state, a notice and a run summary. The parser accepts both, ignores fields
 * it does not know and never throws: whatever the extension (or a stale
 * localStorage entry) hands over, the page gets a well-formed value or null.
 *
 * Not to be confused with `lib/gate-progress.ts`, which is the by-hand
 * checklist of gates a person has opened themselves.
 */

export const GATE_RUN_STORAGE_KEY = "sc-toolkit-hypeddit-progress";

export type GateRunStatus = "waiting" | "running" | "saving" | "done" | "failed" | "skipped";

export interface GateRunItem {
  id: number;
  title: string;
  artist: string;
  /** "hypeddit" | "droploud" | "cobrand"; kept as a string so a new site still renders. */
  site: string;
  gateUrl: string;
  status: GateRunStatus;
  step?: string;
  reason?: string;
  actions: string[];
}

export type SummaryKey = "follow" | "like" | "comment" | "repost" | "emailSignup" | "smsSignup";
export const SUMMARY_KEYS: SummaryKey[] = ["follow", "like", "comment", "repost", "emailSignup", "smsSignup"];

export interface SummaryTrack {
  id: number;
  title: string;
  artist: string;
}

export interface GateRunSummary {
  runId: string;
  startedAt: number;
  endedAt: number;
  gates: number;
  downloaded: number;
  failed: number;
  counts: Record<SummaryKey, number>;
  commentText?: string;
  tracks: Record<SummaryKey, SummaryTrack[]>;
  actionsWithoutFile: Array<SummaryTrack & { site: string; reason: string }>;
}

export interface GateRun {
  version: 1 | 2;
  total: number;
  index: number;
  completed: number;
  failed: number;
  active: boolean;
  downloadedCount: number;
  skipped: number;
  runId: string | null;
  notice?: string;
  items: GateRunItem[];
  summary?: GateRunSummary;
}

const STATUSES: GateRunStatus[] = ["waiting", "running", "saving", "done", "failed", "skipped"];
const MAX_ITEMS = 2000;
const MAX_TRACKS = 2000;
const MAX_TEXT = 300;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
function text(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.slice(0, MAX_TEXT) : fallback;
}
function optText(v: unknown): string | undefined {
  const s = text(v).trim();
  return s ? s : undefined;
}
function trackOf(v: unknown): SummaryTrack | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === "number" && Number.isFinite(v.id) ? v.id : NaN;
  if (Number.isNaN(id)) return null;
  return { id, title: text(v.title, "Untitled"), artist: text(v.artist) };
}

/** Only http(s) goes into an href: a payload must not be able to plant `javascript:`. */
export function safeGateUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

function itemOf(v: unknown): GateRunItem | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === "number" && Number.isFinite(v.id) ? v.id : NaN;
  if (Number.isNaN(id)) return null;
  const status = STATUSES.includes(v.status as GateRunStatus) ? (v.status as GateRunStatus) : "waiting";
  return {
    id,
    title: text(v.title, "Untitled"),
    artist: text(v.artist),
    site: text(v.site, "hypeddit").toLowerCase(),
    gateUrl: safeGateUrl(v.gateUrl),
    status,
    step: status === "running" ? optText(v.step) : undefined,
    reason: optText(v.reason),
    actions: Array.isArray(v.actions) ? v.actions.filter((a): a is string => typeof a === "string").slice(0, 12) : [],
  };
}

function summaryOf(v: unknown): GateRunSummary | undefined {
  if (!isObj(v)) return undefined;
  const counts = isObj(v.counts) ? v.counts : {};
  const tracks = isObj(v.tracks) ? v.tracks : {};
  const out: GateRunSummary = {
    runId: text(v.runId),
    startedAt: count(v.startedAt),
    endedAt: count(v.endedAt),
    gates: count(v.gates),
    downloaded: count(v.downloaded),
    failed: count(v.failed),
    counts: { follow: 0, like: 0, comment: 0, repost: 0, emailSignup: 0, smsSignup: 0 },
    commentText: optText(v.commentText),
    tracks: { follow: [], like: [], comment: [], repost: [], emailSignup: [], smsSignup: [] },
    actionsWithoutFile: [],
  };
  for (const key of SUMMARY_KEYS) {
    const list = Array.isArray(tracks[key]) ? (tracks[key] as unknown[]) : [];
    out.tracks[key] = list.slice(0, MAX_TRACKS).map(trackOf).filter((t): t is SummaryTrack => t !== null);
    // The count is the extension's word; fall back to the list if it is missing.
    out.counts[key] = key in counts ? count(counts[key]) : out.tracks[key].length;
  }
  if (Array.isArray(v.actionsWithoutFile)) {
    for (const entry of v.actionsWithoutFile.slice(0, MAX_TRACKS)) {
      const t = trackOf(entry);
      if (t && isObj(entry)) out.actionsWithoutFile.push({ ...t, site: text(entry.site), reason: text(entry.reason) });
    }
  }
  return out;
}

/** A v1 or v2 payload, or null when it is not an object. Never throws. */
export function parseGateRun(raw: unknown): GateRun | null {
  try {
    if (!isObj(raw)) return null;
    const version = typeof raw.version === "number" && raw.version >= 2 ? 2 : 1;
    const items = version === 2 && Array.isArray(raw.items)
      ? raw.items.slice(0, MAX_ITEMS).map(itemOf).filter((i): i is GateRunItem => i !== null)
      : [];
    return {
      version,
      total: count(raw.total),
      index: count(raw.index),
      completed: count(raw.completed),
      failed: count(raw.failed),
      active: raw.active === true,
      downloadedCount: count(raw.downloadedCount),
      skipped: count(raw.skipped),
      runId: typeof raw.runId === "string" ? raw.runId : null,
      notice: version === 2 ? optText(raw.notice) : undefined,
      items,
      summary: version === 2 ? summaryOf(raw.summary) : undefined,
    };
  } catch {
    return null;
  }
}

/** The same, from the JSON string localStorage holds. */
export function parseGateRunJson(json: string | null | undefined): GateRun | null {
  if (!json) return null;
  try {
    return parseGateRun(JSON.parse(json));
  } catch {
    return null;
  }
}

/** True when the per-item section has something to show. */
export function hasGateSection(run: GateRun | null): run is GateRun {
  return !!run && run.version === 2 && (run.items.length > 0 || !!run.summary || !!run.notice);
}

export const GATE_SITE_LABELS: Record<string, string> = { hypeddit: "Hypeddit", droploud: "Droploud", cobrand: "Cobrand" };
export function gateSiteLabel(site: string): string {
  return GATE_SITE_LABELS[site] ?? (site ? site.charAt(0).toUpperCase() + site.slice(1) : "Gate");
}

const STEP_WORDS: Record<string, string> = {
  opening: "opening the gate",
  email: "entering email",
  honor: "honor-system click",
  connect: "connecting accounts",
  repost: "reposting",
  verifying: "verifying",
  unlocked: "unlocked",
  signup: "signing up",
  downloading: "downloading",
};
export function gateStepWords(step: string | undefined): string | undefined {
  return step ? (STEP_WORDS[step] ?? step.toLowerCase()) : undefined;
}

export type GateCommand = "sc-toolkit-stop" | "sc-toolkit-resume" | "sc-toolkit-retry-failed" | "sc-toolkit-clear";

/** Same-origin command for the extension's content script. */
export function postGateCommand(type: GateCommand, extra?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  window.postMessage({ type, ...extra }, window.location.origin);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Lines of the summary, one per non-zero action. */
export const SUMMARY_LABELS: Record<SummaryKey, (n: number) => string> = {
  follow: (n) => `followed ${plural(n, "artist")}`,
  like: (n) => plural(n, "like"),
  comment: (n) => plural(n, "comment"),
  repost: (n) => plural(n, "repost"),
  emailSignup: (n) => plural(n, "email signup"),
  smsSignup: (n) => plural(n, "SMS signup"),
};

export function summaryParts(s: GateRunSummary): Array<{ key: SummaryKey | null; text: string }> {
  const parts: Array<{ key: SummaryKey | null; text: string }> = [{ key: null, text: plural(s.gates, "gate") }];
  for (const key of SUMMARY_KEYS) {
    const n = s.counts[key];
    if (n <= 0) continue;
    const base = SUMMARY_LABELS[key](n);
    parts.push({ key, text: key === "comment" && s.commentText ? `${base} (“${s.commentText}”)` : base });
  }
  return parts;
}

export function summaryLine(s: GateRunSummary): string {
  return `This run: ${summaryParts(s).map((p) => p.text).join(" · ")}`;
}

/** The copy-to-clipboard form: the line, then who each action touched. */
export function summaryText(s: GateRunSummary): string {
  const out = [summaryLine(s), `${plural(s.downloaded, "file")} downloaded, ${s.failed} failed`];
  const heading: Record<SummaryKey, string> = {
    follow: "Followed",
    like: "Liked",
    comment: "Commented on",
    repost: "Reposted",
    emailSignup: "Email signups",
    smsSignup: "SMS signups",
  };
  for (const key of SUMMARY_KEYS) {
    if (s.tracks[key].length === 0) continue;
    out.push("", `${heading[key]}:`, ...s.tracks[key].map((t) => `- ${t.artist ? `${t.artist} - ` : ""}${t.title}`));
  }
  if (s.actionsWithoutFile.length > 0) {
    out.push("", "Actions done without a file:", ...s.actionsWithoutFile.map((t) => `- ${t.artist ? `${t.artist} - ` : ""}${t.title} (${gateSiteLabel(t.site)}): ${t.reason}`));
  }
  return out.join("\n");
}
