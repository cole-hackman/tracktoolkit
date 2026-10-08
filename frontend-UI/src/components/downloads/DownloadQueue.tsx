"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button, Dialog, ProgressBar } from "@/components/ui";
import { pickDownloadFolder, saveToFolder } from "@/lib/download-folder";
import {
  EMPTY_QUEUE,
  type QueueItem,
  type QueueItemStatus,
  type QueueState,
  loadQueue,
  nextBatch,
  nextBatchSize,
  queueReducer,
  readMultiDownloadOk,
  saveMultiDownloadOk,
  saveQueue,
  summarize,
} from "@/lib/download-queue";

/**
 * Seconds between files handed to the browser. One navigation per file in
 * the helper tab; a second one too soon cancels the first before its
 * response arrives. 3 s also keeps SoundCloud's CDN traffic gentle: 500
 * tracks is about 25 minutes.
 */
const FILE_GAP_MS = 3000;
// The e2e suite shortens the gap through this window property; nothing in
// the app sets it.
const fileGapMs = () =>
  (typeof window !== "undefined" && (window as unknown as { __TT_QUEUE_GAP_MS?: number }).__TT_QUEUE_GAP_MS) || FILE_GAP_MS;

const STATUS_WORDS: Record<QueueItemStatus, string> = {
  pending: "Waiting",
  fetching: "Asking SoundCloud",
  started: "Downloading",
  saving: "Saving…",
  saved: "Saved",
  unavailable: "Not available",
  failed: "Failed",
  rate_limited: "Held — rate limit",
};

const STATUS_TONE: Record<QueueItemStatus, string> = {
  pending: "text-muted-foreground",
  fetching: "text-muted-foreground",
  started: "text-success-text",
  saving: "text-muted-foreground",
  saved: "text-success-text",
  unavailable: "text-muted-foreground",
  failed: "text-destructive-text",
  rate_limited: "text-warning-text",
};

const HELPER_TAB_TEXT =
  "Track Toolkit is handing your downloads to the browser from this tab. " +
  "If Chrome asks whether this site may download multiple files, click Allow — otherwise only the first file saves. " +
  "Keep this tab open until the queue finishes.";

/** What the check and the running note say about Chrome's prompt. */
const MULTI_DOWNLOAD_HELP =
  "Chrome lets a page start one download by itself and asks before the next. Look in the download tab for " +
  "“This site is trying to download multiple files” and click Allow. You only need to do this once per browser.";

/** The same question, worded for the helper tab itself (the prompt appears there). */
const HELPER_TAB_CHECK_HELP =
  "Chrome lets a page start one download by itself and asks before the next. If it asked here, click Allow, " +
  "then say whether the file saved. You only need to do this once per browser.";

const YES_LABEL = "Yes, it saved — continue";
const NO_LABEL = "No — try it again";

type Announce = (message: string, options?: { assertive?: boolean }) => void;

/**
 * Writes the helper tab's text — and, while the queue is waiting on the
 * check, the question itself with working buttons. The first time, Chrome's
 * multiple-downloads prompt appears in this tab and the user is looking at
 * it, not at the page that asked; a question only on the page went
 * unanswered live. Plain DOM, no styles beyond the browser's own.
 */
function paintHelperTab(
  tab: Window | null,
  text: string,
  question?: { title: string; onYes: () => void; onNo: () => void },
) {
  if (!tab || tab.closed) return;
  try {
    const doc = tab.document;
    doc.title = "Track Toolkit — downloads";
    const body = doc.body;
    body.replaceChildren();
    body.style.cssText = "font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 32px; max-width: 40rem; color-scheme: light dark";
    const note = doc.createElement("p");
    note.textContent = text;
    body.appendChild(note);
    if (!question) return;
    const heading = doc.createElement("h1");
    heading.textContent = `Did “${question.title}” save?`;
    heading.style.cssText = "font-size: 22px; margin: 24px 0 8px";
    const help = doc.createElement("p");
    help.textContent = HELPER_TAB_CHECK_HELP;
    const row = doc.createElement("div");
    row.style.cssText = "display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px";
    for (const [label, onClick] of [
      [YES_LABEL, question.onYes],
      [NO_LABEL, question.onNo],
    ] as const) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = "font: inherit; padding: 10px 16px; cursor: pointer";
      button.addEventListener("click", onClick);
      row.appendChild(button);
    }
    body.append(heading, help, row);
  } catch {
    /* not ours to write (a file is showing); the page's dialog still asks */
  }
}

