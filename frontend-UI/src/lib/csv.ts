// Excel / Sheets / LibreOffice execute a cell that opens with =, +, -, @, tab
// or CR. Titles, artist names and usernames are written by other SoundCloud
// users, so a track called `=HYPERLINK("http://evil...")` would fire when the
// export is opened. An apostrophe in front makes the cell literal text; the
// spreadsheet does not show it.
const DANGEROUS_CSV_PREFIX_RE = /^[=+\-@\t\r]/;

/**
 * One CSV cell, always quoted (RFC 4180), with the formula guard above. The one
 * definition for every CSV the app writes — `escapeCsvCell` in `export.ts`
 * delegates here.
 *
 * Only strings are guarded. A number cannot carry a formula, and prefixing it
 * would turn a legitimate negative count into the text `'-1`.
 */
export function csvEscape(value: unknown) {
  const raw = value == null ? "" : String(value);
  const safe = typeof value === "string" && DANGEROUS_CSV_PREFIX_RE.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = `\ufeff${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
