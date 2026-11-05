"use client";

import { useEffect, useId, useRef } from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "./Card";
import { inlineAlertVariantStyles, type InlineAlertVariant } from "./InlineAlert";
import { useAnnounce } from "./useAnnounce";

/**
 * What a run of a tool ended as. Every tool maps its outcome onto these four,
 * so the same situation looks the same on every page:
 *
 * - `success` — everything asked for was done.
 * - `partial` — some of it was done; the rest is listed with its reason.
 * - `empty`   — nothing needed doing (all already liked, no matches). Not an
 *               error, and not dressed as a success either.
 * - `error`   — nothing was done, or the request failed outright.
 */
export type ResultStatus = "success" | "partial" | "empty" | "error";

const STATUS_VARIANT: Record<ResultStatus, InlineAlertVariant> = {
  success: "success",
  partial: "warning",
  empty: "info",
  error: "error",
};

const STATUS_ICON = {
  success: CheckCircle2,
  partial: TriangleAlert,
  empty: Info,
  error: AlertCircle,
};

interface ResultPanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: string;
  description?: React.ReactNode;
  /** Content mode only (no `status`): a plain card around output such as resolved metadata. */
  tone?: "neutral" | "success";
  /**
   * Outcome mode. Set it and the panel becomes the result of the run the user
   * just started: tinted by status, focused when it appears, and announced.
   */
  status?: ResultStatus;
  /**
   * What the live region says. Defaults to the title, plus the description
   * when that is plain text. Errors are spoken assertively.
   */
  announcement?: string;
  /** Follow-up controls (open the playlist, run again), rendered in the panel footer. */
  actions?: React.ReactNode;
  /** Adds a Dismiss button to an outcome panel. */
  onDismiss?: () => void;
  children?: React.ReactNode;
}

/**
 * Two jobs, one component, because both are "the thing a tool produced":
 *
 * **Content mode** (no `status`) — a card with an optional heading around a
 * tool's output: the metadata a resolver returned, a batch's result table.
 *
 * **Outcome mode** (`status` set) — the single result pattern every tool uses
 * after a write or a run. Where it goes is part of the pattern, not the
 * component: in the page's result slot, directly under `PageHeader` and above
 * the tool itself, so the tool stays on screen to be run again
 * (docs/internal/DESIGN-SYSTEM.md, "Results"). On mount it takes focus (so
 * the keyboard and the screen-reader cursor land on what happened, the way
 * GOV.UK's notification banner does) and speaks its summary through
 * `useAnnounce`. It deliberately carries no `role="alert"`/`status` of its
 * own: the announcement already goes through the app's one live region, and
 * a second live role would read it twice.
 *
 * Render it conditionally and clear it when a new run starts, so each run
 * mounts a fresh panel — or give it a `key` per run when the result object
 * is replaced in place.
 */
export function ResultPanel({
  title,
  description,
  tone = "neutral",
  status,
  announcement,
  actions,
  onDismiss,
  children,
  className,
  ...props
}: ResultPanelProps) {
  if (status) {
    return (
      <OutcomePanel
        title={title ?? ""}
        description={description}
        status={status}
        announcement={announcement}
        actions={actions}
        onDismiss={onDismiss}
        className={className}
        {...props}
      >
        {children}
      </OutcomePanel>
    );
  }

  return (
    <Card
      className={cn(
        tone === "success" && "border-green-200 dark:border-green-900/50",
        className,
      )}
      {...(props as React.HTMLAttributes<HTMLDivElement>)}
    >
      {(title || description) && (
        <CardHeader>
          {title ? (
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          ) : null}
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </Card>
  );
}

interface OutcomePanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: string;
  description?: React.ReactNode;
  status: ResultStatus;
  announcement?: string;
  actions?: React.ReactNode;
  onDismiss?: () => void;
  children?: React.ReactNode;
}

function OutcomePanel({
  title,
  description,
  status,
  announcement,
  actions,
  onDismiss,
  children,
  className,
  ...props
}: OutcomePanelProps) {
  const announce = useAnnounce();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const Icon = STATUS_ICON[status];

  const spoken =
    announcement ??
    (typeof description === "string" && description ? `${title}. ${description}` : title);

  // Mount-only on purpose: a re-render of the same result (a parent state
  // change) must not steal focus back or repeat itself. A new run is a new
  // mount — see the component comment.
  useEffect(() => {
    // Focusing scrolls it into view when it is off screen (the user pressed a
    // button in a long list or a bottom bar); `scroll-mt-24` keeps it clear
    // of the fixed mobile header.
    ref.current?.focus();
    announce(spoken, { assertive: status === "error" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-result-status={status}
      className={cn(
        "scroll-mt-24 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex items-start gap-3 border-0 px-4 py-4 sm:px-5",
          inlineAlertVariantStyles[STATUS_VARIANT[status]],
        )}
      >
        <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description ? <div className="mt-1 text-sm">{description}</div> : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="touch-44 -m-1 shrink-0 rounded p-1 transition hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Dismiss result"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {children ? (
        <div className="space-y-4 border-t border-border/60 px-4 py-4 text-sm text-foreground sm:px-5">
          {children}
        </div>
      ) : null}
      {actions ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-3 sm:px-5">
          {actions}
        </div>
      ) : null}
    </section>
  );
}
