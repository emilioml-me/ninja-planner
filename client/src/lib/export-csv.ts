/**
 * Converts an array of objects to a CSV string and triggers a browser download.
 */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;

  // Union of keys across every row, not just rows[0] — if any caller builds rows with
  // conditionally-present keys and the first row happens to omit one, that column was
  // previously dropped silently from every other row's export instead of just being blank
  // where absent.
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (val: unknown): string => {
    if (val == null) return '';
    let str = String(val);
    // Prefix formula-injection characters so spreadsheets treat them as text — but only for
    // non-numeric values: real numbers (including negatives like -5 or "-12.5") stay numeric in
    // the spreadsheet instead of becoming the text "'-5".
    const isNumeric = typeof val === 'number' || (str.trim() !== '' && Number.isFinite(Number(str)));
    if (!isNumeric && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    // Wrap in quotes if it contains comma, newline, or quote
    if (str.includes(',') || str.includes('\n') || str.includes('\r') || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ];

  // UTF-8 BOM (separate Blob part) so Excel detects the encoding — accented names otherwise
  // render as mojibake.
  const blob = new Blob(['﻿', lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox ignores click() on an anchor that isn't attached to the document, and revoking the
  // object URL synchronously right after click() can cancel the download before it starts.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
