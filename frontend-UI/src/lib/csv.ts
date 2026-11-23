// Excel / Sheets / LibreOffice execute a cell that opens with =, +, -, @, tab,
// CR or LF. Titles, artist names and usernames are written by other SoundCloud
// users, so a track called `=HYPERLINK("http://evil...")` would fire when the
// export is opened. An apostrophe in front makes the cell literal text; the
// spreadsheet does not show it.
//
// "Opens with" is judged the way a spreadsheet might see the cell, not the way
// the string starts: anything it does not show or may trim (spaces of any
// width, control characters, zero-width and direction marks, a stray BOM) is
// skipped first, and the full-width forms of = + - @ count, since they are
// read as formulas in some locales. The value itself is never changed.
//
// Keep this pattern identical to CSV_FORMULA_PREFIX_RE in
// server/routes/admin.js: tests/csv-guard-parity.test.js compares the two.
const CSV_FORMULA_PREFIX_RE = /^[\t\r\n]|^[\s\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

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
  const safe = typeof value === "string" && CSV_FORMULA_PREFIX_RE.test(raw) ? `'${raw}` : raw;
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
