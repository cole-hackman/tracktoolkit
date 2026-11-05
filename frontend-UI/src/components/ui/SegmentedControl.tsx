"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

interface SegmentedControlProps<V extends string> {
  /** Visible label above the control; also its group name. */
  label: string;
  value: V;
  options: readonly SegmentedOption<V>[];
  onChange: (value: V) => void;
  className?: string;
}

/**
 * Two or three mutually exclusive modes ("New playlist" / "Existing
 * playlist"). A labelled group of `aria-pressed` buttons, each at least
 * 44px tall, the pressed one in the primary fill. This is the toggle the
 * workbench pages each wrote out by hand.
 */
export function SegmentedControl<V extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<V>) {
  const labelId = useId();
  return (
    <div className={cn("grid gap-1.5", className)}>
      <span id={labelId} className="text-sm font-semibold text-foreground">
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex overflow-hidden rounded-lg border border-border"
      >
        {options.map((option) => {
          const pressed = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => onChange(option.value)}
              className={cn(
                "min-h-11 flex-1 px-2 text-sm font-medium transition",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/80",
                pressed
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
