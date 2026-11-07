import { resolveTelosDatabasePath } from '@mitzo/protocol/telos-sqlite-owners';

/** One selection for API, native tools, execution authority and backup. Keep an
 * installed legacy file selected until an explicit stopped-service migration;
 * never silently create a second empty backlog beside existing work. */
export function telosDatabasePath(
  base = process.env.REPO_PATH || process.cwd(),
  environment = process.env,
) {
  return resolveTelosDatabasePath(base, environment);
}