/**
 * The queue's behaviour. Files go to the browser through ONE helper tab,
 * opened inside the click that starts (or resumes) the queue: the queue then
 * points that tab at each CDN link in turn. Opening a tab per file after an
 * await is a blocked popup, and navigating this page instead would leave it
 * if a file were ever served inline.
 */
export function useDownloadQueue(announce: Announce) {
  const [state, dispatch] = useReducer(queueReducer, EMPTY_QUEUE);
  const [hydrated, setHydrated] = useState(false);
  const stateRef = useRef<QueueState>(state);
  stateRef.current = state;
  const tabRef = useRef<Window | null>(null);
  const busyRef = useRef(false);
  // Has this browser been through Chrome's multiple-downloads prompt?
  const [multiOk, setMultiOk] = useState(false);
  const multiOkRef = useRef(false);
  // The check as a modal: shown whenever a check arrives (including on a
  // reload with one pending), dismissable, and brought back by Download all.
  const [checkOpen, setCheckOpen] = useState(false);
  useEffect(() => {
    if (state.check) setCheckOpen(true);
  }, [state.check]);

  useEffect(() => {
    dispatch({ type: "load", state: loadQueue(typeof window === "undefined" ? null : window.localStorage) });
    const ok = readMultiDownloadOk(typeof window === "undefined" ? null : window.localStorage);
    multiOkRef.current = ok;
    setMultiOk(ok);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveQueue(window.localStorage, state);
  }, [state, hydrated]);

  const openHelperTab = useCallback(() => {
    if (tabRef.current && !tabRef.current.closed) return true;
    const tab = window.open("about:blank", "_blank");
    if (!tab) return false;
    tab.opener = null;
    try {
      tab.document.title = "Track Toolkit — downloads";
      tab.document.body.textContent = HELPER_TAB_TEXT;
    } catch {
      /* not ours to write; it still works as a download target */
    }
    tabRef.current = tab;
    return true;
  }, []);

  // The helper tab's buttons call whatever these are *now*, not what they
  // were when the question was painted.
  const confirmSavedRef = useRef<() => void>(() => {});
  const retryCheckedRef = useRef<() => void>(() => {});

  const popupBlocked = "Your browser blocked the download tab. Allow pop-ups for this site, then Resume.";
  const noFolder = "Choose a folder to continue, or clear the queue.";

  // Folder mode: the picked directory (memory only — a reload forgets it)
  // and the save in progress, so Pause can abandon a half-written file.
  const dirRef = useRef<FileSystemDirectoryHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Call from a click handler: it opens the helper tab, or — with `folder` —
   * the directory picker (both need the user's gesture). With the picker
   * closed, nothing is queued.
   */
  const begin = useCallback(
    async (sourceTitle: string, items: Array<Omit<QueueItem, "status" | "reason" | "fileName">>, options: { folder?: boolean } = {}) => {
      if (stateRef.current.check) {
        // Nothing is replaced until the question is answered — bring it back.
        setCheckOpen(true);
        announce(`Answer first: did ${stateRef.current.check.title} save?`, { assertive: true });
        return;
      }
      const plural = `${items.length} track${items.length === 1 ? "" : "s"}`;
      if (options.folder) {
        const dir = await pickDownloadFolder();
        if (!dir) {
          announce("No folder chosen — nothing was queued.", { assertive: true });
          return;
        }
        dirRef.current = dir;
        dispatch({ type: "enqueue", sourceTitle, items, mode: "folder" });
        dispatch({ type: "start" });
        announce(`Saving ${plural} from ${sourceTitle} into ${dir.name}`);
        return;
      }
      dispatch({ type: "enqueue", sourceTitle, items, mode: "tab" });
      if (!openHelperTab()) {
        dispatch({ type: "pause", reason: popupBlocked });
        return;
      }
      dispatch({ type: "start" });
      announce(`Downloading ${plural} from ${sourceTitle}`);
    },
    [announce, openHelperTab],
  );

  /** Call from a click handler: it may reopen the helper tab, or re-ask for the folder. */
  const resume = useCallback(async () => {
    if (stateRef.current.mode === "folder") {
      if (!dirRef.current) {
        const dir = await pickDownloadFolder();
        if (!dir) {
          dispatch({ type: "pause", reason: noFolder });
          return;
        }
        dirRef.current = dir;
      }
      dispatch({ type: "start" });
      return;
    }
    if (!openHelperTab()) {
      dispatch({ type: "pause", reason: popupBlocked });
      return;
    }
    dispatch({ type: "start" });
  }, [openHelperTab]);

  const pause = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "pause", reason: "Paused." });
  }, []);

  /** "Yes, it saved": remember it for this browser and carry on. From a click. */
  const confirmSaved = useCallback(() => {
    saveMultiDownloadOk(window.localStorage);
    multiOkRef.current = true;
    setMultiOk(true);
    setCheckOpen(false);
    dispatch({ type: "confirmSaved" });
    paintHelperTab(tabRef.current, HELPER_TAB_TEXT);
    resume();
  }, [resume]);

  /** "No": hand that file to the browser again. From a click. */
  const retryChecked = useCallback(() => {
    setCheckOpen(false);
    dispatch({ type: "retryChecked" });
    paintHelperTab(tabRef.current, HELPER_TAB_TEXT);
    resume();
  }, [resume]);
  confirmSavedRef.current = confirmSaved;
  retryCheckedRef.current = retryChecked;

  /** Hide the modal; the queue stays waiting and Download all re-asks. */
  const dismissCheck = useCallback(() => setCheckOpen(false), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    dirRef.current = null;
    dispatch({ type: "clear" });
    try {
      tabRef.current?.close();
    } catch {
      /* already gone */
    }
    tabRef.current = null;
  }, []);

  // One batch at a time while running; each finished batch changes state,
  // which brings the effect back for the next one.
  useEffect(() => {
    if (!state.running || busyRef.current) return;
    const batch = nextBatch(state, nextBatchSize(state, multiOkRef.current));
    const startedBefore = state.items.filter((i) => i.status === "started").length;
    let handed = 0;
    if (batch.length === 0) return;
    busyRef.current = true;
    // Set whenever this batch pauses the queue itself, so the cleanup below
    // cannot read a not-yet-rendered `running: true` and restart it.
    let stopped = false;
    const stop = (reason: string) => {
      stopped = true;
      dispatch({ type: "pause", reason });
    };

    (async () => {
      dispatch({ type: "fetching", trackIds: batch.map((i) => i.trackId) });
      let response: Response;
      try {
        response = await apiFetch("/api/downloads/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: batch.map((i) => i.downloadUrl) }),
        });
      } catch {
        stop("Lost the connection to Track Toolkit. Resume when you're back online.");
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof data?.error === "string" ? data.error : "Track Toolkit could not fetch download links.";
        stop(response.status === 429 ? `${message} Resume later.` : message);
        return;
      }

      const results: Array<{ status: string; link?: string; reason?: string }> = Array.isArray(data?.results) ? data.results : [];
      for (let i = 0; i < batch.length; i++) {
        if (!stateRef.current.running) return; // paused mid-batch; pause put the rest back
        const item = batch[i];
        const result = results[i];
        if (result?.status === "ok" && typeof result.link === "string" && state.mode === "folder") {
          const dir = dirRef.current;
          if (!dir) {
            stop(noFolder);
            return;
          }
          dispatch({ type: "saving", trackId: item.trackId });
          const controller = new AbortController();
          abortRef.current = controller;
          try {
            const { fileName } = await saveToFolder(dir, item, result.link, controller.signal);
            dispatch({ type: "result", trackId: item.trackId, status: "saved", fileName });
          } catch (error) {
            if (controller.signal.aborted) return; // paused: the pause put it back to waiting
            const reason = error instanceof Error && error.message ? error.message : "Could not save the file.";
            dispatch({ type: "result", trackId: item.trackId, status: "failed", reason });
          } finally {
            abortRef.current = null;
          }
          await new Promise((r) => setTimeout(r, fileGapMs()));
        } else if (result?.status === "ok" && typeof result.link === "string") {
          const tab = tabRef.current;
          if (!tab || tab.closed) {
            stop("The download tab was closed. Resume to reopen it.");
            return;
          }
          tab.location.href = result.link;
          dispatch({ type: "result", trackId: item.trackId, status: "started" });
          handed++;
          // Chrome may now be holding this file behind its "download
          // multiple files" prompt, which this page cannot see. Until the
          // user has confirmed once, stop here and ask.
          if (!multiOkRef.current && startedBefore + handed >= 2) {
            stopped = true;
            dispatch({ type: "check", trackId: item.trackId, title: item.title });
            paintHelperTab(tabRef.current, HELPER_TAB_TEXT, {
              title: item.title,
              onYes: () => confirmSavedRef.current(),
              onNo: () => retryCheckedRef.current(),
            });
            announce(`Check the download tab: did ${item.title} save?`, { assertive: true });
            return;
          }
          await new Promise((r) => setTimeout(r, fileGapMs()));
        } else if (result?.status === "unavailable") {
          dispatch({ type: "result", trackId: item.trackId, status: "unavailable", reason: result.reason });
        } else if (result?.status === "rate_limited") {
          dispatch({ type: "result", trackId: item.trackId, status: "rate_limited" });
        } else {
          dispatch({ type: "result", trackId: item.trackId, status: "failed", reason: result?.reason || "No link came back." });
        }
      }
      if (data?.rateLimited) {
        stop("SoundCloud asked us to slow down. Wait a few minutes, then Resume.");
      }
    })().finally(() => {
      busyRef.current = false;
      // Wake the effect for the next batch: the results above changed state
      // while busy, so nothing else would bring it back.
      if (!stopped && stateRef.current.running) dispatch({ type: "start" });
    });
  }, [state, announce]);

  // Say when it finishes, once.
  const finishedRef = useRef(false);
  const summary = summarize(state);
  useEffect(() => {
    const done = summary.total > 0 && summary.waiting === 0 && !state.running;
    if (done && !finishedRef.current) {
      finishedRef.current = true;
      const handed = state.mode === "folder" ? `${summary.saved} saved` : `${summary.started} started`;
      announce(`Download queue finished: ${handed}, ${summary.unavailable} not available, ${summary.failed} failed`, { assertive: true });
      paintHelperTab(tabRef.current, "Done — every file has been handed to the browser. You can close this tab.");
    }
    if (!done) finishedRef.current = false;
  }, [summary.total, summary.waiting, summary.started, summary.saved, summary.unavailable, summary.failed, state.running, state.mode, announce]);

  return { state, summary, begin, resume, pause, clear, confirmSaved, retryChecked, checkOpen, dismissCheck, multiOk, hydrated };
}

