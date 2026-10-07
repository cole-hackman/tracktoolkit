"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import NextLink from "next/link";
import { Link as LinkIcon, Search, ExternalLink, Copy, Download, ShoppingBag, Users } from "lucide-react";
import {
  Button,
  Card,
  Field,
  InlineAlert,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  ResultPanel,
  SectionHeading,
  useAnnounce,
} from "@/components/ui";
import type { ResolverResource } from "@/lib/resolver";
import { formatCompactNumber, formatDate, formatDuration, parseTagList, useSingleResolver } from "@/lib/resolver";
import { apiFetchJson } from "@/lib/api";
import { startSoundCloudDownload } from "@/lib/download";

interface RelatedArtist {
  id: number;
  permalink_url: string;
  avatar_url: string;
  username: string;
  followers_count: number;
}

function RelatedArtists({ userUrn }: { userUrn: string }) {
  const [artists, setArtists] = useState<RelatedArtist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const fetchArtists = async () => {
    if (artists.length > 0 || loading) return;
    setLoading(true);
    try {
      const data = await apiFetchJson<RelatedArtist[]>(`/api/users/${encodeURIComponent(userUrn)}/related`);
      setArtists(data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load related artists");
    } finally {
      setLoading(false);
    }
  };

  return (
    <details
      className="mt-6 border border-border rounded-xl bg-secondary/10"
      onToggle={(e) => {
        const target = e.target as HTMLDetailsElement;
        setIsOpen(target.open);
        if (target.open) fetchArtists();
      }}
    >
      <summary className="cursor-pointer px-4 py-3 font-semibold text-foreground flex items-center justify-between outline-none">
        Related Artists
        <span className="text-xs font-normal text-muted-foreground">{isOpen ? 'Hide' : 'Show'}</span>
      </summary>
      
      <div className="p-4 border-t border-border">
        {loading && (
          <div role="status" className="py-4 text-center text-sm text-muted-foreground">
            Loading artists…
          </div>
        )}
        {error && <InlineAlert variant="error">{error}</InlineAlert>}

        {!loading && !error && artists.length === 0 && (
          <div role="status" className="py-4 text-center text-sm text-muted-foreground">
            No related artists found.
          </div>
        )}

        {!loading && !error && artists.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {artists.map((artist) => (
              <a
                key={artist.id}
                href={artist.permalink_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 flex-col items-center gap-2 p-3 rounded-lg hover:bg-secondary/50 transition text-center"
              >
                {artist.avatar_url ? (
                  <img
                    src={artist.avatar_url}
                    alt=""
                    width={64}
                    height={64}
                    loading="lazy"
                    decoding="async"
                    className="w-16 h-16 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Users className="w-6 h-6" />
                  </div>
                )}
                <span className="text-sm font-medium text-foreground line-clamp-1">{artist.username}</span>
                <span className="text-xs text-muted-foreground">{formatCompactNumber(artist.followers_count)} followers</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function LinkResolverContent() {
  const searchParams = useSearchParams();
  const announce = useAnnounce();
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState<"url" | "id" | null>(null);
  const [copyError, setCopyError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { loading, error, result, setResult, setError, resolve } = useSingleResolver();

  useEffect(() => {
    const urlParam = searchParams.get("url");
    if (urlParam) setUrl(urlParam);
  }, [searchParams]);

  // The label reverts on its own; a copy that silently did nothing was the
  // old behaviour and there was no way to tell the two apart.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const resolveLink = async () => {
    setResult(null);
    setDownloadError("");
    setError("");
    setCopied(null);
    setCopyError("");
    await resolve(url);
  };

  const copyText = async (kind: "url" | "id", value?: string | number | null) => {
    if (value == null) return;
    try {
      await navigator.clipboard.writeText(String(value));
      setCopyError("");
      setCopied(kind);
      announce("Copied");
    } catch {
      setCopied(null);
      setCopyError("Couldn't reach the clipboard. Select the value and copy it manually.");
    }
  };

  const resource = result?.data;
  const meta = result?.meta;
  const tags = resource && (resource.type === "track" || resource.type === "playlist")
    ? parseTagList(resource.tag_list)
    : [];
  const title = resource?.type === "user" ? resource.username || "Unknown user" : resource?.title || "Untitled";
  const artist =
    resource?.type === "track" || resource?.type === "playlist"
      ? resource?.user?.username || resource?.username
      : resource?.username;
  const imageUrl = resource?.type === "user" ? resource.avatar_url : resource?.artwork_url;

  const renderStats = (item: ResolverResource) => {
    if (item.type === "track") {
      return (
        <>
          <StatCard label="Duration" value={formatDuration(item.duration_ms ?? item.duration)} />
          <StatCard label="Plays" value={formatCompactNumber(item.playback_count)} />
          <StatCard label="Likes" value={formatCompactNumber(item.likes_count)} />
          <StatCard label="Reposts" value={formatCompactNumber(item.reposts_count)} />
          <StatCard label="Comments" value={formatCompactNumber(item.comment_count)} />
          <StatCard label="Created" value={formatDate(item.created_at)} />
        </>
      );
    }
    if (item.type === "playlist") {
      return (
        <>
          <StatCard label="Tracks" value={item.track_count?.toString() || "-"} />
          <StatCard label="Likes" value={formatCompactNumber(item.likes_count)} />
          <StatCard label="Reposts" value={formatCompactNumber(item.reposts_count)} />
          <StatCard label="Created" value={formatDate(item.created_at)} />
        </>
      );
    }
    return (
      <>
        <StatCard label="Followers" value={formatCompactNumber(item.followers_count)} />
        <StatCard label="Following" value={formatCompactNumber(item.followings_count)} />
        <StatCard label="Tracks" value={formatCompactNumber(item.track_count)} />
        <StatCard label="Playlists" value={formatCompactNumber(item.playlist_count)} />
        <StatCard label="Likes" value={formatCompactNumber(item.likes_count)} />
      </>
    );
  };

  return (
    <PageContainer maxWidth="narrow">
        <PageHeader
          title="Link Resolver"
          description="Get detailed information from any SoundCloud URL."
        />

        {/* Input */}
        <Card className="p-4 sm:p-6 mb-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="SoundCloud URL" className="flex-1">
              {(field) => (
                <div className="relative">
                  <LinkIcon
                    className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    {...field}
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && resolveLink()}
                    placeholder="https://soundcloud.com/…"
                    className="h-12 pl-12 text-base"
                  />
                </div>
              )}
            </Field>
            <Button
              onClick={resolveLink}
              disabled={!url.trim() || loading}
              className="h-12 px-6"
            >
              {loading ? (
                <LoadingSpinner size="sm" className="text-white" />
              ) : (
                <Search className="w-5 h-5" aria-hidden="true" />
              )}
              Resolve
            </Button>
          </div>
          {error && (
            <InlineAlert variant="error" className="mt-4" onDismiss={() => setError("")}>
              {error}
            </InlineAlert>
          )}
        </Card>

        {/* Result */}
        {result && resource && (
          <ResultPanel>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
              <img
                src={imageUrl || "/brand/icon-192.png"}
                alt=""
                width={128}
                height={128}
                loading="lazy"
                decoding="async"
                className="w-24 h-24 sm:w-32 sm:h-32 shrink-0 rounded-xl object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className="px-3 py-1 border border-primary/40 text-primary-text rounded-full text-sm font-medium capitalize">
                    {resource.kind}
                  </span>
                  {meta?.cached && (
                    <span className="px-3 py-1 bg-secondary/20 text-muted-foreground rounded-full text-sm">
                      Cached
                    </span>
                  )}
                </div>
                <h2 className="text-2xl font-bold text-foreground mb-2">
                  {title}
                </h2>
                {artist && (
                  <p className="text-muted-foreground mb-4">
                    by {artist}
                  </p>
                )}
                {resource.description && (
                  <p className="text-muted-foreground text-sm line-clamp-3 mb-4">
                    {resource.description}
                  </p>
                )}

                {/* Stats */}
                {/* Tailwind has no `xs` breakpoint by default, so the second
                    column starts at `sm` — one column is what fits 360px. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                  {renderStats(resource)}
                </div>

                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {tags.slice(0, 8).map((tag) => (
                      <span key={tag} className="text-xs px-2 py-1 rounded-full border border-primary/40 text-primary-text">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}

                {resource.permalink_url && (resource.type === "track" || resource.type === "playlist") && (
                  <div className="mb-6 rounded-xl overflow-hidden border border-border shadow-sm">
                    <iframe
                      title={`SoundCloud player for ${title}`}
                      width="100%"
                      height={resource.type === "playlist" ? "350" : "166"}
                      scrolling="no"
                      frameBorder="no"
                      allow="autoplay"
                      src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(resource.permalink_url)}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true`}
                    />
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {resource.permalink_url && (
                    <a
                      href={resource.permalink_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-primary-text hover:underline"
                    >
                      Open on SoundCloud
                      <ExternalLink className="w-4 h-4" aria-hidden="true" />
                    </a>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyText("url", resource.permalink_url || meta?.source_url || url)}
                  >
                    <Copy className="w-4 h-4" aria-hidden="true" />
                    {copied === "url" ? "Copied" : "Copy URL"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => copyText("id", resource.id)}>
                    <Copy className="w-4 h-4" aria-hidden="true" />
                    {copied === "id" ? "Copied" : "Copy ID"}
                  </Button>
                  {resource.type === "track" && resource.download_url && (
                    // Through /api/proxy-download, not a bare link: the raw
                    // api.soundcloud.com URL needs the OAuth header, so opening
                    // it directly only ever showed SoundCloud's 401.
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={downloading}
                      onClick={async () => {
                        const downloadUrl = resource.download_url;
                        if (!downloadUrl) return;
                        setDownloadError("");
                        setDownloading(true);
                        const outcome = await startSoundCloudDownload(downloadUrl);
                        setDownloading(false);
                        if (!outcome.ok) setDownloadError(outcome.error);
                      }}
                    >
                      <Download className="w-4 h-4" aria-hidden="true" />
                      {downloading ? "Starting…" : "Download"}
                    </Button>
                  )}
                  {resource.type === "track" && resource.purchase_url && (
                    <a
                      href={resource.purchase_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-muted-foreground hover:text-primary-text"
                    >
                      <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                      {resource.purchase_title || "Purchase"}
                    </a>
                  )}
                </div>
                {downloadError && (
                  <InlineAlert variant="error" className="mt-3" onDismiss={() => setDownloadError("")}>
                    {downloadError}
                  </InlineAlert>
                )}
                {copyError && (
                  <InlineAlert variant="error" className="mt-3" onDismiss={() => setCopyError("")}>
                    {copyError}
                  </InlineAlert>
                )}
                <div className="mt-4 border-t border-border pt-4">
                  <SectionHeading as="h3" className="mb-2">
                    Next actions
                  </SectionHeading>
                  <div className="flex flex-wrap gap-2">
                    {resource.type === "track" && resource.permalink_url && (
                      <NextLink
                        href="/downloads"
                        className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:border-primary hover:text-primary-text"
                      >
                        Open downloads tool
                      </NextLink>
                    )}
                    {resource.type === "track" && resource.id && (
                      <NextLink
                        href={`/likes-to-playlist?id=${encodeURIComponent(String(resource.id))}`}
                        className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:border-primary hover:text-primary-text"
                      >
                        Add this liked track
                      </NextLink>
                    )}
                    {resource.type === "playlist" && resource.permalink_url && (
                      <NextLink
                        href={`/playlist-cloner?url=${encodeURIComponent(resource.permalink_url)}`}
                        className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:border-primary hover:text-primary-text"
                      >
                        Clone playlist
                      </NextLink>
                    )}
                    {resource.type === "playlist" && (
                      <NextLink
                        href="/playlist-health-check"
                        className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:border-primary hover:text-primary-text"
                      >
                        Check playlist health
                      </NextLink>
                    )}
                    {resource.type === "user" && resource.permalink_url && (
                      <a
                        href={resource.permalink_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:border-primary hover:text-primary-text"
                      >
                        Open profile
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {resource.type === "user" && resource.urn && (
              <RelatedArtists userUrn={resource.urn} />
            )}

            {/* Raw Data */}
            <details className="mt-8">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-primary-text">
                View raw data
              </summary>
              <pre className="mt-4 p-4 bg-secondary/20 rounded-lg overflow-x-auto text-xs text-foreground">
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </ResultPanel>
        )}
    </PageContainer>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2 bg-secondary/20 rounded-lg">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold text-foreground">{value}</div>
    </div>
  );
}

export default function LinkResolverPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-24"><LoadingSpinner /></div>}>
      <LinkResolverContent />
    </Suspense>
  );
}
