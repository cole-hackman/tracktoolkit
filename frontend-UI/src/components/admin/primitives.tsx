"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/Skeleton";
import { fmtInt } from "./format";
import type { OpStatus } from "./types";

/* ── Tone → token classes ─────────────────────────────────────────────── */

export type Tone = "primary" | "ok" | "warn" | "danger" | "info" | "muted";

/**
 * The tone maps split into three because the three uses have three different
 * contrast floors, and reusing one colour across them is what broke here.
 *
 * `TONE_BG` paints bars and dots — graphical objects, 3:1 under 1.4.11 — so
 * it keeps the `--chart-*` data-viz colours. `TONE_TEXT` and `TONE_SOFT` are
 * text, which needs 4.5:1, so both use the `*-text` tokens the app already
 * declares for exactly that (`globals.css`: "Never use --primary for small
 * text"). Before 2026-09-22 all three used `--chart-*`/`--primary`, which put
 * a 10px `TONE_SOFT.warn` pill at **1.43:1** and `StatusPill` SPLIT at
 * 1.42:1.
 *
 * **`scripts/contrast-check.mjs` parses these two maps out of this file** and
 * turns every entry into a gated pair, so editing a class here changes what
 * `npm run contrast` measures. It does not hold a copy of them: it held one
 * for about an hour, and a copy cannot notice its original changing — putting
 * `text-chart-3` back on `ok` left the gate reporting 115 passing pairs. Keep
 * the shape it parses: one `bg-…` and one `text-…` per `TONE_SOFT` entry, one
 * `text-…` per `TONE_TEXT` entry, each on its own line in a double-quoted
 * string. Adding a seventh tone fails the gate until `EXPECTED_TONES` there
 * is updated, which is the prompt to check the new tone's numbers.
 */
export const TONE_TEXT: Record<Tone, string> = {
  primary: "text-primary-text",
  ok: "text-success-text",
  warn: "text-warning-text",
  danger: "text-destructive-text",
  info: "text-info-text",
  muted: "text-muted-foreground",
};

export const TONE_BG: Record<Tone, string> = {
  primary: "bg-primary",
  ok: "bg-chart-3",
  warn: "bg-chart-4",
  danger: "bg-destructive",
  info: "bg-chart-2",
  muted: "bg-muted-foreground",
};

/**
 * The tint half is unchanged — the hue is what tells one pill from another,
 * and every pill also carries a word, so colour is never the only signal.
 * Only the ink moved.
 *
 * `danger` is `/10` rather than `/12` for margin, not because `/12` fails:
 * `--destructive` is the one tint dark enough in light mode to bring the
 * composite down to 4.51:1, which passes AA by 0.01. `/10` is 4.94:1. Both
 * are gated, so `/12` would stay green — the tenth of a point is a choice
 * about how close to the line this map should sit, and the answer is "not
 * that close".
 */
export const TONE_SOFT: Record<Tone, string> = {
  primary: "bg-primary/12 text-primary-text",
  ok: "bg-chart-3/12 text-success-text",
  warn: "bg-chart-4/14 text-warning-text",
  danger: "bg-destructive/10 text-destructive-text",
  info: "bg-chart-2/12 text-info-text",
  muted: "bg-muted text-muted-foreground",
};

/* ── Eyebrow + ruler ─────────────────────────────────────────────────── */

/** Small-caps mono label used for every panel and tile heading. */
export function Eyebrow({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * Decorative tick ruler — the console's one recurring motif. Sits under a
 * headline number like the scale on a meter. Purely visual, hidden from AT.
 */
export function Ruler({ className, ticks = 24 }: { className?: string; ticks?: number }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("block h-2 w-full text-border", className)}
      viewBox={`0 0 ${ticks * 4} 8`}
      preserveAspectRatio="none"
    >
      {Array.from({ length: ticks + 1 }, (_, i) => (
        <rect
          key={i}
          x={i * 4}
          y={i % 4 === 0 ? 0 : 4}
          width={1}
          height={i % 4 === 0 ? 8 : 4}
          fill="currentColor"
          opacity={i % 4 === 0 ? 1 : 0.6}
        />
      ))}
    </svg>
  );
}

/* ── Panel ───────────────────────────────────────────────────────────── */

interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  /** Reveal-stagger index (0..n). */
  index?: number;
  padded?: boolean;
  footer?: React.ReactNode;
}

