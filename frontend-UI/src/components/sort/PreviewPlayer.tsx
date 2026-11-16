"use client";

import * as React from "react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import type { SortTrack } from "@/lib/sort-session";

/**
 * The Sort Likes preview player, in two interchangeable modes so they can be
 * compared on real use (decision 2026-11-16: build both, keep the better):
 *
 *  - "own" (B): GET /api/tracks/:id/stream returns a short-lived signed CDN
 *    link, played by a plain <audio>. HLS-only tracks play natively in Safari
 *    and through hls.js (lazy-loaded, bundled — no third-party script)
 *    elsewhere. The link is asked for just before it plays, and once more if
 *    the CDN refuses it mid-track (the signature has expired).
 *  - "embed" (A): SoundCloud's widget iframe on w.soundcloud.com, driven by
 *    the widget's postMessage protocol directly rather than its api.js, so
 *    the page still loads no third-party script. Focus moving into the
 *    iframe takes the page's hotkeys with it until the user clicks back out.
 *
 * Both report the same state and accept the same commands through the
 * imperative handle, so the page's hotkeys and the waveform work the same in
 * either mode. The CSP allowances are scoped to the /sort-likes/ document
 * (server/middleware/security.js).
 */

export type PlayerMode = "own" | "embed";

export interface PlayerState {
  playing: boolean;
  positionMs: number;
  durationMs: number;
  loading: boolean;
  error: string | null;
  /** The only stream SoundCloud gave is its 30-second preview. */
  previewOnly: boolean;
}

export interface PlayerHandle {
  toggle: () => void;
  play: () => void;
  pause: () => void;
  seekTo: (ms: number) => void;
  seekBy: (ms: number) => void;
}

interface Props {
  track: SortTrack;
  mode: PlayerMode;
  /** Start playing as soon as the track loads (the previous one was playing). */
  autoPlay: boolean;
  onState: (state: PlayerState) => void;
  onEnded?: () => void;
}

export const EMBED_ORIGIN = "https://w.soundcloud.com";

export function embedSrc(permalinkUrl: string, autoPlay: boolean): string {
  const params = new URLSearchParams({
    url: permalinkUrl,
    auto_play: autoPlay ? "true" : "false",
    visual: "false",
    show_comments: "false",
    show_user: "true",
    show_reposts: "false",
    hide_related: "true",
    buying: "false",
    sharing: "false",
    download: "false",
    color: "#ff5500",
  });
  return `${EMBED_ORIGIN}/player/?${params.toString()}`;
}

interface StreamLink {
  url: string;
  format: "mp3" | "hls";
  preview: boolean;
}

async function fetchStreamLink(trackId: number): Promise<StreamLink> {
  const res = await apiFetch(`/api/tracks/${trackId}/stream`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessageFromBody(body, "Couldn't load a stream for this track."));
  if (!body || typeof body.url !== "string") throw new Error("Couldn't load a stream for this track.");
  return body as StreamLink;
}

type HlsInstance = { destroy: () => void; loadSource: (url: string) => void; attachMedia: (el: HTMLMediaElement) => void };

