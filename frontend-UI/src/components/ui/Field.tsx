"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

export interface FieldRenderProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": "true" | undefined;
  "aria-required": "true" | undefined;
  /** Marker `Select` requires when it takes its name from this Field's label. */
  "data-field-labelled": true;
}

export interface FieldProps {
  label: string;
  /**
   * Render the label `sr-only` instead of visibly.
   *
   * For a control whose purpose is already obvious from what surrounds it —
   * the search box in a toolbar above the list it filters — where a visible
   * label would only repeat the placeholder. It is still a real `<label>`
   * tied to the control by `htmlFor`, which is what an `aria-label` on the
   * input is not: the label text stays in the accessibility tree, the click
   * target still includes it, and the hint/error wiring is unchanged.
   */
  labelHidden?: boolean;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Supply one to keep it stable across renders; otherwise `useId` provides it. */
  id?: string;
  className?: string;
  children: (props: FieldRenderProps) => React.ReactNode;
}

/**
 * Label + hint + error wrapper for a single form control.
 *
 * The child is a render prop rather than a plain node so `Field` can wire the
 * id and the aria-* attributes onto whatever control it wraps — `Input`,
 * `Select`, a `<textarea>` or a bare `<input>`:
 *
 * ```tsx
 * <Field label="Playlist name" hint="Shown on SoundCloud" error={nameError} required>
 *   {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
 * </Field>
 * ```
 *
 * `aria-describedby` points at the hint, the error, or both in that order.
 */
export function Field({
  label,
  labelHidden = false,
  hint,
  error,
  required = false,
  id,
  className,
  children,
}: FieldProps) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("grid gap-1.5", className)}>
      <label
        htmlFor={fieldId}
        className={cn(
          labelHidden ? "sr-only" : "text-sm font-semibold text-foreground",
        )}
      >
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>

      {children({
        id: fieldId,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? "true" : undefined,
        "aria-required": required ? "true" : undefined,
        "data-field-labelled": true,
      })}

      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}
