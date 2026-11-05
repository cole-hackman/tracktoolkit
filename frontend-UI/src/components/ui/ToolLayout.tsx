import { cn } from "@/lib/utils";

interface ToolLayoutProps {
  /** The list being picked from. Two thirds of the width from `lg`. */
  main: React.ReactNode;
  /** The action panel: settings, the selection count and the primary button. */
  aside: React.ReactNode;
  className?: string;
}

/**
 * The "workbench" page body: a list on the left, the action panel on the
 * right, 24px apart. Below `lg` they stack, list first, so the panel follows
 * the choice it acts on.
 *
 * The aside is `self-start` and sticky from `lg`, so the primary button stays
 * in view while the list scrolls; its top offset adds `--announcement-h` so it
 * never slides under the rebrand banner. Both columns are `min-w-0`: a grid
 * item's minimum is its min-content width, and one `truncate`d title would
 * otherwise widen the column past a phone's viewport.
 */
export function ToolLayout({ main, aside, className }: ToolLayoutProps) {
  return (
    <div className={cn("grid gap-6 lg:grid-cols-3", className)}>
      <div className="min-w-0 lg:col-span-2">{main}</div>
      <div className="min-w-0 lg:sticky lg:top-[calc(var(--announcement-h)+1.5rem)] lg:self-start">
        {aside}
      </div>
    </div>
  );
}
