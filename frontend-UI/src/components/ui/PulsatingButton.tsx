"use client";

import { cn } from "@/lib/utils";

interface PulsatingButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  /** Color of the pulse ring. Defaults to SC orange. */
  pulseColor?: string;
  /** Duration of one pulse cycle. Default 1.5s */
  duration?: string;
}

/**
 * A button with an expanding ring pulse animation.
 * Ideal for destructive or high-stakes CTAs (unlike, unfollow, remove).
 */
export function PulsatingButton({
  children,
  className,
  pulseColor = "#FF5500",
  duration = "1.5s",
  ...props
}: PulsatingButtonProps) {
  return (
    <button
      {...props}
      style={
        {
          "--pulse-color": pulseColor,
          "--duration": duration,
        } as React.CSSProperties
      }
      className={cn(
        // Base button styles — the destructive tokens `Button variant=
        // "destructive"` uses. It was raw `bg-red-500 text-white` (3.76:1,
        // under AA for 14px text); `--destructive` is set dark enough that
        // its foreground clears 4.5:1 and is in `npm run contrast`.
        "relative inline-flex cursor-pointer items-center justify-center rounded-lg",
        "bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground shadow-sm",
        "transition-all hover:bg-destructive/90 hover:-translate-y-0.5 hover:shadow-md",
        "disabled:pointer-events-none disabled:opacity-50",
        // Pulse ring
        "before:absolute before:inset-0 before:rounded-lg",
        "before:animate-[pulse-ring_var(--duration)_ease-out_infinite]",
        "before:border-2 before:border-[var(--pulse-color)]",
        "before:opacity-0",
        className
      )}
    >
      <span className="relative z-10">{children}</span>
    </button>
  );
}
