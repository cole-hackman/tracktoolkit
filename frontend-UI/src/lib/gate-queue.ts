export interface HypedditQueueItem {
  id: number;
  title: string;
  artist: string;
  hypedditUrl: string;
}

/**
 * Saves Hypeddit gates as the file the local runner (tools/hypeddit-runner)
 * reads: `{ queue: [{ id, title, artist, hypedditUrl }] }`. The runner drops
 * anything that is not a hypeddit.com gate URL, so this is not a trust
 * boundary — just the one place the file's shape is written.
 */
export function downloadHypedditQueue(queue: HypedditQueueItem[], filename = "hypeddit-queue.json") {
  const blob = new Blob([JSON.stringify({ queue }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
