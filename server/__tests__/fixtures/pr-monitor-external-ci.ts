/** Explicit empty external sources for existing Actions/runtime regressions.
 * Undefined means this fixture does not own that endpoint. */
export function emptyExternalCi(endpoint: string): unknown | undefined {
  if (endpoint.includes('/check-suites?')) return { total_count: 0, check_suites: [] };
  if (endpoint.includes('/check-runs?')) return { total_count: 0, check_runs: [] };
  if (endpoint.includes('/statuses?')) return [];
  return undefined;
}
