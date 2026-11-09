"use client";

import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import {
  GATE_PROGRESS_KEY,
  batchReport,
  gateReportKey,
  loadReported,
  pendingGateResults,
  saveReported,
} from "@/lib/gate-usage";

/**
 * Renders nothing. For accounts that can run the extension's queue, forwards
 * how each gate ended (Hypeddit, Droploud, Cobrand) to
 * `POST /api/downloads/gate-results`, so the admin console can see gate
 * downloads next to the direct ones.
 *
 * Mounted by the app layout, not the Downloads page: the extension broadcasts
 * progress to every Track Toolkit tab, and a run keeps going after you leave
 * the page that started it. The progress it sends is also kept in
 * localStorage, so a tab opened later reports what it missed.
 *
 * Only outcomes the extension already holds are sent: the track id, the gate
 * site, done or failed, the title and artist from the queue item, the failure
 * reason and the account actions it took. Nothing is read from the gate pages.
 */
export function GateUsageReporter() {
  const { user } = useAuth();
  const canDownload = !!user?.canDownload;
  // Outcomes already sent, or on their way; the storage copy survives a reload.
  const reportedRef = useRef<Set<string> | null>(null);
  const busyRef = useRef(false);
  const againRef = useRef<unknown>(null);

  useEffect(() => {
    if (!canDownload) return;
    reportedRef.current = loadReported(window.localStorage);

    const send = async (progress: unknown) => {
      if (busyRef.current) {
        // One report at a time; the newest progress is looked at when it ends.
        againRef.current = progress;
        return;
      }
      const reported = reportedRef.current ?? new Set<string>();
      const report = pendingGateResults(progress, reported);
      if (!report) return;
      busyRef.current = true;
      try {
        for (const batch of batchReport(report)) {
          const res = await apiFetch("/api/downloads/gate-results", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch),
          });
          // 4xx: the server will not take this batch, now or on a retry. Count it
          // as handled so one bad row cannot be resent on every progress update.
          // 5xx and network errors fall through to the catch and are retried.
          if (res.ok || (res.status >= 400 && res.status < 500)) {
            for (const r of batch.results) reported.add(gateReportKey(batch.runId, r.id, r.status));
            reportedRef.current = reported;
            saveReported(window.localStorage, reported);
          } else {
            break;
          }
        }
      } catch {
        /* offline or a server error: the next progress update tries again */
      } finally {
        busyRef.current = false;
        const next = againRef.current;
        againRef.current = null;
        if (next) void send(next);
      }
    };

    const onProgress = (event: Event) => void send((event as CustomEvent).detail);
    window.addEventListener("sc-toolkit-progress-update", onProgress);

    // A tab opened after the run finished: report what the stored copy holds.
    try {
      const stored = window.localStorage.getItem(GATE_PROGRESS_KEY);
      if (stored) void send(JSON.parse(stored));
    } catch {
      /* no stored progress, or storage blocked */
    }

    return () => window.removeEventListener("sc-toolkit-progress-update", onProgress);
  }, [canDownload]);

  return null;
}
