import { createLogger } from './logger.js';

/**
 * Counts every Claude SDK authority check, labelled by depth and caller.
 *
 * `deep` is the full proof: owner selection revalidation (workspace
 * reservation, repository credential digest, checkout validation) and the API
 * keychain proof. `tool` is the per-tool check that mirrors Codex: synchronous
 * owner, receipt, selection and credential-identity fences plus claimed
 * checkout validation (and, for API keys, the keychain read Codex also runs per
 * tool), without workspace reservation or the repository credential digest.
 *
 * Phase timing (`observeLocalCodexPhase`) logs only slow phases, so it cannot
 * show how many proofs a tool call costs. These counters can (Telos slice
 * facabd5d29f01bc9). Labels are bounded enums; no identifiers or payloads.
 */
export type SdkAuthorityDepth = 'deep' | 'tool';
export type SdkAuthorityCaller =
  /** Command admission and chat startup before the provider exists. */
  | 'startup'
  /** Release of a queued prompt to the native process. */
  | 'prompt_release'
  /** A turn's terminal result or post-terminal diagnostics. */
  | 'turn_result'
  /** Reopening the native query for the next command (history, process
   * closure, context and permission-mode steps before its prompt release). */
  | 'command_setup'
  /** FIFO command owner enqueue, dispatch and completion. */
  | 'command_owner'
  /** SDK hook fence (PreToolUse, PostToolUse, PostToolBatch, ...). */
  | 'hook'
  /** canUseTool permission decision. */
  | 'decide'
  /** In-process MCP handler (connections, Telos, Tool Library, web access). */
  | 'mcp'
  /** Repository read owner (Read/Grep/Glob through the native reader). */
  | 'repository_read'
  /** Effectful host operation that keeps the deep proof (GitHub publish,
   * on-demand worktree creation). */
  | 'host_effect';

/** Callers that run per tool call and therefore use the per-tool check. */
export const perToolSdkAuthorityCallers: ReadonlySet<SdkAuthorityCaller> = new Set([
  'hook',
  'decide',
  'mcp',
  'repository_read',
]);

const log = createLogger('sdk-authority');
const counts = new Map<string, number>();
let total = 0;
const SUMMARY_EVERY = 500;

export function observeSdkAuthorityCheck(depth: SdkAuthorityDepth, caller: SdkAuthorityCaller) {
  const key = `${depth}:${caller}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  total += 1;
  log.debug('SDK authority check', { code: 'sdk_authority_check', depth, caller });
  if (total % SUMMARY_EVERY === 0)
    log.info('SDK authority checks', {
      code: 'sdk_authority_check_summary',
      total,
      counts: Object.fromEntries(counts),
    });
}

/** Cumulative counts keyed `depth:caller`; for diagnostics and tests. */
export function sdkAuthorityCheckCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

export function resetSdkAuthorityCheckCounts() {
  counts.clear();
  total = 0;
}
