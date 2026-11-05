import { useId } from "react";
import { cn } from "@/lib/utils";

interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** The panel's heading. Omit for a panel that is only a surface. */
  title?: React.ReactNode;
  /** `h2` under the page's `h1`; `h3` for a panel nested inside a section. */
  headingLevel?: "h2" | "h3";
  description?: React.ReactNode;
  /** Controls on the heading row (Select all, a count, a refresh button). */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * A section of a tool page: the card surface with the page's one padding
 * (16px on a phone, 24px from `sm`), an optional heading row, and 16px
 * between that row and the body. Replaces the per-page mix of `p-4`, `p-6`,
 * `p-8`, `border-2` and `text-xl font-bold` headings
 * (docs/internal/DESIGN-SYSTEM.md, "Spacing scale").
 *
 * With a title it is a `<section>` labelled by that heading, so it shows up
 * in a screen reader's landmark list exactly when it has a name.
 */
export function Panel({
  title,
  headingLevel: Heading = "h2",
  description,
  actions,
  children,
  className,
  ...props
}: PanelProps) {
  const headingId = useId();
  const Tag = title ? "section" : "div";

  return (
    <Tag
      aria-labelledby={title ? headingId : undefined}
      className={cn(
        "min-w-0 rounded-xl border bg-card p-4 text-card-foreground shadow-sm sm:p-6",
        className,
      )}
      {...props}
    >
      {title || actions ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            {title ? (
              <Heading id={headingId} className="text-lg font-semibold text-foreground">
                {title}
              </Heading>
            ) : null}
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}
