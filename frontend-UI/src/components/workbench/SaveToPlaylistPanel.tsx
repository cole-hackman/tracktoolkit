"use client";

import { SquarePlus } from "lucide-react";
import {
  ActionBar,
  Button,
  Field,
  Input,
  LoadingSpinner,
  Panel,
  SegmentedControl,
} from "@/components/ui";
import { PlaylistChooser } from "@/components/playlists/PlaylistChooser";
import type { PickerPlaylist } from "@/components/playlists/PlaylistPicker";

export type SaveMode = "new" | "existing";

const SAVE_MODES = [
  { value: "new", label: "New Playlist" },
  { value: "existing", label: "Existing" },
] as const;

interface SaveToPlaylistPanelProps<P extends PickerPlaylist> {
  selectedCount: number;
  mode: SaveMode;
  onModeChange: (mode: SaveMode) => void;
  name: string;
  onNameChange: (name: string) => void;
  namePlaceholder: string;
  playlists: readonly P[];
  playlistsLoading: boolean;
  playlistsError: boolean;
  onRetryPlaylists: () => void;
  target: P | null;
  onTargetChange: (playlist: P) => void;
  saving: boolean;
  onSave: () => void;
}

/**
 * The action panel of the two "pick tracks from a feed, save them to a
 * playlist" tools (Activity → Playlist, Recently Played): selection count,
 * New/Existing toggle, the name field or the target `PlaylistChooser`, and
 * the primary button.
 */
export function SaveToPlaylistPanel<P extends PickerPlaylist>({
  selectedCount,
  mode,
  onModeChange,
  name,
  onNameChange,
  namePlaceholder,
  playlists,
  playlistsLoading,
  playlistsError,
  onRetryPlaylists,
  target,
  onTargetChange,
  saving,
  onSave,
}: SaveToPlaylistPanelProps<P>) {
  return (
    <Panel
      title="Save to Playlist"
      description={`${selectedCount} track${selectedCount !== 1 ? "s" : ""} selected`}
    >
      <div className="space-y-4">
        <SegmentedControl label="Save to" value={mode} options={SAVE_MODES} onChange={onModeChange} />

        {mode === "new" ? (
          <Field label="Playlist name" hint="Optional — a dated name is used if you leave it blank.">
            {(field) => (
              <Input
                {...field}
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder={namePlaceholder}
                className="h-11"
              />
            )}
          </Field>
        ) : (
          <PlaylistChooser
            label="Playlist"
            dialogTitle="Your playlists"
            playlists={playlists}
            value={target}
            onChange={onTargetChange}
            loading={playlistsLoading}
            loadError={playlistsError}
            onRetry={onRetryPlaylists}
          />
        )}
      </div>

      <ActionBar layout="stretch">
        <Button
          onClick={onSave}
          disabled={saving || selectedCount === 0 || (mode === "existing" && !target)}
        >
          {saving ? (
            <>
              <LoadingSpinner size="sm" />
              Saving...
            </>
          ) : (
            <>
              <SquarePlus aria-hidden="true" className="w-4 h-4" />
              Save to Playlist
            </>
          )}
        </Button>
      </ActionBar>
    </Panel>
  );
}
