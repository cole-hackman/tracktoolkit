"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Moon, RefreshCw, Sun } from "lucide-react";
import { BrandMark } from "@/components/brand/Logo";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";
import { fmtClock } from "./format";
import { Segmented } from "./primitives";
import { POLL_MS } from "./queries";
import { DEFAULT_OPS_FILTER, PERIODS, VIEWS, type OperationsFilter, type Period, type View } from "./types";
import { ArchiveView } from "./views/ArchiveView";
import { CatalogView } from "./views/catalog/CatalogView";
import { DownloadsView } from "./views/DownloadsView";
import { FeedbackView } from "./views/FeedbackView";
import { OperationsView } from "./views/OperationsView";
import { OverviewView } from "./views/OverviewView";
import { PerformanceView } from "./views/PerformanceView";

const PERIOD_KEY = "track-toolkit-admin-period";

function isView(value: string): value is View {
  return VIEWS.some((v) => v.id === value);
}

function isPeriod(value: string | null): value is Period {
  return PERIODS.some((p) => p.value === value);
}

// The hash is `#<view>` or `#<view>/<sub>` (the Catalog view owns its sub-part).
function readHashView(): View {
  if (typeof window === "undefined") return "overview";
  const raw = window.location.hash.replace(/^#/, "").split("/")[0];
  return isView(raw) ? raw : "overview";
}

/* ── Sync readout: its own component so the ticking clock re-renders only itself ── */

function SyncReadout() {
  const fetching = useIsFetching({ queryKey: ["admin"] });
  const queryClient = useQueryClient();
  const [lastSync, setLastSync] = React.useState<number | null>(null);
  const wasFetching = React.useRef(false);

  React.useEffect(() => {
    if (wasFetching.current && fetching === 0) setLastSync(Date.now());
    wasFetching.current = fetching > 0;
  }, [fetching]);

  // Re-render once a minute so "synced 12:04:31" never looks frozen for hours.
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  const refreshAll = () => queryClient.invalidateQueries({ queryKey: ["admin"] });

  return (
    <button
      type="button"
      onClick={refreshAll}
      title={`Live views re-poll every ${POLL_MS / 1000}s while this tab is visible. Click to refresh now.`}
      className="inline-flex h-8 items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
    >
      <span className="relative flex h-2 w-2">
        {fetching > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-chart-4 opacity-75" />}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", fetching > 0 ? "bg-chart-4" : "bg-chart-3")} />
      </span>
      <span className="hidden sm:inline">{fetching > 0 ? "syncing" : lastSync ? `synced ${fmtClock(lastSync)}` : "live"}</span>
      <RefreshCw className={cn("h-3.5 w-3.5", fetching > 0 && "animate-spin")} aria-hidden="true" />
      <span className="sr-only">Refresh all data</span>
    </button>
  );
}

/* ── Access states ─────────────────────────────────────────────────────── */

