"use client";

import { useId } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";
import { useDialog } from "./useDialog";

export type DialogVariant = "center" | "sheet";
export type DialogSize = "sm" | "md" | "lg";

const SIZE_MAP: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

const LAYOUT_MAP: Record<DialogVariant, string> = {
  center: "flex items-center justify-center p-4",
  // A bottom sheet on a phone, the same centred card from `sm` up.
  sheet: "flex items-end justify-center sm:items-center sm:p-4",
};

export interface DialogProps {
  open: boolean;
  /** Called by Escape, the backdrop and the close button. */
  onClose: () => void;
  /** Becomes the `<h2>` the dialog is labelled by. */
  title: string;
  /** Small supporting line under the title. */
  subtitle?: React.ReactNode;
  /** Rendered as the `aria-describedby` target. */
  description?: React.ReactNode;
  /** Styles the description wrapper — for callers whose body is several paragraphs. */
  descriptionClassName?: string;
  /** Decoration beside the title (never the accessible name). */
  icon?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  variant?: DialogVariant;
  size?: DialogSize;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Label the dialog by an existing element instead of the rendered `<h2>`. */
  labelledById?: string;
  /** `false` hides the corner close button (Escape and the backdrop still close). */
  showClose?: boolean;
  /** Accessible name for the corner close button — "Close menu" on the nav sheets. */
  closeLabel?: string;
  panelClassName?: string;
}

/**
 * The one overlay primitive. Everything modal in the app renders through it
 * so focus handling, the Escape key, the scroll lock and the z-index are
 * decided once.
 *
 * `z-[70]` is deliberate: above the selection banner (z-40) and the mobile
 * header and tab bar (z-50), so a dialog is never partly covered.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  description,
  descriptionClassName,
  icon,
  children,
  footer,
  variant = "center",
  size = "md",
  initialFocusRef,
  returnFocusRef,
  labelledById,
  showClose = true,
  closeLabel = "Close",
  panelClassName,
}: DialogProps) {
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descriptionId = `${reactId}-description`;
  const { panelRef } = useDialog({ open, onClose, initialFocusRef, returnFocusRef });

  if (!open) return null;

  return (
    <div className={cn("fixed inset-0 z-[70]", LAYOUT_MAP[variant])}>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById ?? titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative border-2 border-border bg-card shadow-2xl focus:outline-none",
          "animate-in fade-in duration-200",
          variant === "center" && [
            "w-full max-h-[85dvh] overflow-y-auto rounded-2xl zoom-in-95",
            SIZE_MAP[size],
          ],
          variant === "sheet" && [
            "w-full max-h-[85dvh] overflow-y-auto rounded-t-2xl border-b-0 slide-in-from-bottom-4",
            "pb-[max(1rem,env(safe-area-inset-bottom))]",
            "sm:rounded-2xl sm:border-b-2 sm:pb-0",
            SIZE_MAP[size],
          ],
          panelClassName,
        )}
      >
        {showClose ? (
          <IconButton
            label={closeLabel}
            size="sm"
            onClick={onClose}
            className="absolute right-2 top-2 z-10"
          >
            <X className="h-4 w-4" />
          </IconButton>
        ) : null}

        <div className="space-y-5 px-6 py-6">
          <div className={cn("flex items-start gap-3", showClose && "pr-8")}>
            {icon ? <div className="shrink-0">{icon}</div> : null}
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-foreground">
                {title}
              </h2>
              {subtitle ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
              ) : null}
            </div>
          </div>

          {description ? (
            <div
              id={descriptionId}
              className={cn("text-sm text-muted-foreground", descriptionClassName)}
            >
              {description}
            </div>
          ) : null}

          {children}

          {footer}
        </div>
      </div>
    </div>
  );
}