interface CheckDialogProps {
  check: QueueState["check"];
  open: boolean;
  onClose: () => void;
  onConfirmSaved: () => void;
  onRetryChecked: () => void;
}

/**
 * The check as a modal, on every width. It used to be a card inside the
 * queue panel only — on a desktop in the side column, on anything narrower
 * behind a grey "check needed" bar — and live it went unanswered: the user
 * pressed Download all again, which replaced the queue, and every run stopped
 * at two files. Mounted once by the page, outside the panel and the sheet.
 */
export function DownloadCheckDialog({ check, open, onClose, onConfirmSaved, onRetryChecked }: CheckDialogProps) {
  const yesRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open && !!check}
      onClose={onClose}
      title={`Did “${check?.title ?? ""}” save?`}
      description={MULTI_DOWNLOAD_HELP}
      size="sm"
      initialFocusRef={yesRef}
      footer={
        <div className="flex flex-wrap gap-2">
          <Button ref={yesRef} onClick={onConfirmSaved}>
            {YES_LABEL}
          </Button>
          <Button variant="secondary" onClick={onRetryChecked}>
            {NO_LABEL}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">
        The queue is waiting on your answer; nothing else downloads until then. “No” hands the same file to the
        browser again.
      </p>
    </Dialog>
  );
}

