"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

/**
 * A visible `label`, an `aria-label`, or the marker `Field` passes — never none
 * of them. The union makes
 * omitting both a type error, so a select can't ship without an accessible name.
 */
type SelectNaming =
  | { label: string; "aria-label"?: undefined }
  | { label?: undefined; "aria-label": string }
  // Labelled from outside: only `Field` supplies this marker (via `{...field}`),
  // so a standalone `<Select id="x">` with no name is still a type error.
  | { label?: undefined; "aria-label"?: undefined; "data-field-labelled": true };

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & SelectNaming;

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, id, children, ...props }, ref) => {
    const generatedId = React.useId();
    const selectId = id ?? generatedId;

    const select = (
      <select
        ref={ref}
        id={selectId}
        className={cn(
          "h-11 w-full rounded-md border border-input bg-surface px-3 text-base text-foreground shadow-sm sm:text-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "dark:bg-white/5",
          "transition-colors duration-150",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );

    if (!label) return select;

    return (
      <div className="grid gap-1.5">
        <label htmlFor={selectId} className="text-sm font-semibold text-foreground">
          {label}
        </label>
        {select}
      </div>
    );
  },
);
Select.displayName = "Select";

export { Select };