export function Panel({
  title,
  hint,
  action,
  index = 0,
  padded = true,
  footer,
  className,
  children,
  style,
  ...props
}: PanelProps) {
  return (
    <section
      className={cn(
        "admin-reveal flex min-w-0 flex-col rounded-xl border border-border/70 bg-card/85 shadow-sm",
        className,
      )}
      style={{ ...style, ["--i" as string]: index }}
      {...props}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <Eyebrow className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-[3px] w-3 rounded-full bg-primary" />
            <span className="truncate">{title}</span>
          </Eyebrow>
          {hint && <p className="mt-1 text-[12px] leading-snug text-muted-foreground/90">{hint}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </header>
      <div className={cn("min-w-0 flex-1", padded ? "px-4 pb-4 pt-4 sm:px-5" : "pt-3")}>{children}</div>
      {footer && (
        <footer className="border-t border-border/60 px-4 py-2.5 text-[11px] leading-snug text-muted-foreground sm:px-5">
          {footer}
        </footer>
      )}
    </section>
  );
}

/* ── KPI tile ────────────────────────────────────────────────────────── */

interface StatProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  sub?: React.ReactNode;
  aside?: React.ReactNode;
  tone?: Tone;
  index?: number;
  loading?: boolean;
  className?: string;
}

export function Stat({ label, value, unit, sub, aside, tone = "primary", index = 0, loading, className }: StatProps) {
  return (
    <div
      className={cn(
        "admin-reveal relative flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/85 px-4 py-4 shadow-sm",
        className,
      )}
      style={{ ["--i" as string]: index }}
    >
      <div className="flex items-start justify-between gap-3">
        <Eyebrow className="min-w-0 leading-snug">{label}</Eyebrow>
        {aside && <div className={cn("hidden shrink-0 sm:block", TONE_TEXT[tone])}>{aside}</div>}
      </div>
      <div className="flex items-baseline gap-1.5">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <span className="font-display text-[30px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
            {value}
          </span>
        )}
        {unit && !loading && <span className="font-mono text-[11px] text-muted-foreground">{unit}</span>}
      </div>
      <Ruler className={cn("opacity-70", TONE_TEXT[tone])} />
      {sub && <div className="font-mono text-[11px] leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

/* ── Segmented control ───────────────────────────────────────────────── */

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: React.ReactNode; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}

export function Segmented<T extends string>({ options, value, onChange, label, size = "md", className }: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/70 p-0.5", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "shrink-0 rounded-md font-mono font-medium transition-colors duration-150",
              size === "sm" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Form fields ─────────────────────────────────────────────────────── */

export const fieldClass =
  "h-8 rounded-md border border-border/80 bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/70 focus-visible:border-primary/60";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClass, "pr-7", className)} {...props} />;
}

export function TextField({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, className)} {...props} />;
}

export function SmallButton({
  className,
  tone = "muted",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "muted" | "primary" | "danger" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tone === "muted" && "border-border/80 bg-background text-foreground hover:bg-accent",
        tone === "primary" && "border-primary/50 bg-primary/10 text-primary-text hover:bg-primary/15",
        tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive-text hover:bg-destructive/15",
        className,
      )}
      {...props}
    />
  );
}

/* ── Status pill ─────────────────────────────────────────────────────── */

const STATUS_META: Record<OpStatus, { label: string; tone: Tone }> = {
  success: { label: "OK", tone: "ok" },
  split: { label: "SPLIT", tone: "warn" },
  error: { label: "ERROR", tone: "danger" },
  partial: { label: "PARTIAL", tone: "primary" },
};

export function statusTone(status: string): Tone {
  return (STATUS_META as Record<string, { tone: Tone }>)[status]?.tone ?? "muted";
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  // Unknown statuses render as themselves in gray — never as a false "OK".
  const meta = (STATUS_META as Record<string, { label: string; tone: Tone }>)[status] ?? {
    label: String(status || "?").toUpperCase().slice(0, 8),
    tone: "muted" as Tone,
  };
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded px-1.5 font-mono text-[10px] font-bold tracking-[0.08em]",
        TONE_SOFT[meta.tone],
        className,
      )}
    >
      {meta.label}
    </span>
  );
}

/* ── Bar list ────────────────────────────────────────────────────────── */

export interface BarItem {
  key: string;
  label: React.ReactNode;
  value: number;
  /** Rendered instead of the raw value. */
  display?: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  onClick?: () => void;
  title?: string;
}

interface BarListProps {
  items: BarItem[];
  max?: number;
  tone?: Tone;
  emptyText?: string;
  labelWidth?: string;
  className?: string;
}