function Gate({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="admin-reveal w-full max-w-md rounded-xl border border-border/70 bg-card/85 p-6 text-center shadow-sm">
        <BrandMark className="mx-auto h-8 w-8" title="" />
        <h1 className="mt-4 font-display text-lg font-semibold text-foreground">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/* ── Console ───────────────────────────────────────────────────────────── */

export function AdminConsole() {
  const router = useRouter();
  const { user, isAuthenticated, loading: authLoading, apiUnreachable, retryAuth } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const [view, setViewState] = React.useState<View>("overview");
  const [period, setPeriodState] = React.useState<Period>("30d");
  const [opsFilter, setOpsFilter] = React.useState<OperationsFilter>(DEFAULT_OPS_FILTER);

  // Restore the view from the URL hash and the period from localStorage.
  React.useEffect(() => {
    setViewState(readHashView());
    try {
      const stored = localStorage.getItem(PERIOD_KEY);
      if (isPeriod(stored)) setPeriodState(stored);
    } catch {
      /* ignore */
    }
    const onHash = () => setViewState(readHashView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setView = React.useCallback((next: View) => {
    setViewState(next);
    if (typeof window !== "undefined") {
      const url = `${window.location.pathname}${window.location.search}#${next}`;
      window.history.replaceState(null, "", url);
    }
  }, []);

  const setPeriod = (next: Period) => {
    setPeriodState(next);
    try {
      localStorage.setItem(PERIOD_KEY, next);
    } catch {
      /* ignore */
    }
  };

  // Not signed in at all → the login page, same as any protected tool.
  React.useEffect(() => {
    if (!authLoading && !apiUnreachable && !isAuthenticated) router.replace("/login");
  }, [authLoading, apiUnreachable, isAuthenticated, router]);

  // Number keys switch views when focus is not in a field.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < VIEWS.length) setView(VIEWS[idx].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  const isAdmin = !!user?.isAdmin;
  const enabled = isAuthenticated && isAdmin;

  const inspectErrorCode = (code: string) => {
    setOpsFilter({ ...DEFAULT_OPS_FILTER, status: "error", search: code });
    setView("operations");
  };
  const inspectAction = (action: string) => {
    setOpsFilter({ ...DEFAULT_OPS_FILTER, action });
    setView("operations");
  };

  if (authLoading) {
    return <Gate title="Checking access…" />;
  }
  if (apiUnreachable) {
    return (
      <Gate title="The API is unreachable">
        <p className="mt-2 text-sm text-muted-foreground">The console could not reach the server to check your session.</p>
        <button type="button" onClick={retryAuth} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          Try again
        </button>
      </Gate>
    );
  }
  if (!isAuthenticated) {
    return <Gate title="Redirecting to sign in…" />;
  }
  if (!isAdmin) {
    return (
      <Gate title="This console is for administrators">
        <p className="mt-2 text-sm text-muted-foreground">
          You are signed in as <span className="font-mono text-foreground">@{user?.username}</span>, which is not on the admin list.
        </p>
        <Link href="/dashboard" className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the app
        </Link>
      </Gate>
    );
  }

  const activeView = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  return (
    <div className="admin-console min-h-screen text-foreground">
      <header
        className="sticky z-40 border-b border-border/70 bg-background/85 backdrop-blur-md"
        style={{ top: "var(--announcement-h)" }}
      >
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2.5 rounded-md pr-1 hover:opacity-90" title="Back to the app">
            <BrandMark className="h-6 w-6" title="" />
            <span className="font-display text-[15px] font-semibold tracking-tight">Track Toolkit</span>
            <span className="rounded bg-primary/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-text">Admin</span>
          </Link>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Segmented
              label="Time window"
              options={PERIODS.map((p) => ({ value: p.value, label: p.label, title: p.long }))}
              value={period}
              onChange={setPeriod}
            />
            <SyncReadout />
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:text-foreground"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </div>

        <nav aria-label="Console sections" className="mx-auto max-w-[1440px] px-4 sm:px-6">
          <div role="tablist" className="-mb-px flex gap-1 overflow-x-auto">
            {VIEWS.map((v, i) => {
              const active = v.id === view;
              return (
                <button
                  key={v.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  aria-controls={`admin-view-${v.id}`}
                  id={`admin-tab-${v.id}`}
                  title={`${v.hint} (${i + 1})`}
                  onClick={() => setView(v.id)}
                  className={cn(
                    "relative shrink-0 px-3 pb-2.5 pt-2 font-mono text-[12px] font-medium tracking-wide transition-colors",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="mr-1.5 text-[10px] text-muted-foreground/70" aria-hidden="true">{i + 1}</span>
                  {v.label}
                  {active && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-primary" />}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main
        id="main-content"
        role="tabpanel"
        aria-labelledby={`admin-tab-${activeView.id}`}
        className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 sm:py-5"
      >
        <div key={view} id={`admin-view-${view}`}>
          {view === "overview" && (
            <OverviewView period={period} enabled={enabled} onInspectErrorCode={inspectErrorCode} onInspectAction={inspectAction} />
          )}
          {view === "operations" && <OperationsView period={period} enabled={enabled} filter={opsFilter} onFilterChange={setOpsFilter} />}
          {view === "performance" && <PerformanceView period={period} enabled={enabled} onInspectAction={inspectAction} />}
          {view === "catalog" && <CatalogView period={period} enabled={enabled} />}
          {view === "downloads" && <DownloadsView period={period} enabled={enabled} />}
          {/* The inbox takes no period: it is a queue, not a time series. */}
          {view === "feedback" && <FeedbackView enabled={enabled} />}
          {view === "archive" && <ArchiveView enabled={enabled} />}
        </div>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 py-4 font-mono text-[11px] text-muted-foreground">
          <span>Track Toolkit admin console · signed in as @{user?.username}</span>
          <span>Press 1–{VIEWS.length} to switch sections · live views re-poll every {POLL_MS / 1000}s while visible</span>
        </footer>
      </main>
    </div>
  );
}
