import { createHash } from 'node:crypto';
import { SUPPORTED_CODEX_CLI_VERSION } from './codex-app-server-client.js';

export const HOST_CODEX_CONTINUITY_CONTRACT = 'codex-native-thread-v1' as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function v2TargetRevision(targetId: string, hostId: string, cliVersion: string): string {
  return digest([
    'ordinary-local-codex-target-v2',
    targetId,
    hostId,
    HOST_CODEX_CONTINUITY_CONTRACT,
    cliVersion,
  ]);
}

export function hostCodexContinuityTargetRevision(targetId: string, hostId: string): string {
  return v2TargetRevision(targetId, hostId, SUPPORTED_CODEX_CLI_VERSION);
}

/** Reviewed native CLI upgrades, keyed by the current CLI version. A v2
 * conversation, saved preparation or retained effect bound under a listed
 * earlier CLI continues on the current one under the same native-thread
 * contract. Account, host, executable custody, workspace, command receipts and
 * thread are still verified independently; unlisted versions stay blocked.
 * Decision: Dimitri, 2026-11-26 (PR #1420), to keep 0.160.0 conversations
 * continuable across the 0.171.0 upgrade. Add an entry only with a new review.
 */
const REVIEWED_V2_CLI_UPGRADES: Readonly<Record<string, readonly string[]>> = {
  '0.171.0': ['0.160.0'],
};

export function reviewedUpgradedHostTargetRevisions(targetId: string, hostId: string): string[] {
  return (REVIEWED_V2_CLI_UPGRADES[SUPPORTED_CODEX_CLI_VERSION] ?? []).map((version) =>
    v2TargetRevision(targetId, hostId, version),
  );
}

/** Explicit compatibility bridge for the accepted release 8c3e5062c5df.
 * This is its sorted reviewed source closure, not a caller-supplied alias.
 * Original account, host, executable custody, workspace, command receipts and
 * thread must still be independently verified. Unknown releases stay blocked.
 * Future compatible deployments use the stable v2 identity and exact current
 * deployment attestation separately. Native CLI upgrades require a new review.
 */
export function reviewedLegacyHostTargetRevisions(
  targetId: string,
  hostId: string,
  executableSha256: string,
): string[] {
  const contract = reviewedLegacyHostContractRevision(executableSha256);
  return contract ? [digest(['ordinary-local-codex-target-v1', targetId, hostId, contract])] : [];
}
export function reviewedLegacyHostContractRevision(executableSha256: string): string | undefined {
  if (SUPPORTED_CODEX_CLI_VERSION !== '0.160.0') return undefined;
  return digest([
    'ordinary-local-codex-host-v1',
    'v1.0.531-repository-recovery-integration',
    '24f1c83ffc3759a76095f3072edcc9fdebbe5087c874469d60e286d728160462',
    '0.160.0',
    executableSha256,
  ]);
}
