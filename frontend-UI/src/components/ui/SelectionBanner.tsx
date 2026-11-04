"use client";

import { Button } from "./Button";
import { PulsatingButton } from "./PulsatingButton";

interface SelectionBannerProps {
  count: number;
  actionLabel: string;
  onAction: () => void;
  actionVariant?: "default" | "destructive";
  disabled?: boolean;
  actionIcon?: React.ReactNode;
  entityName?: string;
  label?: React.ReactNode;
}

export function SelectionBanner({
  count,
  actionLabel,
  onAction,
  actionVariant = "default",
  disabled = false,
  actionIcon,
  entityName = "track",
  label,
}: SelectionBannerProps) {
  if (count <= 0) return null;

  const selectedLabel =
    label ?? `${count} ${entityName}${count === 1 ? "" : "s"} selected`;

  return (
    <div className="fixed inset-x-0 bottom-[var(--mobile-nav-h)] z-40 border-t border-border/60 bg-white/95 backdrop-blur dark:bg-background/95">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {/* The count is the only feedback a selection gives, so it is spoken. */}
        <span role="status" aria-live="polite" className="text-sm font-semibold text-primary-text">
          {selectedLabel}
        </span>
        {actionVariant === "destructive" ? (
          <PulsatingButton
            onClick={onAction}
            disabled={disabled}
            pulseColor="#ef4444"
            // PulsatingButton has no size scale of its own; h-11 matches the
            // Button default and clears the 44px target floor.
            className="h-11 gap-2"
          >
            {actionIcon}
            {actionLabel}
          </PulsatingButton>
        ) : (
          <Button nowrap
            variant={actionVariant}
            onClick={onAction}
            disabled={disabled}
          >
            {actionIcon}
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
