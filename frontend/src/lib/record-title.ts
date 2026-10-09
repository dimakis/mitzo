/** A compact display label. The full saved summary remains available in detail. */
export function recordTitle(summary: string): string {
  const firstLine =
    summary
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? '';
  const title = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#+$/, '')
    .trim();
  if (!title) return 'Untitled';
  return title.length > 200 ? `${title.slice(0, 199).trimEnd()}…` : title;
}
