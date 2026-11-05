"use client";

import { useId, useRef, useState } from "react";
import { Button, Dialog, LoadingSpinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  PlaylistPicker,
  type PickerPlaylist,
  type PlaylistDisabledReasons,
} from "./PlaylistPicker";

export interface PlaylistChooserProps<P extends PickerPlaylist> {
  /** Visible label above the trigger ("Target playlist"). */
  label: string;
  playlists: readonly P[];
  value: P | null;
  onChange: (playlist: P) => void;
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  /** Playlists that cannot be the choice right now, with the reason shown on the row. */
  disabledReasons?: PlaylistDisabledReasons;
  /** Trigger text with nothing chosen. */
  placeholder?: string;
  /** Title of the dialog. Defaults to `label`. */
  dialogTitle?: string;
  /** Shown instead of the trigger when every playlist is unavailable. */
  unavailableText?: string;
  className?: string;
}

/**
 * Choosing one playlist from inside a narrow panel (a merge target, the
 * playlist to add tracks to): a trigger that shows the current choice, and a
 * dialog — a bottom sheet on a phone — holding the same `PlaylistPicker` the
 * rest of the app uses, in `single` mode.
 *
 * Choosing a row (click, tap, Enter or Space) closes the dialog and returns
 * focus to the trigger; Tab moves between rows without choosing. Done or
 * Escape closes it unchanged.
 */
export function PlaylistChooser<P extends PickerPlaylist>({
  label,
  playlists,
  value,
  onChange,
  loading = false,
  loadError = false,
  onRetry,
  disabledReasons,
  placeholder = "Choose a playlist…",
  dialogTitle,
  unavailableText,
  className,
}: PlaylistChooserProps<P>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const valueId = useId();
  const changeId = useId();

  const available = playlists.filter((p) => !disabledReasons?.has(Number(p.id)));

  return (
    // `min-w-0` on the grid and its children: a grid column's minimum is its
    // content's, and one long playlist title in the trigger otherwise widened
    // the page past a phone's viewport (1022px at 390 on compare).
    <div className={cn("grid min-w-0 gap-1.5 [&>*]:min-w-0", className)}>
      <span id={labelId} className="text-sm font-semibold text-foreground">
        {label}
      </span>

      {loading ? (
        <div className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
          <LoadingSpinner size="sm" />
          Loading playlists…
        </div>
      ) : !loadError && unavailableText && playlists.length > 0 && available.length === 0 ? (
        <p className="rounded-lg border-2 border-dashed border-border py-3 text-center text-sm text-muted-foreground">
          {unavailableText}
        </p>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-labelledby={value ? `${labelId} ${valueId} ${changeId}` : `${labelId} ${valueId}`}
          onClick={() => setOpen(true)}
          className={cn(
            "flex min-h-11 w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            value
              ? "border-primary bg-primary/10 hover:bg-primary/15"
              : "border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary-text",
          )}
        >
          {value ? (
            <>
              <img
                src={value.coverUrl || value.artwork_url || "/brand/icon-192.png"}
                alt=""
                width={40}
                height={40}
                loading="lazy"
                decoding="async"
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
              />
              <span id={valueId} className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{value.title}</span>
                {typeof value.track_count === "number" ? (
                  <span className="block text-xs text-muted-foreground">{value.track_count} tracks</span>
                ) : null}
              </span>
              <span id={changeId} className="shrink-0 text-xs font-medium text-primary-text">
                Change
              </span>
            </>
          ) : (
            <span id={valueId} className="w-full text-center text-sm">
              {placeholder}
            </span>
          )}
        </button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={dialogTitle ?? label}
        variant="sheet"
        size="md"
        returnFocusRef={triggerRef}
        footer={
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        <PlaylistPicker
          playlists={playlists}
          mode="single"
          selectedIds={value ? [Number(value.id)] : []}
          onChange={(next) => {
            const chosen = next[0];
            if (!chosen) return;
            onChange(chosen);
            setOpen(false);
          }}
          onReselect={() => setOpen(false)}
          loadError={loadError}
          onRetry={onRetry}
          disabledReasons={disabledReasons}
          listClassName="max-h-[50dvh]"
        />
      </Dialog>
    </div>
  );
}
