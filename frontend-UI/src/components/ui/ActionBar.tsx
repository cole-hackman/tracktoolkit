import { cn } from "@/lib/utils";

interface ActionBarProps {
  children: React.ReactNode;
  /**
   * `start` (default): buttons left-aligned with the fields above them, the
   * primary one first. `stretch`: full-width buttons, stacked — the action
   * panel of a workbench, where the column is ~350px.
   */
  layout?: "start" | "stretch";
  className?: string;
}

/**
 * The row of buttons that ends a form or an action panel: 24px above it,
 * 12px between buttons, primary first (docs/internal/DESIGN-SYSTEM.md,
 * "Action bars").
 */
export function ActionBar({ children, layout = "start", className }: ActionBarProps) {
  return (
    <div
      className={cn(
        "mt-6 flex gap-3",
        layout === "start" ? "flex-wrap items-center" : "flex-col [&>*]:w-full",
        className,
      )}
    >
      {children}
    </div>
  );
}
