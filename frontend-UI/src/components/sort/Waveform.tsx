"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { downsampleWaveform, formatClock, waveformJsonUrl } from "@/lib/sort-session";

/**
 * A track's waveform, drawn from SoundCloud's own JSON (the `waveform_url`
 * with `.json` for `.png`). wave.sndcdn.com answers with
 * `Access-Control-Allow-Origin: *` (checked 2026-11-16) and `*.sndcdn.com` is
 * already in the CSP's `connect-src`, so this needs no new allowance.
 *
 * It is also the seek control: a `role="slider"` that takes a click anywhere
 * along it and arrow keys while focused (±5 s, Home/End). Arrow keys stop
 * here, so the page's own ←/→ shortcuts do not fire twice.
 */

const BARS = 160;
const cache = new Map<string, Promise<number[] | null>>();

function loadWaveform(url: string): Promise<number[] | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url, { credentials: "omit" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { samples?: unknown; height?: unknown } | null) => {
        if (!data || !Array.isArray(data.samples)) return null;
        const samples = data.samples.filter((n): n is number => typeof n === "number");
        const height = typeof data.height === "number" ? data.height : Math.max(1, ...samples);
        return downsampleWaveform(samples, height, BARS);
      })
      .catch(() => null);
    cache.set(url, pending);
    // Keep the cache bounded over a long session.
    if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  }
  return pending;
}

export function useWaveform(waveformUrl: string | null | undefined) {
  const url = waveformJsonUrl(waveformUrl);
  const [state, setState] = React.useState<{ url: string | null; peaks: number[] | null; failed: boolean }>({
    url: null,
    peaks: null,
    failed: false,
  });
  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;
    loadWaveform(url).then((peaks) => {
      if (!cancelled) setState({ url, peaks, failed: peaks === null });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  const current = state.url === url;
  return { peaks: current ? state.peaks : null, failed: !url || (current && state.failed), loading: !!url && !current };
}

interface WaveformProps {
  waveformUrl: string | null | undefined;
  positionMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
  /** Accessible name, e.g. "Seek in Strobe". */
  label: string;
  disabled?: boolean;
  className?: string;
}

export function Waveform({ waveformUrl, positionMs, durationMs, onSeek, label, disabled, className }: WaveformProps) {
  const { peaks, loading, failed } = useWaveform(waveformUrl);
  const ref = React.useRef<HTMLDivElement>(null);
  const progress = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  const bars = peaks ?? Array.from({ length: BARS }, () => (loading ? 0.08 : 0.04));
  const playedBars = Math.round(progress * bars.length);

  const seekToClientX = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0 || durationMs <= 0) return;
    onSeek(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * durationMs);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || durationMs <= 0) return;
    const step = event.shiftKey ? 30000 : 5000;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = positionMs + step;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = positionMs - step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = durationMs - 1000;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onSeek(Math.min(durationMs, Math.max(0, next)));
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuenow={Math.round(positionMs / 1000)}
      aria-valuetext={`${formatClock(positionMs)} of ${formatClock(durationMs)}`}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      onClick={(event) => !disabled && seekToClientX(event.clientX)}
      className={cn(
        "relative h-16 w-full cursor-pointer select-none rounded-lg border border-border bg-muted/40 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "cursor-not-allowed",
        className,
      )}
      data-waveform={peaks ? "loaded" : failed ? "unavailable" : "loading"}
    >
      <svg viewBox={`0 0 ${bars.length} 40`} preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
        {bars.map((peak, i) => {
          const h = Math.max(1, peak * 38);
          return (
            <rect
              key={i}
              x={i + 0.15}
              width={0.7}
              y={(40 - h) / 2}
              height={h}
              className={i < playedBars ? "fill-primary" : "fill-muted-foreground-subtle"}
            />
          );
        })}
      </svg>
      <span className="pointer-events-none absolute bottom-1 left-2 rounded bg-card/90 px-1 text-xs tabular-nums text-foreground">
        {formatClock(positionMs)}
      </span>
      <span className="pointer-events-none absolute bottom-1 right-2 rounded bg-card/90 px-1 text-xs tabular-nums text-foreground">
        {formatClock(durationMs)}
      </span>
    </div>
  );
}
