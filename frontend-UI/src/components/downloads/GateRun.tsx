"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Copy, ExternalLink, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { Button, ConfirmDialog, ProgressBar, useAnnounce } from "@/components/ui";
import {
  gateSiteLabel,
  gateStepWords,
  postGateCommand,
  summaryParts,
  summaryText,
  type GateRun,
  type GateRunItem,
  type GateRunStatus,
  type GateRunSummary,
  type SummaryKey,
} from "@/lib/gate-run";

const STATUS_WORDS: Record<GateRunStatus, string> = {
  waiting: "Waiting",
  running: "Running",
  saving: "Saving",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_TONE: Record<GateRunStatus, string> = {
  waiting: "text-muted-foreground",
  running: "text-info-text",
  saving: "text-info-text",
  done: "text-success-text",
  failed: "text-destructive-text",
  skipped: "text-muted-foreground",
};

const SETTLED: GateRunStatus[] = ["done", "failed", "skipped"];

function itemLine(item: GateRunItem): string {
  const site = gateSiteLabel(item.site);
  if (item.status === "running") {
    const step = gateStepWords(item.step);
    return step ? `${site} · ${step}` : site;
  }
  return site;
}

/**
 * Says when a gate lands on done or failed, and when the run ends, once each.
 * Mounted once by the page (the section itself renders twice, in the side
 * column and the sheet). The first payload only sets the baseline, so
 * reloading with a finished run in storage is silent.
 */
export function useGateAnnouncements(run: GateRun | null, announce: ReturnType<typeof useAnnounce>) {
  const seen = useRef<{ runId: string | null; status: Map<number, GateRunStatus>; active: boolean } | null>(null);
  useEffect(() => {
    if (!run || run.version !== 2) {
      seen.current = null;
      return;
    }
    const prev = seen.current;
    const next = new Map(run.items.map((i) => [i.id, i.status] as const));
    seen.current = { runId: run.runId, status: next, active: run.active };
    if (!prev || prev.runId !== run.runId) return;
    const lines: string[] = [];
    for (const item of run.items) {
      const before = prev.status.get(item.id);
      if (!before || before === item.status) continue;
      if (item.status === "done") lines.push(`${item.title} done`);
      else if (item.status === "failed") lines.push(`${item.title} failed${item.reason ? `: ${item.reason}` : ""}`);
    }
    if (lines.length > 0) {
      const shown = lines.slice(0, 3).join(". ");
      announce(lines.length > 3 ? `${shown}. And ${lines.length - 3} more` : shown);
    }
    if (prev.active && !run.active) {
      const done = run.items.filter((i) => i.status === "done").length;
      const failed = run.items.filter((i) => i.status === "failed").length;
      announce(`Gate run finished: ${done} done, ${failed} failed`, { assertive: true });
    }
  }, [run, announce]);
}

function Chip({ status }: { status: GateRunStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {STATUS_WORDS[status]}
    </span>
  );
}

const linkClass =
  "inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-xs font-medium text-primary-text underline underline-offset-2";

function GateRow({ item, onRetry }: { item: GateRunItem; onRetry: (id: number) => void }) {
  return (
    <li className="min-w-0 border-b border-border py-2 last:border-0">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 text-sm text-foreground">
          <span className="block truncate">
            {item.title}
            {item.artist && <span className="text-muted-foreground"> {"—"} {item.artist}</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{itemLine(item)}</span>
        </span>
        <Chip status={item.status} />
      </div>
      {item.reason && (item.status === "failed" || item.status === "skipped") && (
        <p className={`mt-1 break-words text-xs ${item.status === "failed" ? "text-destructive-text" : "text-muted-foreground"}`}>{item.reason}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        {item.gateUrl && (
          <a href={item.gateUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
            Open gate
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only"> for {item.title} (opens in a new tab)</span>
          </a>
        )}
        {item.status === "failed" && (
          <button type="button" className={linkClass} onClick={() => onRetry(item.id)}>
            Retry<span className="sr-only"> {item.title}</span>
          </button>
        )}
      </div>
    </li>
  );
}

function SummaryCount({ label, tracks, open, onToggle }: { label: string; tracks: GateRunSummary["tracks"][SummaryKey]; open: boolean; onToggle: () => void }) {
  const panelId = useId();
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-left text-sm text-foreground"
      >
        <span className="min-w-0 break-words">{label}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <ul id={panelId} hidden={!open} className="mb-1 space-y-0.5 pl-3 text-xs text-muted-foreground" aria-label={`${label}, tracks`}>
        {tracks.map((t) => (
          <li key={t.id} className="break-words">
            {t.title}
            {t.artist && <> {"—"} {t.artist}</>}
          </li>
        ))}
      </ul>
    </li>
  );
}

function RunSummary({ summary }: { summary: GateRunSummary }) {
  const announce = useAnnounce();
  const [open, setOpen] = useState<Partial<Record<SummaryKey, boolean>>>({});
  const parts = summaryParts(summary).filter((p) => p.key !== null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText(summary));
      announce("Summary copied");
    } catch {
      announce("Could not copy the summary", { assertive: true });
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-3" aria-label="Run summary" role="group">
      <p className="text-sm font-semibold text-foreground">This run: {summary.gates} {summary.gates === 1 ? "gate" : "gates"}</p>
      {parts.length > 0 && (
        <ul className="divide-y divide-border">
          {parts.map((p) => (
            <SummaryCount
              key={p.key}
              label={p.text}
              tracks={summary.tracks[p.key as SummaryKey]}
              open={!!open[p.key as SummaryKey]}
              onToggle={() => setOpen((o) => ({ ...o, [p.key as SummaryKey]: !o[p.key as SummaryKey] }))}
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {summary.downloaded} downloaded {"·"} {summary.failed} failed
      </p>
      {summary.actionsWithoutFile.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-foreground">Actions done without a file</h4>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {summary.actionsWithoutFile.map((t) => (
              <li key={t.id} className="break-words">
                <span className="text-foreground">{t.title}</span>
                {t.artist && <> {"—"} {t.artist}</>} ({gateSiteLabel(t.site)}){t.reason && <>: {t.reason}</>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="secondary" size="sm" onClick={copy}>
        <Copy className="h-4 w-4" aria-hidden="true" />
        Copy summary
      </Button>
    </div>
  );
}

/** Per-gate progress from the extension, with its controls and the run summary. */
export function GateRunSection({ run, onCleared }: { run: GateRun; onCleared: () => void }) {
  const headingId = useId();
  const [confirmClear, setConfirmClear] = useState(false);
  const settled = run.items.filter((i) => SETTLED.includes(i.status)).length;
  const done = run.items.filter((i) => i.status === "done").length;
  const failed = run.items.filter((i) => i.status === "failed").length;
  const waiting = run.items.some((i) => i.status === "waiting");
  const detail = [`${done} done`, failed > 0 ? `${failed} failed` : null].filter(Boolean).join(" · ");
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-sm font-bold text-foreground">
        Gates
      </h3>
      {run.items.length > 0 && (
        <ProgressBar
          label={run.active ? "Working gates" : waiting ? "Gates paused" : "Gates finished"}
          value={settled}
          max={run.items.length}
          detail={detail}
        />
      )}
      {run.notice && (
        <p className="text-sm text-warning-text" role="status">
          {run.notice}
        </p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Gate controls">
        {run.active ? (
          <Button variant="secondary" size="sm" onClick={() => postGateCommand("sc-toolkit-stop")}>
            <Pause className="h-4 w-4" aria-hidden="true" />
            Stop gates
          </Button>
        ) : (
          waiting && (
            <Button size="sm" onClick={() => postGateCommand("sc-toolkit-resume")}>
              <Play className="h-4 w-4" aria-hidden="true" />
              Resume gates
            </Button>
          )
        )}
        {failed > 0 && (
          <Button variant="secondary" size="sm" onClick={() => postGateCommand("sc-toolkit-retry-failed")}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Retry failed gates ({failed})
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Clear gates
        </Button>
      </div>
      {run.summary && <RunSummary summary={run.summary} />}
      {run.items.length > 0 && (
        <ul className="max-h-80 overflow-y-auto pr-1" aria-label="Gates">
          {run.items.map((item) => (
            <GateRow key={item.id} item={item} onRetry={(id) => postGateCommand("sc-toolkit-retry-failed", { ids: [id] })} />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirmClear}
        title="Clear the gate queue?"
        description="The extension forgets the gates still in line. Run history and summaries are kept."
        confirmLabel="Clear gates"
        variant="destructive"
        onConfirm={() => {
          setConfirmClear(false);
          postGateCommand("sc-toolkit-clear");
          onCleared();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}
