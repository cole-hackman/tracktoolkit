"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { CopyPlus, ArrowRight, Music, Link as LinkIcon, Loader2, Link2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import { invalidatePlaylistCaches } from "@/lib/queries";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Field,
  InlineAlert,
  Input,
  PageContainer,
  PageHeader,
  ResultPanel,
  SectionHeading,
  useAnnounce,
} from "@/components/ui";

interface ClonedPlaylist {
  id?: number | string;
  title?: string;
  permalink_url?: string;
}

export default function PlaylistClonerPage() {
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Our own required-field message, rendered under the input by `Field`. The
  // browser's bubble is not in the accessibility tree and disappears on the
  // next keystroke.
  const [urlError, setUrlError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  // Results
  const [resultPlaylists, setResultPlaylists] = useState<ClonedPlaylist[]>([]);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialUrl = params.get("url");
    if (initialUrl) setUrl(initialUrl);
  }, []);

  const handleClone = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) {
      setUrlError("Paste the link to the playlist you want to clone.");
      urlRef.current?.focus();
      return;
    }

    setUrlError(null);
    setIsCloning(true);
    setError(null);
    setResultPlaylists([]);
    setStats(null);

    try {
      const body: Record<string, string> = { url: url.trim() };
      if (customTitle.trim()) {
        body.title = customTitle.trim();
      }

      const res = await apiFetch("/api/playlists/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Show the reason first: it must not wait on a list refetch.
        setError(errorMessageFromBody(data, "Failed to clone playlist"));
        if (res.status === 502 && data?.code === "SOUNDCLOUD_UNAVAILABLE") {
          // A write may have landed before SoundCloud stopped answering; the
          // user is told to check their playlists, so make that list fresh.
          void invalidatePlaylistCaches(queryClient);
        }
        return;
      }
      if (!data) throw new Error("Failed to clone playlist");

      const created: ClonedPlaylist[] = data.playlists ? data.playlists : [data.playlist];
      setResultPlaylists(created);
      setStats(data.stats);
      setUrl("");
      setCustomTitle("");
      announce(
        `Cloned ${data.stats?.totalTracks ?? 0} tracks into ${created.length} playlist${created.length === 1 ? "" : "s"}.`,
      );
    } catch (err: unknown) {
      // `InlineAlert variant="error"` is `role="alert"` and is spoken on
      // insertion, so an `announce` alongside it would say this twice.
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsCloning(false);
    }
  };

  return (
    <PageContainer maxWidth="narrow">
      <PageHeader
        title="Playlist Cloner"
        description="Paste a public playlist link to clone it into your own account."
      />

      <Card className="mb-8">
        <CardHeader>
          <SectionHeading className="text-base">
            <span className="flex items-center gap-2">
              <Link2 aria-hidden="true" className="h-4 w-4 text-primary" />
              Clone a public playlist
            </span>
          </SectionHeading>
        </CardHeader>
        <CardContent>
        {/* `noValidate` so the required check is ours: see `urlError`. */}
        <form onSubmit={handleClone} noValidate className="space-y-6">
          <div className="space-y-4">
            <Field
              label="Original playlist URL"
              hint="Paste a public playlist link."
              error={urlError ?? undefined}
              required
            >
              {(field) => (
                <div className="relative">
                  <LinkIcon
                    aria-hidden="true"
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                  />
                  <Input
                    {...field}
                    ref={urlRef}
                    type="url"
                    inputMode="url"
                    placeholder="https://soundcloud.com/username/sets/playlist-name"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      if (urlError) setUrlError(null);
                    }}
                    className="pl-9"
                  />
                </div>
              )}
            </Field>

            <Field label="Custom name (optional)">
              {(field) => (
                <Input
                  {...field}
                  type="text"
                  placeholder="Leave blank to use 'Clone of [Original Name]'"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                />
              )}
            </Field>
          </div>

          <Button type="submit" disabled={isCloning} className="w-full sm:w-auto">
            {isCloning ? (
              <>
                <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
                Cloning...
              </>
            ) : (
              <>
                <CopyPlus aria-hidden="true" className="w-4 h-4" />
                Clone Playlist
              </>
            )}
          </Button>
        </form>

        {error && (
          <InlineAlert variant="error" className="mt-4" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}
        </CardContent>
      </Card>

      {resultPlaylists.length > 0 && (
        <ResultPanel
          title="Cloning Complete"
          tone="success"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Card className="flex items-center gap-4 p-4">
                <div aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
                  <Music className="w-6 h-6" />
                </div>
                {/* Label first in the DOM, number above it visually — a lone
                    "37" read before "Tracks Cloned" counts nothing yet. */}
                <div className="flex flex-col-reverse">
                  <p className="text-sm font-medium text-muted-foreground">Tracks Cloned</p>
                  <p className="text-2xl font-bold text-foreground">{stats?.totalTracks?.toString() || "0"}</p>
                </div>
              </Card>
              {Number(stats?.numPlaylistsCreated) > 1 && (
                <Card className="flex items-center gap-4 p-4">
                  <div aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
                    <CopyPlus className="w-6 h-6" />
                  </div>
                  <div className="flex flex-col-reverse">
                    <p className="text-sm font-medium text-muted-foreground">Parts Created</p>
                    <p className="text-2xl font-bold text-foreground">{stats?.numPlaylistsCreated?.toString() || "0"}</p>
                  </div>
                </Card>
              )}
            </div>

            <div className="space-y-3">
              {resultPlaylists.map((pl, i) => (
                <Card key={pl.id ?? i} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">
                        {pl.title}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        ID: {pl.id}
                      </div>
                    </div>
                    {pl.permalink_url && (
                      <a
                        href={pl.permalink_url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${pl.title ?? "the cloned playlist"} on SoundCloud`}
                        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-surface px-4 text-sm font-semibold text-foreground transition hover:border-primary/40 hover:bg-surface-hover"
                      >
                        Open
                        <ArrowRight aria-hidden="true" className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </ResultPanel>
      )}
    </PageContainer>
  );
}
