"use client";

import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  Sparkles,
  History,
  Search,
  Check,
  Loader2,
  ExternalLink,
  UserPlus,
  RefreshCw,
  Undo2,
  Play,
  Heart,
  ChevronRight,
  Info,
  Clock,
  ShieldAlert,
  BarChart3,
  Download,
} from "lucide-react";
import {
  PageContainer,
  PageHeader,
  Card,
  Button,
  Field,
  IconButton,
  InlineAlert,
  EmptyState,
  ConfirmDialog,
  BulkReviewDetails,
  ProgressBar,
  SelectableRow,
  SelectionBanner,
  Select,
  Input,
  useAnnounce
} from "@/components/ui";
import { ProgressiveBlur } from "@/components/ui/ProgressiveBlur";
import { apiFetch } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import {
  followingsQueryOptions,
  invalidateDashboardSummary,
  useGrowthAnalyticsQuery,
  useGrowthHistoryQuery,
  useGrowthLimitsQuery,
  useGrowthStatsQuery,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { GENRE_FOCUS_OPTIONS, genreLabel } from "@/lib/genres";

const RISK_ACK_KEY = "sc-toolkit-growth-risk-ack";

type TabKey = "discover" | "history" | "analytics";

/**
 * Short labels below `sm`. The three long labels laid end to end were ~510px,
 * which is what pushed the page past 360/390 on a phone — the tab strip was
 * the whole of this route's horizontal overflow.
 */
const TABS: { key: TabKey; short: string; long: string; Icon: typeof Sparkles }[] = [
  { key: "discover", short: "Discover", long: "Discover Suggestions", Icon: Sparkles },
  { key: "history", short: "History", long: "Campaign History", Icon: History },
  { key: "analytics", short: "Analytics", long: "Analytics", Icon: BarChart3 },
];

/** Words, not just a colour and an emoji, for the discovery score. */
const SCORE_BADGE: Record<Suggestion["scoreLabel"], { emoji: string; text: string; className: string }> = {
  high: { emoji: "🔥", text: "High match", className: "bg-tone-match text-tone-foreground" },
  medium: { emoji: "⚡", text: "Medium", className: "bg-amber-400 text-black" },
  limited: {
    emoji: "ℹ",
    text: "Limited data",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200",
  },
  low: { emoji: "🌱", text: "Low", className: "bg-secondary text-muted-foreground" },
};

interface Following {
  id: number;
  username: string;
  avatar_url: string;
  permalink_url: string;
  followers_count: number;
  track_count: number;
}

interface Suggestion {
  user: {
    id: number;
    username: string;
    avatar_url: string;
    permalink_url: string;
    followers_count: number;
    followings_count: number;
    track_count: number;
  };
  score: number;
  scoreLabel: 'high' | 'medium' | 'low' | 'limited';
  signals: {
    followBackRatio: number;
    sharedInspirationCount: number;
    isRelatedArtist: boolean;
    isCreator: boolean;
    genreAffinity?: number | null;
  };
  /** Top genres from the candidate's recent tracks (empty when unknown). */
  genres?: string[];
  suggestedTrack: {
    id: number;
    title: string;
    artwork_url: string;
    likes_count: number;
    playback_count: number;
    permalink_url: string;
  } | null;
}

interface GrowthAction {
  id: string;
  actionType: 'follow' | 'like';
  targetId: number;
  targetName: string | null;
  targetAvatar: string | null;
  targetFollowers: number | null;
  targetFollowings: number | null;
  followedBack: boolean | null;
  checkedAt: string | null;
  reversed: boolean;
  reversedAt: string | null;
  sessionId: string | null;
  sessionLabel: string | null;
  createdAt: string;
}

interface SessionGroup {
  sessionId: string;
  label: string;
  date: string;
  totalActions: number;
  followedBack: number;
  notFollowedBack: number;
  unchecked: number;
  reversed: number;
}

interface DiscoveryStats {
  inspirationUsers: number;
  candidatesScanned: number;
  afterDedup: number;
  suggestionsReturned: number;
  seedGenres?: string[];
  /** Set when the scan ran with a genre focus. */
  genreFocus?: string | null;
  genreChecked?: number | null;
  genreMatched?: number | null;
  genreUnknown?: number | null;
  /** Candidates whose lookup never ran because the time budget was spent. */
  genreSkipped?: number | null;
  durationMs?: number;
  sampleCapPerSeed?: number;
  sampledFollowers?: boolean;
  partial?: boolean;
  /** The seed crawl itself was cut short (distinct from skipped genre lookups). */
  crawlPartial?: boolean;
  /** Candidates whose track lookup never ran (deadline), focus or not. */
  lookupsSkipped?: number;
  perSeed?: {
    id: number;
    followersFetched: number;
    followingsFetched: number;
    sampled: boolean;
    skipped: boolean;
  }[];
}

interface GrowthBudget {
  dailyCap: number;
  used24h: number;
  remaining: number;
  cooldownRemainingMs: number;
}

interface EngageJob {
  sessionId: string;
  sessionLabel: string;
  status: "running" | "complete" | "cancelled" | "error";
  current: number;
  total: number;
  followed: number;
  liked: number;
  errorCount: number;
  likeTracks: boolean;
}

interface SeedConversion {
  seedId: string;
  name: string;
  follows: number;
  followedBack: number;
  checked: number;
  rate: number | null;
}

interface FollowBackBucket {
  bucket: string;
  followedBack: number;
  notFollowedBack: number;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}` : `${remainingSeconds}s`;
}

/**
 * Ticks its own "elapsed" display once a second while a discovery request
 * is in flight. Kept as its own component (with its own interval + state)
 * so the 1Hz tick re-renders only this small block instead of the entire
 * ~1500-line GrowthPage tree.
 */
function DiscoveryElapsedTimer({
  startedAt,
  estimatedSeconds,
}: {
  startedAt: number;
  estimatedSeconds: number;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <div>Elapsed: {formatDuration(elapsedSeconds)} · usually about {formatDuration(estimatedSeconds)}</div>
  );
}

export default function GrowthPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [activeTab, setActiveTab] = useState<TabKey>("discover");
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});

  // Tab 1: Discover state
  const [selectedInspirations, setSelectedInspirations] = useState<Set<number>>(new Set());
  const [strategy, setStrategy] = useState<'followers' | 'followings' | 'both'>('followers');
  // "any" = no focus. Anything else is a slug from lib/genres.ts.
  const [genreFocus, setGenreFocus] = useState<string>("any");
  const [discoveryStep, setDiscoveryStep] = useState<1 | 2 | 3 | 4>(1);
  const [searchInspirations, setSearchInspirations] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [discoveryStats, setDiscoveryStats] = useState<DiscoveryStats | null>(null);
  const [discoveryStartedAt, setDiscoveryStartedAt] = useState<number | null>(null);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<number>>(new Set());
  const [likeTracks, setLikeTracks] = useState(false); // auto-like is opt-in
  const [recentEngagedCount, setRecentEngagedCount] = useState({ followed: 0, liked: 0 });

  // Engagement job (server-paced batch)
  const [job, setJob] = useState<EngageJob | null>(null);

  // Risk interstitial
  const [showRiskModal, setShowRiskModal] = useState(false);

  // Tab 2: History state
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedHistoryActions, setSelectedHistoryActions] = useState<Set<string>>(new Set());
  const [reversing, setReversing] = useState(false);
  const [checkingFollowbacks, setCheckingFollowbacks] = useState(false);
  const [showReverseConfirm, setShowReverseConfirm] = useState(false);

  // General Notification
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info" | "warning"; text: string } | null>(null);

  // Fetch followings for Step 1
  const { data: followingsData } = useSuspenseQuery(followingsQueryOptions());
  const followings = asArray<Following>(followingsData?.collection);

  // Fetch History & Stats
  const historyQuery = useGrowthHistoryQuery({ enabled: activeTab === 'history' });
  const historyData = historyQuery.data as unknown as
    | { actions?: GrowthAction[]; sessions?: SessionGroup[] }
    | undefined;
  const refetchHistory = historyQuery.refetch;

  // Normalised once, and every read below goes through these. The raw shape
  // is cast from `unknown`, so TypeScript was vouching for arrays it had
  // never seen: a response missing either key — a `{}` from an error path, a
  // rename upstream — turned `historyData.sessions.length` into a render
  // crash that took the whole History tab down. Empty arrays render the
  // empty state instead, which is the honest answer to "no history".
  const historySessions: SessionGroup[] = Array.isArray(historyData?.sessions)
    ? historyData.sessions
    : [];
  const historyActions: GrowthAction[] = Array.isArray(historyData?.actions)
    ? historyData.actions
    : [];

  const { data: statsData, refetch: refetchStats } = useGrowthStatsQuery({
    enabled: activeTab === 'history' || activeTab === 'analytics',
  });

  // Daily follow budget + cooldown
  const { data: budget, refetch: refetchBudget } = useGrowthLimitsQuery();

  // Per-seed conversion analytics
  const analyticsQuery = useGrowthAnalyticsQuery({ enabled: activeTab === 'analytics' });
  const analytics = analyticsQuery.data as unknown as
    | {
        perSeed?: SeedConversion[];
        followBackCurve?: FollowBackBucket[];
        totalFollows?: number;
      }
    | undefined;

  // Same cast-from-`unknown` hazard as the history payload above, and the
  // same fix: `!analytics` only covers a missing response, not a present one
  // missing a key, so `analytics.perSeed.length` on a `{}` crashed the
  // Analytics tab exactly as `{}` crashed History. Empty arrays fall through
  // to the "not enough data yet" states, which is the honest answer.
  const analyticsPerSeed: SeedConversion[] = Array.isArray(analytics?.perSeed)
    ? analytics.perSeed
    : [];
  const analyticsCurve: FollowBackBucket[] = Array.isArray(analytics?.followBackCurve)
    ? analytics.followBackCurve
    : [];

  // Discovery Mutation
  const discoverMutation = useMutation({
    mutationFn: async (payload: { inspirationUserIds: number[]; strategy: string; genre?: string }) => {
      setDiscoveryStartedAt(Date.now());
      setDiscoveryStep(2);
      const res = await apiFetch("/api/growth/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to run discovery");
      return res.json();
    },
    onSuccess: (data) => {
      setDiscoveryStartedAt(null);
      setSuggestions(data.suggestions);
      setDiscoveryStats(data.stats);
      // Select all high and medium suggestions by default
      const autoSelected = new Set<number>(
        data.suggestions
          .filter((s: Suggestion) => s.scoreLabel === "high" || s.scoreLabel === "medium")
          .map((s: Suggestion) => s.user.id)
      );
      setSelectedSuggestions(autoSelected);
      setDiscoveryStep(3);
      const found = data.suggestions.length;
      const focus: string | null | undefined = data.stats?.genreFocus;
      announce(
        focus
          ? `Discovery finished — ${found} ${genreLabel(focus)} suggestion${found === 1 ? "" : "s"} found, ${autoSelected.size} selected.`
          : `Discovery finished — ${found} suggestion${found === 1 ? "" : "s"} found, ${autoSelected.size} selected.`,
      );
    },
    onError: (err: Error) => {
      setDiscoveryStartedAt(null);
      setNotice({ type: "error", text: err.message || "Failed to scan networks. SoundCloud might be rate limiting." });
      setDiscoveryStep(1);
    }
  });

  // A discovery request is intentionally synchronous so results are complete
  // when displayed. The elapsed-time readout while waiting lives in its own
  // <DiscoveryElapsedTimer> component (below) so its 1Hz tick doesn't
  // re-render this whole page.

  // Start a server-paced engagement batch. The server enforces the daily
  // cap + cooldown and runs the follows in the background; we poll status.
  const startEngagement = async () => {
    if (selectedSuggestions.size === 0) return;
    setShowRiskModal(false);

    const selectedList = suggestions.filter(s => selectedSuggestions.has(s.user.id));
    const seedFollowings = followings.filter(f => selectedInspirations.has(f.id));
    const inspirationNames = seedFollowings.map(f => f.username).join(",");
    const shortNames = seedFollowings.map(f => f.username).slice(0, 3).join(", ");
    const sessionLabel = `Seed: ${shortNames}${selectedInspirations.size > 3 ? "…" : ""} — ${new Date().toLocaleDateString()}`;

    const targets = selectedList.map(s => ({
      userId: s.user.id,
      likeTrackId: likeTracks ? s.suggestedTrack?.id ?? null : null,
      targetName: s.user.username,
      targetAvatar: s.user.avatar_url,
      targetFollowers: s.user.followers_count,
      targetFollowings: s.user.followings_count,
    }));

    try {
      const res = await apiFetch("/api/growth/engage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets,
          likeTracks,
          sessionLabel,
          inspirationIds: Array.from(selectedInspirations).join(","),
          inspirationNames,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: "error", text: data.error || "Failed to start engagement batch." });
        if (data.budget) refetchBudget();
        return;
      }
      setJob(data.job);
      setNotice({
        type: "info",
        text: `Engagement started — following ${targets.length} user${targets.length === 1 ? "" : "s"} at a safe pace. You can leave this page; it runs in the background.`,
      });
    } catch {
      setNotice({ type: "error", text: "Failed to start engagement batch." });
    }
  };

  // Poll engagement job status while one is running
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch("/api/growth/engage/status");
        const data = await res.json();
        if (data.job) {
          setJob(data.job);
          if (data.job.status !== "running") {
            clearInterval(interval);
            setRecentEngagedCount({ followed: data.job.followed, liked: data.job.liked });
            setDiscoveryStep(4);
            refetchBudget();
            invalidateDashboardSummary(queryClient);
            announce(
              `Engagement ${data.job.status} — followed ${data.job.followed}, liked ${data.job.liked}.`,
            );
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [job, queryClient, refetchBudget, announce]);

  const cancelEngagement = async () => {
    try {
      await apiFetch("/api/growth/engage/cancel", { method: "POST" });
      setNotice({ type: "info", text: "Cancelling after the current action…" });
    } catch {
      /* ignore */
    }
  };

  // Confirm-or-run entry point for the engage banner
  const handleEngageClick = () => {
    if (selectedSuggestions.size === 0) return;
    const acked = typeof window !== "undefined" && localStorage.getItem(RISK_ACK_KEY) === "true";
    if (acked) {
      startEngagement();
    } else {
      setShowRiskModal(true);
    }
  };

  const acknowledgeRiskAndEngage = () => {
    try {
      localStorage.setItem(RISK_ACK_KEY, "true");
    } catch {
      /* ignore */
    }
    startEngagement();
  };

  // Track preview — the stream file is auth-gated, so open the track on
  // SoundCloud in a new tab as the reliable preview.
  const previewTrack = useCallback((track: NonNullable<Suggestion["suggestedTrack"]>) => {
    window.open(track.permalink_url, "_blank", "noopener");
  }, []);

  const exportSessionCsv = (sessionLabel: string, actions: GrowthAction[]) => {
    const rows: unknown[][] = [
      ["Target", "Action", "Followed Back", "Reversed", "Date"],
      ...actions.map((a) => [
        a.targetName || "",
        a.actionType,
        a.followedBack === null ? "unchecked" : a.followedBack ? "yes" : "no",
        a.reversed ? "yes" : "no",
        new Date(a.createdAt).toISOString(),
      ]),
    ];
    const safe = sessionLabel.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    downloadCsv(`growth-${safe || "session"}.csv`, rows);
  };

  // Followback Checker Mutation
  const checkFollowbacksMutation = useMutation({
    mutationFn: async (sessId: string | null) => {
      setCheckingFollowbacks(true);
      const res = await apiFetch("/api/growth/check-followbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessId }),
      });
      if (!res.ok) throw new Error("Failed to check followbacks");
      return res.json();
    },
    onSuccess: (data) => {
      setNotice({
        type: "success",
        text: `Checked ${data.checked} users. Found ${data.followedBack} new followbacks! (${data.alreadyChecked} skipped on cooldown)`
      });
      refetchHistory();
      refetchStats();
    },
    onError: (err: Error) => {
      setNotice({ type: "error", text: err.message || "Failed to verify followbacks." });
    },
    onSettled: () => {
      setCheckingFollowbacks(false);
    }
  });

  // Reversal Mutation
  const reverseMutation = useMutation({
    mutationFn: async (payload: { 
      actionIds?: string[]; 
      filter?: { sessionId?: string; followedBack?: boolean; actionType?: 'follow' | 'like' } 
    }) => {
      setReversing(true);
      const res = await apiFetch("/api/growth/reverse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Reversal failed");
      return res.json();
    },
    onSuccess: (data) => {
      setNotice({
        type: "success",
        text: `Successfully reversed ${data.reversed} actions. (${data.failed} failed)`
      });
      setSelectedHistoryActions(new Set());
      refetchHistory();
      refetchStats();
      invalidateDashboardSummary(queryClient);
    },
    onError: (err: Error) => {
      setNotice({ type: "error", text: err.message || "Failed to reverse actions." });
    },
    onSettled: () => {
      setReversing(false);
      setShowReverseConfirm(false);
    }
  });

  // Helper formatting functions
  const formatNumber = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  // The server samples each seed's most recent SEED_SAMPLE_CAP followers
  // (recent followers are the most active), crawling 2 seeds at a time in
  // pages of 200. Estimate from the selected seeds' actual follower counts.
  const SEED_SAMPLE_CAP = 1000;
  const CRAWL_PAGE_SIZE = 200;
  const selectedSeeds = followings.filter((f) => selectedInspirations.has(f.id));
  const anySeedSampled = selectedSeeds.some((f) => (f.followers_count ?? 0) > SEED_SAMPLE_CAP);
  const estimatedDiscoverySeconds = (() => {
    const pagesForSeed = (f: Following) => {
      const followerPages = Math.min(
        Math.ceil(Math.max(f.followers_count ?? CRAWL_PAGE_SIZE, 1) / CRAWL_PAGE_SIZE),
        SEED_SAMPLE_CAP / CRAWL_PAGE_SIZE
      );
      return followerPages * (strategy === "both" ? 2 : 1);
    };
    const totalPages = selectedSeeds.reduce((sum, f) => sum + pagesForSeed(f), 0);
    const crawlSeconds = (totalPages * 1.2) / 2; // ~1.2s per page, 2 seeds crawled concurrently
    // + auth lists / related artists + track lookups. A genre focus looks up
    // up to 150 candidates' tracks instead of ~50: ~100 more calls, 5 at a time.
    const focusSeconds = genreFocus !== "any" ? 16 : 0;
    return Math.min(60, Math.round(10 + crawlSeconds + 8 + focusSeconds));
  })();

  // A focus only explains an empty result when it actually checked someone;
  // with nothing checked (e.g. no candidates at all) the genre is not to blame.
  const focusBlamesGenre = Boolean(discoveryStats?.genreFocus) && (discoveryStats?.genreChecked ?? 0) > 0;

  // One notice for the time budget, whichever combination of crawl and lookups
  // it cut short. Nothing here may claim the results are "fully scored".
  const budgetNotice = (() => {
    const st = discoveryStats;
    if (!st) return null;
    const crawlCut = st.crawlPartial ?? st.partial ?? false;
    const focused = Boolean(st.genreFocus);
    const n = (focused ? st.genreSkipped : st.lookupsSkipped) ?? 0;
    const lookupCut =
      n > 0
        ? focused
          ? `${n} ${n === 1 ? "candidate was" : "candidates were"} not checked for genre and ${n === 1 ? "was" : "were"} left out`
          : `${n} ${n === 1 ? "suggestion wasn't" : "suggestions weren't"} scored for genre or recent tracks — those details are missing, and they were ranked without genre fit`
        : null;
    if (crawlCut && lookupCut) {
      return `The scan hit its time budget: results come from a partial crawl, and ${lookupCut}.`;
    }
    if (crawlCut) return "The scan hit its time budget, so results come from a partial crawl.";
    if (lookupCut) return `The scan hit its time budget: ${lookupCut}.`;
    return null;
  })();

  const noneOf = (n: number | null | undefined) => (n === 1 ? "The 1 account" : `None of the ${n ?? 0} accounts`);
  const emptyDescription = (() => {
    const st = discoveryStats;
    if (focusBlamesGenre && st?.genreFocus) {
      const label = genreLabel(st.genreFocus);
      const unplaced = (st.genreUnknown ?? 0) + (st.genreSkipped ?? 0);
      return unplaced === 0
        ? `${noneOf(st.genreChecked)} checked had recent tracks tagged ${label}. Scan again with any genre, or pick different seeds.`
        : `${noneOf(st.genreChecked)} checked matched ${label}, but ${unplaced} could not be placed (no genre info, or not checked in time), so a match may exist among them. Scan again with any genre, or pick different seeds.`;
    }
    if (st?.genreFocus && (st.genreSkipped ?? 0) > 0) {
      return "The scan ran out of its time budget before any account could be checked for genre. Try again, or use fewer seeds.";
    }
    return "Try selecting different inspiration users or strategy.";
  })();

  const handleInspirationClick = (id: number) => {
    setSelectedInspirations(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 5) {
          setNotice({ type: "error", text: "You can select a maximum of 5 seed users." });
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const selectTab = (key: TabKey) => {
    setActiveTab(key);
    setNotice(null);
    if (key === "history") {
      refetchHistory();
      refetchStats();
    }
  };

  /**
   * Arrow-key navigation across the tab strip, with a roving tabIndex so Tab
   * enters the strip once rather than stepping through all three tabs.
   */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order = TABS.map((t) => t.key);
    const index = order.indexOf(activeTab);
    let next: TabKey | null = null;
    if (event.key === "ArrowRight") next = order[(index + 1) % order.length];
    else if (event.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length];
    else if (event.key === "Home") next = order[0];
    else if (event.key === "End") next = order[order.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const toggleSuggestion = (id: number) => {
    setSelectedSuggestions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllSuggestions = () => {
    if (selectedSuggestions.size === suggestions.length) {
      setSelectedSuggestions(new Set());
    } else {
      setSelectedSuggestions(new Set(suggestions.map(s => s.user.id)));
    }
  };

  const toggleHistoryAction = (id: string) => {
    setSelectedHistoryActions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllHistoryActions = (actions: GrowthAction[]) => {
    if (selectedHistoryActions.size === actions.length) {
      setSelectedHistoryActions(new Set());
    } else {
      setSelectedHistoryActions(new Set(actions.map(a => a.id)));
    }
  };

  const filteredInspirations = followings.filter(f =>
    !searchInspirations || f.username?.toLowerCase().includes(searchInspirations.toLowerCase())
  );

  const selectedSession = historySessions.find(s => s.sessionId === selectedSessionId);
  const sessionActions = historyActions.filter(a => a.sessionId === selectedSessionId);

  return (
    <PageContainer maxWidth="wide" className="pb-28">
      <PageHeader
        title="Grow Your Network"
        description="Discover active SoundCloud users likely to follow you back, engage with their tracks, and reverse campaigns anytime."
      />

      {notice && (
        <InlineAlert
          variant={notice.type}
          className="mb-6"
          onDismiss={() => setNotice(null)}
        >
          {notice.text}
        </InlineAlert>
      )}

      {/* Tabs Selector */}
      <div className="mb-6 overflow-x-auto">
        <div
          role="tablist"
          aria-label="Growth sections"
          className="flex w-full gap-1 rounded-lg border-2 border-border/50 bg-secondary/20 p-1 sm:w-fit"
        >
          {TABS.map(({ key, short, long, Icon }) => (
            <button
              key={key}
              ref={(element) => {
                tabRefs.current[key] = element;
              }}
              type="button"
              role="tab"
              id={`growth-tab-${key}`}
              aria-selected={activeTab === key}
              aria-controls={`growth-panel-${key}`}
              tabIndex={activeTab === key ? 0 : -1}
              onClick={() => selectTab(key)}
              onKeyDown={handleTabKeyDown}
              className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-semibold transition-all sm:flex-none sm:gap-2 sm:px-4 ${
                activeTab === key
                  ? "bg-card text-primary-text shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{long}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Discover Tab */}
      {activeTab === "discover" && (
        <div
          role="tabpanel"
          id="growth-panel-discover"
          aria-labelledby="growth-tab-discover"
        >
          {/* Daily budget / cooldown banner */}
          {budget && (
            <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border/60 bg-secondary/20 px-4 py-2.5 text-xs">
              <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                <ShieldAlert className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Daily follow budget
              </span>
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{budget.remaining}</span> of {budget.dailyCap} left
              </span>
              {budget.cooldownRemainingMs > 0 && (
                <span className="text-warning-text">
                  Cooldown: {Math.ceil(budget.cooldownRemainingMs / 60000)} min until next batch
                </span>
              )}
              {/* `text-muted-foreground-subtle` measures 4.4:1 against this
                  tinted banner — just under AA, so this one line steps up to
                  the full-strength muted token. */}
              <span className="ml-auto text-muted-foreground">
                Caps protect your account from spam flags.
              </span>
            </div>
          )}
          {/* STEP 1: Select Seeds */}
          {discoveryStep === 1 && (
            <Card className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-bold text-foreground">1. Select Inspiration Users</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Select 1–5 users you follow to scan their networks. We'll find people who follow them and similar artists.
                </p>
              </div>

              {/* Crawl strategy and search */}
              <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
                <Field label="Search your followings">
                  {(field) => (
                    <div className="relative">
                      <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        {...field}
                        type="search"
                        value={searchInspirations}
                        onChange={(e) => setSearchInspirations(e.target.value)}
                        placeholder="Username"
                        className="pl-9 h-11 bg-secondary/20 border-border"
                      />
                    </div>
                  )}
                </Field>

                {/* The id is the one ea978e8 gave this control; the visible
                    label now points at it, so the accessible name survives. */}
                <Select
                  id="growth-seed-strategy"
                  label="Strategy"
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as 'followers' | 'followings' | 'both')}
                  className="bg-secondary/20"
                >
                  <option value="followers">Scan Their Followers</option>
                  <option value="followings">Scan Their Followings</option>
                  <option value="both">Scan Both</option>
                </Select>

                <Field
                  id="growth-genre-focus"
                  label="Genre focus"
                  hint="Only suggests accounts whose recent tracks match; checks more accounts, so the scan takes a little longer."
                  className="sm:col-span-2"
                >
                  {(field) => (
                    <Select
                      {...field}
                      value={genreFocus}
                      onChange={(e) => setGenreFocus(e.target.value)}
                      className="bg-secondary/20"
                    >
                      <option value="any">Any genre</option>
                      {GENRE_FOCUS_OPTIONS.map((o) => (
                        <option key={o.slug} value={o.slug}>{o.label}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>

              <div className="text-sm text-muted-foreground mb-3 flex items-center justify-between gap-3">
                <span role="status">{selectedInspirations.size} of 5 selected</span>
                {selectedInspirations.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedInspirations(new Set())}
                    className="text-primary-text"
                  >
                    Clear Selection
                  </Button>
                )}
              </div>

              {/* Grid lists */}
              <ProgressiveBlur
                className="grid sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[60dvh] overflow-y-auto"
                active={filteredInspirations.length > 9}
                fadeHeight={72}
              >
                {filteredInspirations.map((user) => (
                  <SelectableRow
                    key={user.id}
                    as="div"
                    id={user.id}
                    selected={selectedInspirations.has(user.id)}
                    onToggle={() => handleInspirationClick(user.id)}
                    label={user.username}
                  >
                    <span className="flex items-center gap-3">
                      <img
                        src={user.avatar_url || "/brand/icon-192.png"}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        decoding="async"
                        className="w-10 h-10 rounded-full object-cover shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-sm truncate text-foreground">{user.username}</span>
                        <span className="block text-xs text-muted-foreground truncate">{formatNumber(user.followers_count)} followers</span>
                      </span>
                    </span>
                  </SelectableRow>
                ))}
              </ProgressiveBlur>

              {/* Start Discovery Trigger */}
              <div className="mt-6 flex justify-end">
                <Button
                  onClick={() => discoverMutation.mutate({
                    inspirationUserIds: Array.from(selectedInspirations),
                    strategy,
                    ...(genreFocus !== "any" ? { genre: genreFocus } : {}),
                  })}
                  disabled={selectedInspirations.size === 0 || discoverMutation.isPending}
                  className="gap-2 h-11 px-6 shadow-glow-sm"
                >
                  {discoverMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  Scan Networks & Discover
                </Button>
              </div>
            </Card>
          )}

          {/* STEP 2: Loading scanning state */}
          {discoveryStep === 2 && (
            <Card
              role="status"
              className="p-6 sm:p-12 flex flex-col items-center justify-center text-center"
            >
              <div className="relative mb-6" aria-hidden="true">
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping duration-1000" />
                <div className="relative w-16 h-16 rounded-full bg-primary/10 border-2 border-primary flex items-center justify-center text-primary">
                  <Loader2 className="w-8 h-8 animate-spin" />
                </div>
              </div>
              <h2 className="text-xl font-bold text-foreground">Scanning Networks</h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-md">
                Crawling followers and related artists for your selected seed users. We filter out accounts you already follow, then compare scene and activity signals.
                {anySeedSampled && (
                  <> For large seeds we sample their ~{SEED_SAMPLE_CAP.toLocaleString()} most recent followers — recent followers are the most active.</>
                )}
              </p>
              <div className="mt-6 space-y-1 text-xs text-primary-text font-mono">
                {discoveryStartedAt != null && (
                  <DiscoveryElapsedTimer
                    startedAt={discoveryStartedAt}
                    estimatedSeconds={estimatedDiscoverySeconds}
                  />
                )}
                <div className="animate-pulse">Fetching profile signals in small, rate-limit-safe batches…</div>
              </div>
              <p className="mt-3 max-w-md text-xs text-muted-foreground">
                SoundCloud can occasionally take up to a minute to respond; this scan will finish automatically when every shown profile has been checked.
              </p>
            </Card>
          )}

          {/* STEP 3: Suggestions List */}
          {discoveryStep === 3 && (
            <>
              <Card className="p-6 mb-6">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-4 mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-foreground">Discovery Results</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Scanned {discoveryStats?.candidatesScanned} profiles → found {discoveryStats?.afterDedup} new candidates, scored by scene fit
                      {discoveryStats?.durationMs ? ` in ${formatDuration(Math.round(discoveryStats.durationMs / 1000))}` : ""}.
                    </p>
                    {discoveryStats?.sampledFollowers && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Large seeds were sampled: most recent {(discoveryStats.sampleCapPerSeed ?? 1000).toLocaleString()} followers per seed — the slice most likely to still be active.
                      </p>
                    )}
                    {budgetNotice && (
                      <p data-testid="budget-notice" className="text-xs text-warning-text mt-1">
                        {budgetNotice}
                      </p>
                    )}
                    {discoveryStats?.genreFocus && (
                      <p className="mt-1 text-xs text-foreground">
                        <span className="font-semibold">Focus: {genreLabel(discoveryStats.genreFocus)}</span>
                        {" · "}
                        {discoveryStats.genreMatched ?? 0} of {discoveryStats.genreChecked ?? 0} checked matched
                        {(discoveryStats.genreMatched ?? 0) > suggestions.length && ` (showing top ${suggestions.length})`}
                        {((discoveryStats.genreUnknown ?? 0) > 0 || (discoveryStats.genreSkipped ?? 0) > 0) && (
                          <span className="text-muted-foreground">
                            {" "}
                            ({[
                              (discoveryStats.genreUnknown ?? 0) > 0 ? `${discoveryStats.genreUnknown} had no genre info` : null,
                              (discoveryStats.genreSkipped ?? 0) > 0 ? `${discoveryStats.genreSkipped} not checked in time` : null,
                            ].filter(Boolean).join(", ")}; left out)
                          </span>
                        )}
                      </p>
                    )}
                    {discoveryStats?.seedGenres && discoveryStats.seedGenres.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs uppercase tracking-wider text-muted-foreground">Scene:</span>
                        {discoveryStats.seedGenres.slice(0, 6).map((g) => (
                          <span key={g} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-text">
                            {g}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-3">
                    <Button variant="outline" size="sm" onClick={() => setDiscoveryStep(1)}>
                      Back / Adjust Seeds
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleAllSuggestions}
                      className="text-primary-text"
                    >
                      {selectedSuggestions.size === suggestions.length ? "Deselect All" : "Select All"}
                    </Button>
                  </div>
                </div>

                {/* Opt-in auto-like (off by default — halves write volume) */}
                <label className="mb-4 flex items-start gap-3 rounded-xl border border-border/60 bg-secondary/20 px-4 py-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={likeTracks}
                    onChange={(e) => setLikeTracks(e.target.checked)}
                    className="mt-0.5 h-6 w-6 shrink-0 accent-primary"
                  />
                  <span className="text-xs leading-5 text-muted-foreground">
                    <span className="font-semibold text-foreground">Also like each user&apos;s top track</span> when following.
                    Off by default — following alone is a lighter footprint and less likely to trip spam filters.
                  </span>
                </label>

                {suggestions.length === 0 ? (
                  <EmptyState
                    icon={<Info className="w-12 h-12" />}
                    title={focusBlamesGenre ? `No ${genreLabel(discoveryStats!.genreFocus!)} matches` : "No suggestions found"}
                    description={emptyDescription}
                    action={
                      focusBlamesGenre ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={discoverMutation.isPending}
                          onClick={() => {
                            setGenreFocus("any");
                            discoverMutation.mutate({
                              inspirationUserIds: Array.from(selectedInspirations),
                              strategy,
                            });
                          }}
                        >
                          Scan again with any genre
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <ProgressiveBlur
                    className="grid md:grid-cols-2 gap-4 max-h-[60dvh] overflow-y-auto pr-1"
                    active={suggestions.length > 6}
                    fadeHeight={72}
                  >
                    {suggestions.map((sug) => {
                      const badge = SCORE_BADGE[sug.scoreLabel];
                      const track = sug.suggestedTrack;
                      return (
                        <SelectableRow
                          key={sug.user.id}
                          as="div"
                          id={sug.user.id}
                          selected={selectedSuggestions.has(sug.user.id)}
                          onToggle={() => toggleSuggestion(sug.user.id)}
                          label={sug.user.username}
                          className="items-start py-3"
                          rightSlot={
                            // Both controls sit outside the toggle label: a
                            // button inside a label is a nested interactive
                            // control, and the old card had two of them.
                            <div className="flex flex-col items-center gap-1">
                              <a
                                href={sug.user.permalink_url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${sug.user.username} on SoundCloud`}
                                className="touch-44 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                              >
                                <ExternalLink className="w-4 h-4" aria-hidden="true" />
                              </a>
                              {track && (
                                <IconButton
                                  label={`Preview ${track.title} on SoundCloud`}
                                  onClick={() => previewTrack(track)}
                                  className="min-h-11 min-w-11 text-primary hover:text-primary-text"
                                >
                                  <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                                </IconButton>
                              )}
                            </div>
                          }
                        >
                          <span className="block">
                            {/* Upper user info */}
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-sm text-foreground truncate">{sug.user.username}</span>
                              <span
                                className={`text-xs font-bold px-2 py-0.5 rounded-full uppercase select-none ${badge.className}`}
                              >
                                <span aria-hidden="true">{badge.emoji} </span>
                                {badge.text} ({sug.score}%)
                              </span>
                            </span>
                            <span className="text-xs text-muted-foreground flex gap-x-2 mt-0.5">
                              <span>{formatNumber(sug.user.followers_count)} followers</span>
                              <span aria-hidden="true">•</span>
                              <span>Ratio: {sug.signals.followBackRatio}</span>
                            </span>

                            {sug.genres && sug.genres.length > 0 && (
                              <span className="mt-2 flex flex-wrap gap-1.5">
                                {sug.genres.slice(0, 3).map((g) => (
                                  <span
                                    key={g}
                                    className="max-w-full truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-text"
                                  >
                                    {g}
                                  </span>
                                ))}
                              </span>
                            )}

                            {/* Seed reason */}
                            <span className="mt-2 block w-fit text-xs bg-secondary/40 px-2.5 py-1 rounded-md text-muted-foreground">
                              {sug.signals.isRelatedArtist ? "SoundCloud Related Artist" : "Discovered in seeds' follower network"}
                            </span>

                            {/* Suggested track to like */}
                            {track ? (
                              <span className="mt-2 flex items-center gap-3 p-2 bg-card rounded-lg border border-border/50 text-xs">
                                <img
                                  src={track.artwork_url || "/brand/icon-192.png"}
                                  alt=""
                                  width={40}
                                  height={40}
                                  loading="lazy"
                                  decoding="async"
                                  className="w-10 h-10 rounded object-cover shrink-0"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium text-foreground truncate">{track.title}</span>
                                  <span className="text-muted-foreground flex items-center gap-1 mt-0.5">
                                    <Heart className="w-3 h-3 text-primary fill-primary" aria-hidden="true" />
                                    <span>{formatNumber(track.likes_count)} likes</span>
                                  </span>
                                </span>
                              </span>
                            ) : (
                              <span className="mt-2 block text-xs text-muted-foreground italic">No tracks uploaded</span>
                            )}
                          </span>
                        </SelectableRow>
                      );
                    })}
                  </ProgressiveBlur>
                )}
              </Card>

              {/* Live batch progress */}
              {job && job.status === "running" && (
                <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-card/95 backdrop-blur">
                  <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
                    <div className="flex items-center justify-between gap-4">
                      <ProgressBar
                        className="min-w-0 flex-1"
                        label="Following"
                        value={job.current}
                        max={job.total}
                        detail={job.likeTracks ? `${job.liked} liked` : undefined}
                      />
                      <Button variant="outline" size="sm" onClick={cancelEngagement} nowrap>
                        Stop
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Bottom selection banner */}
              {(!job || job.status !== "running") && (
                <SelectionBanner
                  count={selectedSuggestions.size}
                  entityName="user"
                  actionLabel={likeTracks ? "Follow + like selected" : "Follow selected"}
                  onAction={handleEngageClick}
                  actionIcon={<UserPlus className="w-4 h-4" />}
                />
              )}
            </>
          )}

          {/* STEP 4: Success confirmation summary */}
          {discoveryStep === 4 && (
            <Card className="p-8 text-center max-w-xl mx-auto">
              <div
                className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 flex items-center justify-center mx-auto mb-4 border border-green-200"
                aria-hidden="true"
              >
                <Check className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold text-foreground">Campaign Initiated!</h2>
              <p className="text-sm text-muted-foreground mt-2">
                We've successfully processed your selected engagement actions.
              </p>

              <div className="grid grid-cols-2 gap-4 mt-6 p-4 bg-secondary/20 rounded-xl">
                <div>
                  <div className="text-2xl font-bold text-primary">{recentEngagedCount.followed}</div>
                  <div className="text-xs text-muted-foreground font-semibold uppercase mt-0.5">Users Followed</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-primary">{recentEngagedCount.liked}</div>
                  <div className="text-xs text-muted-foreground font-semibold uppercase mt-0.5">Tracks Liked</div>
                </div>
              </div>

              <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
                <Button
                  variant="outline"
                  onClick={() => selectTab("history")}
                  className="gap-2"
                >
                  <History className="w-4 h-4" aria-hidden="true" />
                  View Campaign History
                </Button>
                <Button nowrap
                  onClick={() => {
                    setSelectedInspirations(new Set());
                    setDiscoveryStep(1);
                  }}
                  className="gap-2 shadow-glow-sm"
                >
                  <Sparkles className="w-4 h-4" />
                  Discover Again
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === "history" && (
        <div
          role="tabpanel"
          id="growth-panel-history"
          aria-labelledby="growth-tab-history"
        >
          {/* Dashboard Stats Panel */}
          {statsData && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Followed</span>
                <span className="text-2xl font-bold mt-1 text-foreground">{statsData.totalFollowed}</span>
              </Card>
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Liked</span>
                <span className="text-2xl font-bold mt-1 text-foreground">{statsData.totalLiked}</span>
              </Card>
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Followback Rate</span>
                <span className="text-2xl font-bold mt-1 text-primary">
                  {Math.round(statsData.followedBackRate * 100)}%
                </span>
              </Card>
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Active Follows</span>
                <span className="text-2xl font-bold mt-1 text-foreground">{statsData.activeFollows}</span>
              </Card>
            </div>
          )}

          <div className="grid lg:grid-cols-3 gap-6">
            {/* Left sidebar: Sessions selection */}
            <div className="lg:col-span-1 space-y-4">
              <Card className="p-4">
                <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-3 mb-3">
                  <h2 className="text-sm font-bold text-foreground">Discovery Sessions</h2>
                  <Button
                    variant="outline"
                    size="sm"
                    nowrap
                    className="px-2"
                    onClick={() => checkFollowbacksMutation.mutate(null)}
                    disabled={checkingFollowbacks || historyActions.length === 0}
                  >
                    {checkingFollowbacks ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span className="sm:hidden">Check</span>
                    <span className="hidden sm:inline">Check All</span>
                  </Button>
                </div>

                {historySessions.length === 0 ? (
                  <EmptyState
                    icon={<Clock className="w-8 h-8" />}
                    title="No sessions logged"
                    description="Completed campaigns will appear here."
                  />
                ) : (
                  <div className="space-y-2 max-h-[60dvh] overflow-y-auto">
                    {historySessions.map((sess) => {
                      const isActive = selectedSessionId === sess.sessionId;
                      const followbackPercent = sess.totalActions > 0
                        ? Math.round((sess.followedBack / sess.totalActions) * 100)
                        : 0;

                      return (
                        // A real button with `aria-pressed`, not a
                        // `SelectableRow`: picking a session is single-select
                        // navigation, so a checkbox would state the wrong
                        // thing. Native Enter/Space replaces the hand-rolled
                        // keydown handler.
                        <button
                          key={sess.sessionId}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => {
                            setSelectedSessionId(sess.sessionId);
                            setSelectedHistoryActions(new Set());
                          }}
                          className={`block w-full min-h-11 p-3 rounded-xl border-2 transition-all text-left ${
                            isActive
                              ? "bg-primary/5 border-primary/30"
                              : "bg-secondary/20 border-transparent hover:border-border"
                          }`}
                        >
                          <span className="block font-bold text-xs text-foreground line-clamp-1">{sess.label}</span>
                          <span className="block text-xs text-muted-foreground mt-1">
                            {new Date(sess.date).toLocaleDateString()}
                          </span>

                          <span className="flex justify-between items-center text-xs mt-2.5 pt-2 border-t border-border/40 text-muted-foreground">
                            <span>{sess.totalActions} actions</span>
                            <span className="font-semibold text-primary-text">
                              {followbackPercent}% followback
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>

            {/* Right content: Actions list in session */}
            <div className="lg:col-span-2">
              <Card className="p-6">
                {!selectedSessionId ? (
                  <EmptyState
                    icon={<ChevronRight className="w-12 h-12" />}
                    title="Select a session"
                    description="Select a discovery campaign session from the list to manage its followers and track history."
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-4 mb-4">
                      <div>
                        <h2 className="text-md font-bold text-foreground">{selectedSession?.label}</h2>
                        <div className="text-xs text-muted-foreground flex gap-3 mt-1 flex-wrap">
                          <span>Followed back: {selectedSession?.followedBack}</span>
                          <span>•</span>
                          <span>Pending check: {selectedSession?.unchecked}</span>
                          <span>•</span>
                          <span>Reversed: {selectedSession?.reversed}</span>
                        </div>
                      </div>

                      <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:flex sm:flex-wrap sm:items-center">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => exportSessionCsv(selectedSession?.label || "session", sessionActions)}
                          disabled={sessionActions.length === 0}
                          className="gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          Export CSV
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => checkFollowbacksMutation.mutate(selectedSessionId)}
                          disabled={checkingFollowbacks}
                          className="gap-1.5"
                        >
                          {checkingFollowbacks ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          Check Followbacks
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            // Select only follow actions that haven't followed back and aren't reversed
                            const targets = sessionActions
                              .filter(a => a.actionType === 'follow' && a.followedBack === false && !a.reversed)
                              .map(a => a.id);
                            if (targets.length === 0) {
                              setNotice({ type: "info", text: "No non-reciprocating users to unfollow." });
                              return;
                            }
                            setSelectedHistoryActions(new Set(targets));
                            setShowReverseConfirm(true);
                          }}
                          className="text-destructive-text hover:bg-destructive/10 border-red-200 hover:border-red-300 gap-1.5 bg-red-50/50 dark:bg-red-950/20"
                        >
                          Unfollow Non-Followbacks
                        </Button>
                      </div>
                    </div>

                    <div className="flex justify-between items-center gap-3 mb-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => selectAllHistoryActions(sessionActions)}
                        className="text-primary-text"
                      >
                        {selectedHistoryActions.size === sessionActions.length ? "Deselect All" : "Select All"}
                      </Button>
                      <span className="text-xs text-muted-foreground" role="status">
                        {sessionActions.length} actions in session
                      </span>
                    </div>

                    {/* Action Cards */}
                    <ProgressiveBlur
                      className="grid sm:grid-cols-2 gap-3 max-h-[60dvh] overflow-y-auto"
                      active={sessionActions.length > 6}
                      fadeHeight={72}
                    >
                      {sessionActions.map((act) => (
                        <SelectableRow
                          key={act.id}
                          as="div"
                          id={act.id}
                          selected={selectedHistoryActions.has(act.id)}
                          onToggle={() => toggleHistoryAction(act.id)}
                          label={act.targetName || "Action"}
                        >
                          <span className="flex items-center gap-3">
                            <img
                              src={act.targetAvatar || "/brand/icon-192.png"}
                              alt=""
                              width={40}
                              height={40}
                              loading="lazy"
                              decoding="async"
                              className={`w-10 h-10 object-cover shrink-0 ${act.actionType === 'follow' ? 'rounded-full' : 'rounded-lg'}`}
                            />

                            <span className="min-w-0 flex-1">
                              <span className="block font-semibold text-xs text-foreground truncate">{act.targetName}</span>
                              <span className="text-xs text-muted-foreground flex gap-1.5 mt-0.5 flex-wrap items-center">
                                <span className="font-semibold uppercase tracking-wider text-xs bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">
                                  {act.actionType}
                                </span>

                                {act.reversed ? (
                                  <span className="text-warning-text font-semibold flex items-center gap-0.5">
                                    <Undo2 className="w-3 h-3" aria-hidden="true" /> Reversed
                                  </span>
                                ) : act.actionType === 'follow' && (
                                  <>
                                    {act.followedBack === true && (
                                      <span className="text-xs text-success-text font-bold">
                                        <span aria-hidden="true">✓ </span>Follows Back
                                      </span>
                                    )}
                                    {act.followedBack === false && (
                                      <span className="text-xs text-destructive-text font-semibold">
                                        <span aria-hidden="true">✗ </span>No Followback
                                      </span>
                                    )}
                                    {act.followedBack === null && (
                                      <span className="text-xs text-muted-foreground">
                                        <span aria-hidden="true">⏳ </span>Unchecked
                                      </span>
                                    )}
                                  </>
                                )}
                              </span>
                            </span>
                          </span>
                        </SelectableRow>
                      ))}
                    </ProgressiveBlur>
                  </>
                )}
              </Card>
            </div>
          </div>

          {/* Bottom history selection banner */}
          <SelectionBanner
            count={selectedHistoryActions.size}
            entityName="action"
            actionLabel={reversing ? "Undoing..." : "Undo/Reverse Selected"}
            onAction={() => setShowReverseConfirm(true)}
            disabled={reversing}
            actionVariant="destructive"
            actionIcon={reversing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
          />

          {/* Reversal Confirmation Modal */}
          <ConfirmDialog
            open={showReverseConfirm}
            title="Reverse selected actions?"
            description={`This will unfollow the selected users and/or unlike the selected tracks. This takes a few seconds.`}
            confirmLabel="Confirm Undo"
            variant="destructive"
            onConfirm={() => reverseMutation.mutate({ actionIds: Array.from(selectedHistoryActions) })}
            onCancel={() => setShowReverseConfirm(false)}
          >
            <BulkReviewDetails
              action="reversing"
              warning="Unfollows user profiles and unlikes tracks. It will update database history log."
              items={sessionActions
                .filter(a => selectedHistoryActions.has(a.id))
                .map(a => ({
                  id: a.id,
                  label: a.targetName || 'Action',
                  meta: `${a.actionType.toUpperCase()} action`,
                }))}
            />
          </ConfirmDialog>
        </div>
      )}

      {/* Analytics Tab */}
      {activeTab === "analytics" && (
        <div
          role="tabpanel"
          id="growth-panel-analytics"
          aria-labelledby="growth-tab-analytics"
        >
          {statsData && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Followed</span>
                <span className="text-2xl font-bold mt-1 text-foreground">{statsData.totalFollowed}</span>
              </Card>
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Followback Rate</span>
                <span className="text-2xl font-bold mt-1 text-primary">{Math.round(statsData.followedBackRate * 100)}%</span>
              </Card>
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Active Follows</span>
                <span className="text-2xl font-bold mt-1 text-foreground">{statsData.activeFollows}</span>
              </Card>
              <Card className="p-4 flex flex-col justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pending Check</span>
                <span className="text-2xl font-bold mt-1 text-foreground">{statsData.uncheckedFollows}</span>
              </Card>
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Per-seed conversion */}
            <Card className="p-6">
              <h2 className="text-sm font-bold text-foreground mb-1">Which seeds convert best</h2>
              <p className="text-xs text-muted-foreground mb-4">
                Follow-back rate of people discovered from each inspiration artist. Seed your next campaign from the winners.
              </p>
              {analyticsPerSeed.length === 0 ? (
                <EmptyState
                  icon={<BarChart3 className="w-10 h-10" />}
                  title="Not enough data yet"
                  description="Run a campaign and check follow-backs to see which seeds convert."
                />
              ) : (
                <div className="space-y-3">
                  {analyticsPerSeed.slice(0, 12).map((seed) => (
                    <div key={seed.seedId} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-foreground truncate">{seed.name}</div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${seed.rate === null ? 0 : Math.round(seed.rate * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="w-24 text-right text-xs text-muted-foreground shrink-0">
                        {seed.rate === null ? (
                          <span>{seed.follows} follows</span>
                        ) : (
                          <span className="font-semibold text-foreground">
                            {Math.round(seed.rate * 100)}%
                          </span>
                        )}
                        <span className="ml-1">({seed.checked}/{seed.follows})</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Follow-back timing */}
            <Card className="p-6">
              <h2 className="text-sm font-bold text-foreground mb-1">When people follow back</h2>
              <p className="text-xs text-muted-foreground mb-4">
                How long after a follow reciprocation was confirmed — helps you time your follow-back checks.
              </p>
              {analyticsCurve.every((b) => b.followedBack + b.notFollowedBack === 0) ? (
                <EmptyState
                  icon={<Clock className="w-10 h-10" />}
                  title="No confirmed follow-backs yet"
                  description="Check follow-backs on a campaign to populate this."
                />
              ) : (
                <div className="space-y-4">
                  {analyticsCurve.map((b) => {
                    const total = b.followedBack + b.notFollowedBack;
                    const pct = total > 0 ? Math.round((b.followedBack / total) * 100) : 0;
                    return (
                      <div key={b.bucket}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-foreground font-medium">{b.bucket}</span>
                          <span className="text-muted-foreground">{b.followedBack} back / {total} checked</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                          <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* Risk interstitial (shown once, before first engagement) */}
      <ConfirmDialog
        open={showRiskModal}
        title="Before you follow in bulk"
        description="Bulk following is against SoundCloud's terms if overdone, and aggressive activity can get accounts flagged or limited."
        confirmLabel={`Follow ${selectedSuggestions.size} — I understand`}
        cancelLabel="Not now"
        variant="destructive"
        onConfirm={acknowledgeRiskAndEngage}
        onCancel={() => setShowRiskModal(false)}
      >
        <ul className="space-y-2 text-xs text-muted-foreground">
          <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />We cap follows at {budget?.dailyCap ?? 50} per day and pace them automatically.</li>
          <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />Everything is logged so you can undo any campaign from the History tab.</li>
          <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />Following real artists in your scene is fine; mass follow/unfollow churn is what gets flagged.</li>
        </ul>
      </ConfirmDialog>
    </PageContainer>
  );
}
