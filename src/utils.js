'use strict';

/**
 * Render a simple ASCII table.
 *
 * @param {string[][]} rows  - Array of string arrays (one per row)
 * @param {string[]}   headers - Column header labels
 */
function formatTable(rows, headers) {
  if (!rows.length) return;
  const allRows = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...allRows.map((r) => String(r[i] || '-').length))
  );
  const line = (row) => widths.map((w, i) => String(row[i] || '-').padEnd(w)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(line(headers));
  console.log(sep);
  for (const row of rows) console.log(line(row));
}

/**
 * Format an ISO date string to a human-readable form.
 */
function formatDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Format bytes to a human-readable string.
 */
function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { formatTable, formatDate, formatBytes };
