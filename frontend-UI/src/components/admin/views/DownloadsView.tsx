"use client";

import * as React from "react";
import { ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { TrendChart } from "../charts";
import { fmtAbsolute, fmtInt, periodSentence, timeAgo } from "../format";
import {
  BarList,
  Empty,
  ErrorNotice,
  Panel,
  RowSkeleton,
  Segmented,
  SmallButton,
  Stat,
  TableShell,
  TONE_SOFT,
  SortTh,
  tdClass,
  thClass,
  type Tone,
} from "../primitives";
import {
  downloadsTracksCsvUrl,
  useDownloadsEvents,
  useDownloadsSummary,
  useDownloadsTracks,
} from "../queries";
import {
  DEFAULT_DOWNLOADS_EVENT_FILTER,
  DEFAULT_DOWNLOADS_TRACK_FILTER,
  DOWNLOAD_CHANNELS,
  type DownloadChannel,
  type DownloadEvent,
  type DownloadTrackSort,
  type DownloadsEventFilter,
  type DownloadsTrackFilter,
  type Period,
} from "../types";
import { ExportLink, Pager, SearchBox } from "./catalog/shared";

/**
 * Which tracks are being downloaded, by whom, and how.
 *
 * Direct downloads (the site's one-click and queue) are logged by the server as
 * they happen. Gate downloads (Hypeddit, Droploud, Cobrand) are worked by the
 * extension, which never talks to the server; the Downloads page forwards how
 * each one ended (`POST /api/downloads/gate-results`), so a gate only shows up
 * here once the person has a Track Toolkit tab open, during the run or after.
 */

const CHANNEL_LABEL: Record<DownloadChannel, string> = {
  direct: "Direct",
  hypeddit: "Hypeddit",
  droploud: "Droploud",
  cobrand: "Cobrand",
};

const CHANNEL_TONE: Record<DownloadChannel, Tone> = {
  direct: "info",
  hypeddit: "primary",
  droploud: "ok",
  cobrand: "warn",
};

const VIA_LABEL: Record<DownloadEvent["via"], string> = {
  click: "one click",
  queue: "queue",
  extension: "extension",
};

function ChannelChip({ channel }: { channel: DownloadChannel }) {
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]", TONE_SOFT[CHANNEL_TONE[channel]])}>
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

function who(user: { username: string; displayName: string | null }) {
  return `@${user.username}`;
}

interface Props {
  period: Period;
  enabled: boolean;
}

export function DownloadsView({ period, enabled }: Props) {
  const summaryQ = useDownloadsSummary(period, enabled);
  const summary = summaryQ.data;
  const [trackFilter, setTrackFilter] = React.useState<DownloadsTrackFilter>(DEFAULT_DOWNLOADS_TRACK_FILTER);
  const [eventFilter, setEventFilter] = React.useState<DownloadsEventFilter>(DEFAULT_DOWNLOADS_EVENT_FILTER);

  const [queryInput, setQueryInput] = React.useState("");
  const debouncedQuery = useDebouncedValue(queryInput.trim(), 350);
  React.useEffect(() => {
    setTrackFilter((f) => (f.q === debouncedQuery ? f : { ...f, q: debouncedQuery, page: 1 }));
  }, [debouncedQuery]);

  const tracksQ = useDownloadsTracks(period, trackFilter, enabled);
  const eventsQ = useDownloadsEvents(period, eventFilter, enabled);

  const totals = summary?.totals;
  const channelStats = summary?.channels ?? [];
  const daily = React.useMemo(
    () => (summary?.daily ?? []).map((d) => ({ ...d, total: d.direct + d.hypeddit + d.droploud + d.cobrand })),
    [summary?.daily],
  );
  const gateTotal = channelStats.filter((c) => c.channel !== "direct").reduce((n, c) => n + c.downloads, 0);

  const setTracks = (patch: Partial<DownloadsTrackFilter>) => setTrackFilter((f) => ({ ...f, ...patch, page: 1 }));
  const toggleSort = (key: DownloadTrackSort) =>
    setTrackFilter((f) => ({
      ...f,
      sort: key,
      order: f.sort === key ? (f.order === "desc" ? "asc" : "desc") : key === "title" ? "asc" : "desc",
      page: 1,
    }));

  const channelOptions = [
    { value: "" as const, label: "All" },
    ...DOWNLOAD_CHANNELS.map((c) => ({ value: c.id, label: c.label, title: c.hint })),
  ];

  const trackRows = tracksQ.data?.tracks ?? [];
  const eventRows = eventsQ.data?.events ?? [];
  const filterUser = eventFilter.userId ? summary?.users.find((u) => u.userId === eventFilter.userId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat index={0} label="Downloads" value={fmtInt(totals?.downloads)} sub={periodSentence(period)} loading={summaryQ.isPending} />
        <Stat index={1} label="Distinct tracks" value={fmtInt(totals?.tracks)} tone="info" loading={summaryQ.isPending} />
        <Stat index={2} label="People" value={fmtInt(totals?.users)} tone="ok" loading={summaryQ.isPending} />
        <Stat
          index={3}
          label="Using the extension"
          value={fmtInt(totals?.extensionUsers)}
          sub={totals ? `${fmtInt(gateTotal)} gate downloads` : undefined}
          tone="primary"
          loading={summaryQ.isPending}
        />
        <Stat
          index={4}
          label="Failures"
          value={fmtInt(totals?.failures)}
          tone={totals && totals.failures > 0 ? "warn" : "muted"}
          sub="one-click errors and gates that gave up"
          loading={summaryQ.isPending}
        />
      </div>

      {summaryQ.isError && <ErrorNotice message="Could not load the downloads summary." onRetry={() => summaryQ.refetch()} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel index={5} title="Downloads per day" hint="Every channel together. A gate counts on the day its file finished.">
          {summaryQ.isPending ? <RowSkeleton rows={4} /> : <TrendChart data={daily} metric="total" label="Downloads" tone="info" height={200} />}
        </Panel>
        <Panel index={6} title="By channel" hint="Click one to filter the track list.">
          <BarList
            tone="info"
            items={channelStats.map((c) => ({
              key: c.channel,
              label: CHANNEL_LABEL[c.channel],
              value: c.downloads,
              display: fmtInt(c.downloads),
              sub: `${fmtInt(c.tracks)} tracks · ${fmtInt(c.users)} people${c.failures ? ` · ${fmtInt(c.failures)} failed` : ""}`,
              tone: CHANNEL_TONE[c.channel],
              onClick: () => setTracks({ channel: trackFilter.channel === c.channel ? "" : c.channel }),
              title: DOWNLOAD_CHANNELS.find((d) => d.id === c.channel)?.hint,
            }))}
            emptyText="No downloads in this window."
          />
        </Panel>
      </div>

      <Panel
        index={7}
        title="Tracks"
        hint="What is actually being downloaded. Names come from the catalog, or from the gate report when the track is not in it."
        padded={false}
        action={
          <>
            <span className="font-mono text-[11px] text-muted-foreground">
              {tracksQ.isPending ? "Loading…" : `${fmtInt(tracksQ.data?.total)} tracks`}
            </span>
            <ExportLink href={downloadsTracksCsvUrl(period, trackFilter)} />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 pb-3 sm:px-5">
          <Segmented
            label="Channel"
            size="sm"
            options={channelOptions}
            value={trackFilter.channel}
            onChange={(channel) => setTracks({ channel })}
          />
          <SearchBox value={queryInput} onChange={setQueryInput} placeholder="Title or artist contains…" label="Track search" />
          {(trackFilter.channel || trackFilter.q) && (
            <SmallButton
              className="h-7"
              onClick={() => {
                setQueryInput("");
                setTrackFilter({ ...DEFAULT_DOWNLOADS_TRACK_FILTER, sort: trackFilter.sort, order: trackFilter.order });
              }}
            >
              <X className="h-3 w-3" aria-hidden="true" /> Clear
            </SmallButton>
          )}
        </div>
        <div className="px-4 pt-3 sm:px-5">
          {tracksQ.isError ? (
            <ErrorNotice message="Could not load downloaded tracks." onRetry={() => tracksQ.refetch()} />
          ) : tracksQ.isPending ? (
            <RowSkeleton rows={8} />
          ) : trackRows.length === 0 ? (
            <Empty className="mb-4">No downloads match these filters in this window.</Empty>
          ) : (
            <TableShell minWidth={760} className={cn(tracksQ.isPlaceholderData && "opacity-60 transition-opacity")}>
              <thead>
                <tr>
                  <SortTh label="Track" active={trackFilter.sort === "title"} order={trackFilter.order} onClick={() => toggleSort("title")} />
                  <th scope="col" className={thClass}>Channels</th>
                  <SortTh label="Downloads" active={trackFilter.sort === "downloads"} order={trackFilter.order} onClick={() => toggleSort("downloads")} align="right" />
                  <SortTh label="People" active={trackFilter.sort === "users"} order={trackFilter.order} onClick={() => toggleSort("users")} align="right" />
                  <SortTh label="Failed" active={trackFilter.sort === "failures"} order={trackFilter.order} onClick={() => toggleSort("failures")} align="right" />
                  <SortTh label="Last" active={trackFilter.sort === "lastAt"} order={trackFilter.order} onClick={() => toggleSort("lastAt")} />
                </tr>
              </thead>
              <tbody>
                {trackRows.map((t) => (
                  <tr key={t.trackId}>
                    <td className={cn(tdClass, "max-w-[320px]")}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate", t.title ? "text-foreground" : "font-mono text-warning-text")}>
                          {t.title || `#${t.trackId} (not in catalog)`}
                        </span>
                        {t.permalinkUrl && (
                          <a href={t.permalinkUrl} target="_blank" rel="noreferrer" aria-label="Open on SoundCloud" className="shrink-0 text-muted-foreground hover:text-primary-text">
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </a>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{t.artist || "—"}</div>
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-1">
                        {t.channels.map((c) => (
                          <ChannelChip key={c} channel={c} />
                        ))}
                      </div>
                    </td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums")}>{fmtInt(t.downloads)}</td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums")}>{fmtInt(t.users)}</td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums", t.failures > 0 && "text-warning-text")}>{fmtInt(t.failures)}</td>
                    <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")} title={fmtAbsolute(t.lastAt)}>
                      {timeAgo(t.lastAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
          <Pager page={trackFilter.page} total={tracksQ.data?.total ?? 0} onPage={(page) => setTrackFilter((f) => ({ ...f, page }))} />
        </div>
      </Panel>

      <Panel
        index={8}
        title="People"
        hint="Downloads by account, split by channel. The extension badge means a gate report from that account has ever arrived."
        padded={false}
      >
        <div className="px-4 pt-1 sm:px-5">
          {summaryQ.isPending ? (
            <RowSkeleton rows={4} />
          ) : (summary?.users.length ?? 0) === 0 ? (
            <Empty className="mb-4">Nobody has downloaded anything in this window.</Empty>
          ) : (
            <TableShell minWidth={720}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Account</th>
                  <th scope="col" className={cn(thClass, "text-right")}>Direct</th>
                  <th scope="col" className={cn(thClass, "text-right")}>Hypeddit</th>
                  <th scope="col" className={cn(thClass, "text-right")}>Droploud</th>
                  <th scope="col" className={cn(thClass, "text-right")}>Cobrand</th>
                  <th scope="col" className={cn(thClass, "text-right")}>Failed</th>
                  <th scope="col" className={thClass}>Last</th>
                  <th scope="col" className={thClass}><span className="sr-only">Show their events</span></th>
                </tr>
              </thead>
              <tbody>
                {summary?.users.map((u) => (
                  <tr key={u.userId}>
                    <td className={tdClass}>
                      <span className="font-mono font-medium text-primary-text">@{u.username}</span>
                      {u.usesExtension && (
                        <span className={cn("ml-2 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]", TONE_SOFT.primary)}>extension</span>
                      )}
                    </td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums")}>{fmtInt(u.direct)}</td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums")}>{fmtInt(u.hypeddit)}</td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums")}>{fmtInt(u.droploud)}</td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums")}>{fmtInt(u.cobrand)}</td>
                    <td className={cn(tdClass, "text-right font-mono tabular-nums", u.failures > 0 && "text-warning-text")}>{fmtInt(u.failures)}</td>
                    <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")} title={fmtAbsolute(u.lastAt)}>{timeAgo(u.lastAt)}</td>
                    <td className={tdClass}>
                      <SmallButton
                        className="h-7"
                        onClick={() => setEventFilter({ ...DEFAULT_DOWNLOADS_EVENT_FILTER, userId: u.userId })}
                        aria-label={`Show events for @${u.username}`}
                      >
                        Events
                      </SmallButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </div>
      </Panel>

      <Panel
        index={9}
        title="Recent events"
        hint="Newest first: who, which track, which channel, and why a failure failed."
        padded={false}
        action={<span className="font-mono text-[11px] text-muted-foreground">{eventsQ.isPending ? "Loading…" : `${fmtInt(eventsQ.data?.total)} events`}</span>}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 pb-3 sm:px-5">
          <Segmented
            label="Event channel"
            size="sm"
            options={channelOptions}
            value={eventFilter.channel}
            onChange={(channel) => setEventFilter((f) => ({ ...f, channel, page: 1 }))}
          />
          {eventFilter.userId && (
            <SmallButton className="h-7" onClick={() => setEventFilter((f) => ({ ...f, userId: "", page: 1 }))}>
              <X className="h-3 w-3" aria-hidden="true" /> {filterUser ? `@${filterUser.username}` : "One account"}
            </SmallButton>
          )}
        </div>
        <div className="px-4 pt-1 sm:px-5">
          {eventsQ.isError ? (
            <ErrorNotice message="Could not load download events." onRetry={() => eventsQ.refetch()} />
          ) : eventsQ.isPending ? (
            <RowSkeleton rows={6} />
          ) : eventRows.length === 0 ? (
            <Empty className="mb-4">No events match these filters.</Empty>
          ) : (
            <ul className={cn("divide-y divide-border/40", eventsQ.isPlaceholderData && "opacity-60 transition-opacity")}>
              {eventRows.map((e) => (
                <li key={`${e.operationId}-${e.trackId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12px]">
                  <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground" title={fmtAbsolute(e.at)}>{timeAgo(e.at)}</span>
                  <span className="font-mono font-medium text-primary-text">{who(e.user)}</span>
                  <ChannelChip channel={e.channel} />
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{VIA_LABEL[e.via]}</span>
                  <span className="min-w-0 flex-1 basis-48 truncate text-foreground">
                    {e.title || `#${e.trackId}`}
                    {e.artist && <span className="text-muted-foreground"> · {e.artist}</span>}
                  </span>
                  {e.ok ? (
                    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]", TONE_SOFT.ok)}>OK</span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]", TONE_SOFT.danger)}>Failed</span>
                      {e.reason && <span className="min-w-0 truncate text-muted-foreground" title={e.reason}>{e.reason}</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Pager page={eventFilter.page} total={eventsQ.data?.total ?? 0} onPage={(page) => setEventFilter((f) => ({ ...f, page }))} />
        </div>
      </Panel>
    </div>
  );
}
