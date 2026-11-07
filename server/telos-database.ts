import { resolveTelosDatabasePath } from '@mitzo/protocol/telos-sqlite-owners';

/** One private-storage selection for API, native tools, execution authority and
 * backup. Bootstrap requires an explicit offline migration for retained legacy
 * data; request handling never falls back or initializes an empty substitute. */
export function telosDatabasePath(
  base = process.env.REPO_PATH || process.cwd(),
  environment = process.env,
) {
  return resolveTelosDatabasePath(base, environment);
}