export const PreviewPlayer = React.forwardRef<PlayerHandle, Props>(function PreviewPlayer(
  { track, mode, autoPlay, onState, onEnded },
  ref,
) {
  const durationFallback = typeof track.duration === "number" ? track.duration : 0;
  const [state, setState] = React.useState<PlayerState>({
    playing: false,
    positionMs: 0,
    durationMs: durationFallback,
    loading: false,
    error: null,
    previewOnly: false,
  });
  const update = React.useCallback((patch: Partial<PlayerState>) => setState((s) => ({ ...s, ...patch })), []);

  React.useEffect(() => {
    onState(state);
  }, [state, onState]);

  // ── Own player (B) ─────────────────────────────────────────────────────────
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const hlsRef = React.useRef<HlsInstance | null>(null);
  const loadedFor = React.useRef<number | null>(null);
  const retried = React.useRef(false);

  const detach = React.useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    loadedFor.current = null;
  }, []);

  const attach = React.useCallback(
    async (resumeAtMs = 0) => {
      const audio = audioRef.current;
      if (!audio) return false;
      update({ loading: true, error: null });
      try {
        const link = await fetchStreamLink(track.id);
        hlsRef.current?.destroy();
        hlsRef.current = null;
        if (link.format === "hls" && !audio.canPlayType("application/vnd.apple.mpegurl")) {
          const { default: Hls } = await import("hls.js");
          if (!Hls.isSupported()) throw new Error("This browser can't play this track's stream. Try the SoundCloud player.");
          // No worker: it would be a blob: script, which the CSP does not allow.
          const hls = new Hls({ enableWorker: false });
          hls.loadSource(link.url);
          hls.attachMedia(audio);
          hlsRef.current = hls as unknown as HlsInstance;
        } else {
          audio.src = link.url;
        }
        loadedFor.current = track.id;
        if (resumeAtMs > 0) audio.currentTime = resumeAtMs / 1000;
        update({ previewOnly: link.preview });
        return true;
      } catch (error) {
        update({ loading: false, playing: false, error: error instanceof Error ? error.message : "Couldn't play this track." });
        return false;
      }
    },
    [track.id, update],
  );

  const ownPlay = React.useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (loadedFor.current !== track.id) {
      const ok = await attach();
      if (!ok) return;
    }
    try {
      await audio.play();
    } catch (error) {
      // NotAllowedError: autoplay without a gesture. Not an error to show.
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
        update({ error: "Couldn't start playback." });
      }
      update({ playing: false, loading: false });
    }
  }, [attach, track.id, update]);

  // ── Embed player (A) ───────────────────────────────────────────────────────
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const embedReady = React.useRef(false);
  const pendingSeek = React.useRef<number | null>(null);

  const post = React.useCallback((method: string, value?: unknown) => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), EMBED_ORIGIN);
  }, []);

  React.useEffect(() => {
    if (mode !== "embed") return;
    embedReady.current = false;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== EMBED_ORIGIN || event.source !== frameRef.current?.contentWindow) return;
      let data: { method?: string; value?: { currentPosition?: number; relativePosition?: number } | number } | null = null;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (!data?.method) return;
      switch (data.method) {
        case "ready":
          embedReady.current = true;
          for (const name of ["play", "pause", "finish", "playProgress"]) post("addEventListener", name);
          update({ loading: false, error: null });
          if (pendingSeek.current !== null) {
            post("seekTo", pendingSeek.current);
            pendingSeek.current = null;
          }
          break;
        case "play":
          update({ playing: true, loading: false });
          break;
        case "pause":
          update({ playing: false });
          break;
        case "finish":
          update({ playing: false });
          onEnded?.();
          break;
        case "playProgress": {
          const v = data.value;
          if (v && typeof v === "object" && typeof v.currentPosition === "number") update({ positionMs: v.currentPosition });
          break;
        }
        default:
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mode, track.id, post, update, onEnded]);

  // ── Track or mode change ───────────────────────────────────────────────────
  React.useEffect(() => {
    setState({
      playing: false,
      positionMs: 0,
      durationMs: durationFallback,
      loading: mode === "embed" && !!track.permalink_url,
      error: mode === "embed" && !track.permalink_url ? "This track has no SoundCloud link to embed." : null,
      previewOnly: false,
    });
    pendingSeek.current = null;
    retried.current = false;
    if (mode === "own") {
      detach();
      if (autoPlay) void ownPlay();
    } else {
      detach();
    }
    return () => detach();
    // autoPlay is read once per track/mode change on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, mode]);

  React.useImperativeHandle(
    ref,
    () => ({
      play: () => {
        if (mode === "own") void ownPlay();
        else post("play");
      },
      pause: () => {
        if (mode === "own") audioRef.current?.pause();
        else post("pause");
      },
      toggle: () => {
        if (mode === "own") {
          const audio = audioRef.current;
          if (audio && !audio.paused) audio.pause();
          else void ownPlay();
        } else {
          post("toggle");
        }
      },
      seekTo: (ms: number) => {
        const target = Math.max(0, ms);
        update({ positionMs: target });
        if (mode === "own") {
          const audio = audioRef.current;
          if (!audio) return;
          if (loadedFor.current === track.id) audio.currentTime = target / 1000;
          else void attach(target).then((ok) => {
            if (ok) audio.play().catch(() => update({ playing: false }));
          });
        } else if (embedReady.current) {
          post("seekTo", target);
          post("play");
        } else {
          pendingSeek.current = target;
        }
      },
      seekBy: (delta: number) => {
        setState((s) => {
          const target = Math.min(Math.max(0, s.positionMs + delta), s.durationMs || Number.MAX_SAFE_INTEGER);
          if (mode === "own") {
            const audio = audioRef.current;
            if (audio && loadedFor.current === track.id) audio.currentTime = target / 1000;
          } else if (embedReady.current) {
            post("seekTo", target);
          }
          return { ...s, positionMs: target };
        });
      },
    }),
    [mode, ownPlay, post, track.id, attach, update],
  );

  if (mode === "embed") {
    if (!track.permalink_url) return null;
    return (
      <iframe
        key={track.id}
        ref={frameRef}
        title={`SoundCloud player: ${track.title ?? "track"}`}
        src={embedSrc(track.permalink_url, autoPlay)}
        allow="autoplay"
        loading="eager"
        className="h-[166px] w-full rounded-lg border border-border bg-muted/30"
      />
    );
  }

  return (
    // A hidden music preview with no visual or spoken content to caption.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      ref={audioRef}
      preload="none"
      className="hidden"
      onPlay={() => update({ playing: true })}
      onPlaying={() => update({ loading: false })}
      onWaiting={() => update({ loading: true })}
      onPause={() => update({ playing: false })}
      onEnded={() => {
        update({ playing: false });
        onEnded?.();
      }}
      onTimeUpdate={(e) => update({ positionMs: e.currentTarget.currentTime * 1000 })}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) update({ durationMs: d * 1000 });
      }}
      onError={() => {
        // A signed link that expired mid-track: ask for a fresh one once.
        if (loadedFor.current === track.id && !retried.current) {
          retried.current = true;
          const at = (audioRef.current?.currentTime ?? 0) * 1000;
          loadedFor.current = null;
          void attach(at).then((ok) => {
            if (ok) audioRef.current?.play().catch(() => update({ playing: false }));
          });
          return;
        }
        update({ playing: false, loading: false, error: "The stream stopped. Press play to try again." });
        loadedFor.current = null;
      }}
    />
  );
});