interface PanelProps {
  state: QueueState;
  summary: ReturnType<typeof summarize>;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onConfirmSaved: () => void;
  onRetryChecked: () => void;
  /** This browser already allowed multiple downloads (no running note). */
  multiOk: boolean;
  /** The panel's own heading; omitted inside the Dialog, which has its title. */
  showHeading?: boolean;
}

export function DownloadQueuePanel({
  state,
  summary,
  onPause,
  onResume,
  onClear,
  onConfirmSaved,
  onRetryChecked,
  multiOk,
  showHeading = true,
}: PanelProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={showHeading ? headingId : undefined} aria-label={showHeading ? undefined : "Download queue"} className="space-y-3">
      {showHeading && (
        <h2 id={headingId} className="text-base font-bold text-foreground">
          Download queue
        </h2>
      )}
      <p className="text-sm text-muted-foreground">
        SoundCloud downloads from <span className="font-medium text-foreground">{state.sourceTitle}</span>
        {state.mode === "folder" && <> — saved into your folder as “Artist - Title”</>}
      </p>
      <ProgressBar
        label={state.running ? (state.mode === "folder" ? "Saving" : "Downloading") : summary.waiting > 0 ? "Paused" : "Finished"}
        value={summary.finished}
        max={Math.max(summary.total, 1)}
        detail={`${state.mode === "folder" ? `${summary.saved} saved` : `${summary.started} started`} · ${summary.unavailable} not available · ${summary.failed} failed`}
      />
      {state.check && (
        <div className="space-y-2 rounded-md border border-border bg-card p-3" role="status">
          <p className="text-sm font-semibold text-foreground">Did “{state.check.title}” save?</p>
          <p className="text-sm text-muted-foreground">{MULTI_DOWNLOAD_HELP}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onConfirmSaved}>
              {YES_LABEL}
            </Button>
            <Button size="sm" variant="secondary" onClick={onRetryChecked}>
              {NO_LABEL}
            </Button>
          </div>
        </div>
      )}
      {state.running && !multiOk && state.mode !== "folder" && summary.total > 1 && (
        <p className="text-sm text-muted-foreground">{MULTI_DOWNLOAD_HELP}</p>
      )}
      {state.pausedReason && !state.running && (
        <p className="text-sm text-warning-text" role="status">
          {state.pausedReason}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {state.running ? (
          <Button variant="secondary" size="sm" onClick={onPause}>
            <Pause className="h-4 w-4" aria-hidden="true" />
            Pause
          </Button>
        ) : summary.waiting > 0 && !state.check ? (
          <Button size="sm" onClick={onResume}>
            <Play className="h-4 w-4" aria-hidden="true" />
            Resume ({summary.waiting} left)
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClear}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Clear queue
        </Button>
      </div>
      <ul className="max-h-80 space-y-1 overflow-y-auto pr-1 text-sm" aria-label="Queued tracks">
        {state.items.map((item) => (
          <li key={item.trackId} className="flex min-w-0 items-baseline justify-between gap-2 border-b border-border py-1.5 last:border-0">
            <span className="min-w-0 text-foreground">
              <span className="block truncate">
                {item.title}
                <span className="text-muted-foreground"> — {item.artist}</span>
              </span>
              {item.fileName && <span className="block truncate text-xs text-muted-foreground">{item.fileName}</span>}
            </span>
            <span className={`shrink-0 text-xs font-medium ${STATUS_TONE[item.status]}`}>
              {STATUS_WORDS[item.status]}
            </span>
            {item.reason && <span className="sr-only">: {item.reason}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Mobile: a bar at the foot of the screen that opens the queue as a sheet. */
export function DownloadQueueSheet(props: Omit<PanelProps, "showHeading">) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { summary, state } = props;
  // The check arrives as its own dialog; two modals must not stack.
  useEffect(() => {
    if (state.check) setOpen(false);
  }, [state.check]);
  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card px-4 py-3 lg:hidden">
        <Button ref={triggerRef} className="w-full" variant="secondary" onClick={() => setOpen(true)}>
          Download queue ·{" "}
          {state.check
            ? "check needed"
            : state.running
              ? `${summary.waiting} left`
              : summary.waiting > 0
                ? `paused, ${summary.waiting} left`
                : "finished"}
        </Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Download queue" variant="sheet" size="md" returnFocusRef={triggerRef}>
        <DownloadQueuePanel {...props} showHeading={false} />
      </Dialog>
    </>
  );
}
