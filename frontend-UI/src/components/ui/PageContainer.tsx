import { cn } from "@/lib/utils";

const WIDTH_MAP = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-6xl",
} as const;

/**
 * The page types of docs/internal/DESIGN-SYSTEM.md ("Page structure"), each
 * with its one width. Pick the type; never pick a width.
 *
 * - `form`      — one column of inputs and then their output (resolver,
 *                 cloner, set → playlist, export, account). 896px keeps a
 *                 full-width text input and its help text near the 50–75
 *                 character measure instead of a 1,100px line.
 * - `list`      — one list or table with a toolbar above it (like manager,
 *                 keyword search, audit, compare, genre search, downloads).
 *                 1024px: room for title, meta and a right-hand control on one
 *                 row without the checkbox and the control drifting apart.
 * - `workbench` — a list to pick from beside a sticky action panel
 *                 (`ToolLayout`): combine, likes → playlist and the other
 *                 "pick, then act" tools. 1152px so the list column keeps
 *                 ~700px next to a ~350px panel.
 * - `hub`       — the dashboard: a grid of cards. Same width as `list`.
 */
export type PageKind = "form" | "list" | "workbench" | "hub";

const KIND_WIDTH: Record<PageKind, keyof typeof WIDTH_MAP> = {
  form: "narrow",
  list: "default",
  workbench: "wide",
  hub: "default",
};

interface PageContainerProps {
  children: React.ReactNode;
  /** The page type, which decides the width. */
  kind?: PageKind;
  /**
   * The raw width, kept for pages outside the `(app)` tool set. Tool pages
   * use `kind`; when both are given `kind` wins.
   */
  maxWidth?: keyof typeof WIDTH_MAP;
  className?: string;
}

/**
 * Shared page wrapper: horizontal centring, the width for the page type, and
 * the page gutters (16px on a phone, 24px from `sm`). Background and
 * min-height are AppShell's.
 *
 * The bottom padding clears the home indicator on a notched phone. Pages
 * with a selection banner override it with `pb-28`; `cn` is tailwind-merge,
 * so the later class wins.
 */
export function PageContainer({
  children,
  kind,
  maxWidth = "wide",
  className,
}: PageContainerProps) {
  const width = kind ? KIND_WIDTH[kind] : maxWidth;
  return (
    <div
      className={cn(
        "mx-auto px-4 sm:px-6 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]",
        WIDTH_MAP[width],
        className,
      )}
      data-page-kind={kind}
    >
      {children}
    </div>
  );
}
