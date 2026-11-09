"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import {
  ActionBar,
  Button,
  Field,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  useAnnounce,
} from "@/components/ui";
import { ResolvedCard } from "@/components/resolver/ResolvedCard";
import { ResolvedList } from "@/components/resolver/ResolvedList";
import { parseLinks, useBatchResolver, useSingleResolver } from "@/lib/resolver";

/** The batch endpoint's own cap (`validateBatchResolve`). */
const MAX_LINKS = 50;
const MIN_ROWS = 3;
const MAX_ROWS = 12;

/**
 * One resolver for one link or fifty. It replaced the separate Link Resolver
 * and Batch Link Resolver pages (TOOL-CONSOLIDATION.md, candidate 1): one link
 * shows the full card, two or more show the table. The two requests are
 * unchanged, so a single link is still `POST /api/resolve` and is logged as
 * `resolve`, and several are one `POST /api/resolve/batch` (`batch-resolve`).
 */
function LinkResolverContent() {
  const searchParams = useSearchParams();
  const announce = useAnnounce();
  const [input, setInput] = useState("");
  // The input that produced the card, for its Copy URL fallback.
  const [resolvedInput, setResolvedInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  // Which result the last run produced. Each hook keeps its own state, so the
  // other one is cleared on every run and only one outcome is ever on screen.
  const [mode, setMode] = useState<"single" | "batch" | null>(null);
  // Per-run key: each run mounts a fresh result panel (focus + announcement)
  // and a fresh card (its copied/download state starts over).
  const runCount = useRef(0);
  const single = useSingleResolver();
  const batch = useBatchResolver();

  useEffect(() => {
    const urlParam = searchParams.get("url");
    if (urlParam) setInput(urlParam);
  }, [searchParams]);

  const links = parseLinks(input);
  const loading = single.loading || batch.loading;
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, input.split("\n").length));

  const runBatch = async (urls: string[]) => {
    runCount.current += 1;
    setMode("batch");
    single.setResult(null);
    single.setError("");
    announce(`Resolving ${urls.length} links…`);
    await batch.resolve(urls);
  };

  const runSingle = async (url: string) => {
    runCount.current += 1;
    setMode("single");
    batch.setResult(null);
    batch.setError("");
    single.setResult(null);
    setResolvedInput(url);
    await single.resolve(url);
  };

  const handleResolve = async () => {
    if (loading || links.length === 0) return;
    if (links.length > MAX_LINKS) {
      setInputError(`Up to ${MAX_LINKS} links at a time. This has ${links.length}.`);
      return;
    }
    setInputError(null);
    if (links.length === 1) await runSingle(links[0]);
    else await runBatch(links);
  };

  const retryFailed = (urls: string[]) => {
    setInput(urls.join("\n"));
    void runBatch(urls);
  };

  const singleError = mode === "single" ? single.error : "";
  const batchError = mode === "batch" ? batch.error : "";
  const summary = mode === "batch" && !batch.loading ? batch.result?.summary : undefined;

  return (
    <PageContainer kind="form">
      <PageHeader
        title="Link Resolver"
        description="Get details from any SoundCloud link, or paste up to 50 at once."
      />

      <div className="space-y-6">
        {/* The outcome of the run, above the tool. The card and the table
            below are the resolved data and stay content. */}
        {singleError ? (
          <ResultPanel
            key={runCount.current}
            status="error"
            title="Could not resolve link"
            description={singleError}
            onDismiss={() => single.setError("")}
          />
        ) : batchError ? (
          <ResultPanel
            key={runCount.current}
            status="error"
            title="Could not resolve links"
            description={batchError}
            onDismiss={() => batch.setError("")}
          />
        ) : summary ? (
          <ResultPanel
            key={runCount.current}
            status={summary.total === 0 ? "empty" : summary.ok === 0 ? "error" : summary.error > 0 ? "partial" : "success"}
            title={summary.error === 0 ? "Links resolved" : summary.ok === 0 ? "No links resolved" : "Links partly resolved"}
            description={`${summary.ok} resolved, ${summary.error} failed, of ${summary.total}.`}
            announcement={`Done: ${summary.ok} resolved, ${summary.error} failed, of ${summary.total}.`}
          />
        ) : null}

        <Panel>
          <Field
            label="SoundCloud links"
            hint={`One link shows its full details; up to ${MAX_LINKS}, one per line, show a table. Enter resolves, Shift+Enter adds a line.`}
            error={inputError ?? undefined}
          >
            {(field) => (
              <textarea
                {...field}
                value={input}
                rows={rows}
                inputMode="url"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (inputError) setInputError(null);
                }}
                onKeyDown={(e) => {
                  // Enter resolves, as the one-line field it replaced did;
                  // Shift+Enter is the newline. A paste of many lines needs
                  // neither.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleResolve();
                  }
                }}
                placeholder={"https://soundcloud.com/artist/track-name\nhttps://soundcloud.com/artist/sets/playlist-name"}
                className="w-full resize-y rounded-md border border-input bg-surface px-3 py-2 font-mono text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-white/5 sm:text-sm"
              />
            )}
          </Field>
          <ActionBar>
            <Button onClick={() => void handleResolve()} disabled={loading || links.length === 0}>
              {loading ? (
                <LoadingSpinner size="sm" className="text-white" />
              ) : (
                <Search className="w-4 h-4" aria-hidden="true" />
              )}
              {links.length > 1 ? `Resolve ${links.length} links` : "Resolve"}
            </Button>
          </ActionBar>
        </Panel>

        {mode === "single" && single.result && (
          <ResolvedCard key={runCount.current} result={single.result} sourceUrl={resolvedInput} />
        )}
        {mode === "batch" && batch.result && (
          <ResolvedList key={runCount.current} result={batch.result} onRetryFailed={retryFailed} />
        )}
      </div>
    </PageContainer>
  );
}

export default function LinkResolverPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-24"><LoadingSpinner /></div>}>
      <LinkResolverContent />
    </Suspense>
  );
}