export function BarList({ items, max, tone = "info", emptyText = "Nothing in this window.", labelWidth = "36%", className }: BarListProps) {
  if (items.length === 0) return <Empty>{emptyText}</Empty>;
  const top = Math.max(max ?? 0, ...items.map((i) => i.value), 1);
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {items.map((item) => {
        const pct = Math.max((item.value / top) * 100, item.value > 0 ? 1.5 : 0);
        const t = item.tone ?? tone;
        const inner = (
          <>
            <span
              className="min-w-0 shrink-0 truncate text-left text-[12px] text-foreground/90"
              style={{ width: labelWidth }}
              title={item.title}
            >
              {item.label}
            </span>
            <span className="relative h-[18px] min-w-0 flex-1 overflow-hidden rounded-[3px] bg-muted/60">
              <span
                className={cn("absolute inset-y-0 left-0 rounded-[3px] opacity-80 transition-[width] duration-700 ease-out", TONE_BG[t])}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="flex w-[88px] shrink-0 flex-col items-end leading-tight">
              <span className="font-mono text-[12px] font-semibold tabular-nums text-foreground">
                {item.display ?? fmtInt(item.value)}
              </span>
              {item.sub && <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{item.sub}</span>}
            </span>
          </>
        );
        return (
          <li key={item.key} className="min-w-0">
            {item.onClick ? (
              <button
                type="button"
                onClick={item.onClick}
                className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 -mx-1 hover:bg-accent/60"
              >
                {inner}
              </button>
            ) : (
              <div className="flex items-center gap-3">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ── Feedback states ─────────────────────────────────────────────────── */

export function Empty({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-dashed border-border/70 px-4 py-6 text-center font-mono text-[12px] text-muted-foreground", className)}>
      {children}
    </div>
  );
}

export function ErrorNotice({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-[12px] text-destructive-text",
        className,
      )}
    >
      <span className="flex items-center gap-2 font-mono">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {message}
      </span>
      {onRetry && (
        <SmallButton tone="danger" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
        </SmallButton>
      )}
    </div>
  );
}

export function RowSkeleton({ rows = 6, height = "h-9" }: { rows?: number; height?: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("w-full", height)} />
      ))}
    </div>
  );
}

/* ── Mini metric (label over number, used inside panels) ─────────────── */

export function Mini({ label, value, tone = "muted", className }: { label: string; value: React.ReactNode; tone?: Tone; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className={cn("font-display text-xl font-semibold leading-none tabular-nums", tone === "muted" ? "text-foreground" : TONE_TEXT[tone])}>
        {value}
      </div>
      <Eyebrow className="mt-1.5 text-[10px] tracking-[0.1em]">{label}</Eyebrow>
    </div>
  );
}

/* ── Table shell ─────────────────────────────────────────────────────── */

/**
 * `label` makes the scroll container a named, focusable region. Give one to a
 * table with nothing focusable inside it: on a phone the table scrolls
 * sideways, and a scrolling box a keyboard cannot reach is a WCAG 2.1.1
 * failure (axe: scrollable-region-focusable). A table whose rows hold links
 * or buttons is already reachable and does not need it.
 */
export function TableShell({
  children,
  minWidth = 720,
  className,
  label,
}: {
  children: React.ReactNode;
  minWidth?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "-mx-4 overflow-x-auto sm:-mx-5",
        label && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/80",
        className,
      )}
      {...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
    >
      <table className="w-full border-collapse text-[12px]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const thClass =
  "sticky top-0 whitespace-nowrap border-b border-border/70 bg-card/95 px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5";
export const tdClass = "border-b border-border/40 px-3 py-2 align-middle first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5";

/** Sortable column header: a real button with aria-sort on the <th>. */
export function SortTh({
  label,
  active,
  order,
  onClick,
  align = "left",
  className,
}: {
  label: string;
  active: boolean;
  order: "asc" | "desc";
  onClick?: () => void;
  align?: "left" | "right";
  className?: string;
}) {
  const ariaSort = active ? (order === "asc" ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={onClick ? ariaSort : undefined} className={cn(thClass, align === "right" && "text-right", className)}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm uppercase tracking-[0.12em] hover:text-foreground",
            active && "text-primary-text",
          )}
        >
          {label}
          <span aria-hidden="true" className="text-[9px]">
            {active ? (order === "desc" ? "▼" : "▲") : "◇"}
          </span>
        </button>
      ) : (
        label
      )}
    </th>
  );
}
