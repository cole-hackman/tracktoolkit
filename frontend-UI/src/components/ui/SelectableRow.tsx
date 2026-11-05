"use client";

import { useId, useRef } from "react";
import { cn } from "@/lib/utils";

interface SelectableRowProps {
  id: string | number;
  selected: boolean;
  /**
   * The originating click is forwarded when there is one, so callers that
   * implement shift-click range selection keep working. A keyboard toggle
   * still fires a click, with `shiftKey` false.
   */
  onToggle: (event?: React.MouseEvent | React.KeyboardEvent) => void;
  /** Accessible name of the checkbox — what a screen reader reads for the row. */
  label: string;
  children: React.ReactNode;
  /** Controls for the row. Rendered outside the toggle label, never inside it. */
  rightSlot?: React.ReactNode;
  disabled?: boolean;
  /** `li` inside a `SelectableList`; `div` where the parent is not a list. */
  as?: "li" | "div";
  className?: string;
}

/**
 * One selectable row with a real `<input type="checkbox">`.
 *
 * The checkbox is the state — selection is never communicated by colour
 * alone, and the keyboard contract is the platform's rather than a hand-
 * written one: Space toggles the box, and Enter does not, because that is
 * what a native `<input type="checkbox">` does. The hand-rolled rows this
 * replaced were `div`s wearing `role="button"` and did handle Enter; losing
 * it is the point of using a real control, and it is not a 2.1.1 failure —
 * the row is still fully operable from the keyboard.
 *
 * The 24px box sits inside a `<label>` that also wraps the row content, so
 * the whole ≥64px row is one target on a phone without inflating the box
 * itself. `rightSlot` is deliberately a sibling of that label: nesting a
 * button inside a label makes it both a control and part of another
 * control's target, which is the "nested interactive" failure.
 */
export function SelectableRow({
  id,
  selected,
  onToggle,
  label,
  children,
  rightSlot,
  disabled = false,
  as: Tag = "li",
  className,
}: SelectableRowProps) {
  const reactId = useId();
  const inputId = `selectable-${reactId}-${id}`;

  // Shift-click range selection needs the modifier state, and the toggle
  // itself cannot supply it: clicking the label makes the browser synthesize
  // a click on the checkbox, and that synthetic event arrives with no
  // modifiers. `mousedown` is the last genuine user event before it, so that
  // is what gets remembered and handed to `onToggle`.
  //
  // It lives on the label, not the row, so pressing a button in `rightSlot`
  // never leaves a stale modifier behind, and a keydown clears it so a
  // keyboard toggle after an abandoned drag is never treated as shift-held.
  const pointerEventRef = useRef<React.MouseEvent | null>(null);

  return (
    <Tag
      className={cn(
        // `min-w-0` on the root, not only on the content inside it: every
        // consumer stacks these in a grid (`SelectableList`, and the
        // hand-rolled grids in following-manager and growth), and a grid
        // item's automatic minimum size is its min-content width. Without it
        // one `whitespace-nowrap` subtitle sizes the whole column to itself
        // and pushes the page wider than the viewport — which is a phone-only
        // failure that clips the row's own right-hand controls off-screen.
        "min-w-0",
        "flex min-h-16 items-center gap-3 rounded-xl border px-3 transition-colors",
        selected
          ? "border-primary bg-primary/10"
          : "border-transparent bg-gray-50 hover:border-gray-200 dark:bg-secondary/20 dark:hover:border-border",
        disabled && "opacity-60",
        className,
      )}
    >
      {/* The `onMouseDown` records modifier state for shift-click range
          selection and nothing else — the row's actual control is the real
          `<input type="checkbox">` this label is bound to, which carries the
          keyboard path (`onKeyDown` clears the remembered modifier, `onChange`
          toggles). `jsx-a11y/no-noninteractive-element-interactions` treats a
          `<label>` as non-interactive and cannot see the association, so the
          exemption is stated here rather than by leaving the rule at "warn". */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <label
        htmlFor={inputId}
        onMouseDown={(event) => {
          pointerEventRef.current = event;
        }}
        className={cn(
          // `select-none` is load-bearing, not cosmetic: a shift-click on the
          // row text would otherwise extend a text selection, and Chromium
          // then skips forwarding the click to the checkbox — silently
          // breaking shift-click range selection on the row body.
          "flex min-h-16 min-w-0 flex-1 select-none items-center gap-3 py-2",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <input
          type="checkbox"
          id={inputId}
          checked={selected}
          disabled={disabled}
          aria-label={label}
          onKeyDown={() => {
            pointerEventRef.current = null;
          }}
          onChange={() => {
            const event = pointerEventRef.current;
            pointerEventRef.current = null;
            onToggle(event ?? undefined);
          }}
          className="h-6 w-6 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
        />
        <span className="min-w-0 flex-1">{children}</span>
      </label>

      {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
    </Tag>
  );
}
