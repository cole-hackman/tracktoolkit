import { csvEscape } from "@/lib/csv";
import type { BatchResolveRow } from "./types";

/**
 * The Link Resolver's CSV export: one line per pasted link, failures included.
 * Titles and usernames are other people's text and the link is whatever was
 * pasted, so every cell goes through `csvEscape` (quoting plus the spreadsheet
 * formula guard). The header is fixed text and comes first, so no user value
 * is ever the first thing in the file.
 */
export function resolvedRowsToCsv(rows: BatchResolveRow[]): string {
  const lines = [
    "index,status,type,title,artist,url,permalink",
    ...rows.map((r) => {
      const title = r.data?.type === "user" ? r.data?.username : r.data?.title;
      const artist =
        r.data?.type === "track" || r.data?.type === "playlist"
          ? r.data.user?.username || r.data?.username || ""
          : r.data?.username || "";
      const cells = [r.index, r.status, r.data?.type || "", title || "", artist, r.url, r.data?.permalink_url || ""];
      return cells.map(csvEscape).join(",");
    }),
  ];
  return lines.join("\n");
}
