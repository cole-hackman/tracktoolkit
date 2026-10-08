"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button, Card, ProgressBar, useAnnounce } from "@/components/ui";
import {
  EMPTY_PROGRESS,
  type GateMark,
  type GateProgress,
  clearSkips,
  gateCounts,
  loadGateProgress,
  markGate,
  nextGate,
  saveGateProgress,
  undoLast,
} from "@/lib/gate-progress";

export interface WalkthroughGate {
  id: number;
  title: string;
  artist: string;
  /** "Hypeddit", "Droploud", … */
  site: string;
  href: string;
  artworkUrl?: string | null;
}

/**
 * Free-download gates, one at a time, completed by hand. This only opens the
 * gate in a new tab and remembers what you marked; every follow, like or
 * email on the gate is yours to do there.
 */
export function GateWalkthrough({ gates, onClose }: { gates: WalkthroughGate[]; onClose: () => void }) {
  const announce = useAnnounce();
  // Read after mount: the export is static HTML, and storage can throw.
  const [progress, setProgress] = useState<GateProgress>(EMPTY_PROGRESS);
  const [hydrated, setHydrated] = useState(false);
  const [openedId, setOpenedId] = useState<number | null>(null);

  useEffect(() => {
    setProgress(loadGateProgress());
    setHydrated(true);
  }, []);

  const update = (next: GateProgress) => {
    setProgress(next);
    saveGateProgress(next);
  };

  const current = useMemo(() => nextGate(gates, progress), [gates, progress]);
  const counts = useMemo(() => gateCounts(gates, progress), [gates, progress]);
  const byId = useMemo(() => new Map(gates.map((g) => [g.id, g])), [gates]);

  const open = (gate: WalkthroughGate) => {
    window.open(gate.href, "_blank", "noopener,noreferrer");
    setOpenedId(gate.id);
  };

  const mark = (gate: WalkthroughGate, how: GateMark) => {
    const next = markGate(progress, gate.id, how);
    update(next);
    setOpenedId(null);
    const following = nextGate(gates, next);
    announce(
      `${gate.title}: ${how === "done" ? "done" : "skipped"}. ` +
        (following ? `Next: ${following.title}.` : "That was the last one."),
    );
  };

  const undo = () => {
    const { progress: next, trackId } = undoLast(progress);
    if (trackId == null) return;
    update(next);
    announce(`Back to ${byId.get(trackId)?.title ?? "the previous gate"}.`);
  };

  const canUndo = progress.history.some((id) => byId.has(Number(id)));

  return (
    // A section, not the Card: a name on a plain div is prohibited ARIA.
    <section aria-labelledby="gate-walkthrough-title">
    <Card className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="gate-walkthrough-title" className="text-lg font-bold text-foreground">
            Work through gates
          </h3>
          <p className="text-sm text-muted-foreground">
            Each gate opens in a new tab. Complete it there, then come back and mark it. Progress is saved in this
            browser.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <ProgressBar
        value={counts.done + counts.skipped}
        max={counts.total}
        label="Gates worked through"
        detail={`${counts.done.toLocaleString()} done · ${counts.skipped.toLocaleString()} skipped`}
      />

      {!hydrated ? null : current ? (
        <div className="space-y-3 rounded-xl bg-secondary/20 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src={current.artworkUrl || "/brand/icon-192.png"}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 shrink-0 rounded-md object-cover"
            />
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground">{current.title}</p>
              <p className="truncate text-sm text-muted-foreground">
                {current.artist} · {current.site} gate
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => open(current)} variant={openedId === current.id ? "secondary" : "default"}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              {openedId === current.id ? `Open ${current.site} gate again` : `Open ${current.site} gate`}
            </Button>
            <Button onClick={() => mark(current, "done")} variant={openedId === current.id ? "default" : "secondary"}>
              Done — next
            </Button>
            <Button onClick={() => mark(current, "skipped")} variant="secondary">
              Skip
            </Button>
            <Button onClick={undo} variant="ghost" disabled={!canUndo}>
              Undo
            </Button>
          </div>
        </div>
      ) : counts.skipped > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            Every gate is marked. {counts.skipped.toLocaleString()} skipped.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                update(clearSkips(progress, gates.map((g) => g.id)));
                announce("Skipped gates are back in line.");
              }}
            >
              Go through the skipped ones again
            </Button>
            <Button onClick={undo} variant="ghost" disabled={!canUndo}>
              Undo
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-foreground">All {counts.total.toLocaleString()} gates done.</p>
          <Button onClick={undo} variant="ghost" disabled={!canUndo}>
            Undo
          </Button>
        </div>
      )}
    </Card>
    </section>
  );
}
