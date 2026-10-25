import { isDeepStrictEqual } from 'node:util';
import { SessionRuntimeBindingV2Schema, type AccountBinding } from '@mitzo/protocol';
import {
  OpenShellCodexCustodySchema,
  openShellPhysicalCustodyFingerprint,
} from './openshell-codex-custody.js';
import type { ArtifactRuntime } from './codex-conversation-store.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import type { ordinaryOpenShellCodexTarget } from './ordinary-openshell-codex-route.js';

/** Preserve the original receipts, workspace settings and native custody across
 * compatible deployments. Only server-owned native custody may qualify an old
 * deployment fingerprint. The installed code/policy is attested independently
 * by loadOrdinaryOpenShellCodexTarget; this never authorizes provider dispatch.
 */
export function ordinaryOpenShellCodexContinuationTarget(input: {
  target: ReturnType<typeof ordinaryOpenShellCodexTarget>;
  config: OpenShellRuntimeConfig;
  account: AccountBinding;
  binding: unknown;
  custody: unknown;
  artifact: ArtifactRuntime | null | undefined;
  authSessionId: string;
}) {
  const binding = SessionRuntimeBindingV2Schema.parse(input.binding);
  const custody = OpenShellCodexCustodySchema.parse(input.custody);
  const { artifact, config, target, account } = input;
  const physical = artifact?.runtime;
  if (
    !physical?.sandboxId ||
    !physical.sandboxName ||
    custody.authSessionId !== input.authSessionId ||
    !isDeepStrictEqual(custody.binding, binding) ||
    !isDeepStrictEqual(binding.account, {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    }) ||
    binding.harness.implementation !== 'codex' ||
    binding.execution.location !== 'openshell' ||
    binding.execution.targetId !== target.targetId ||
    custody.workspace.cwd !== config.workdir ||
    custody.physicalIdentitySha256 !== openShellPhysicalCustodyFingerprint(artifact!) ||
    physical.cli !== config.cli ||
    physical.gateway !== config.gateway ||
    physical.workspace !== config.workspace ||
    physical.gatewayEndpoint !== config.gatewayEndpoint ||
    physical.gatewayInsecure !== config.gatewayInsecure ||
    physical.workdir !== config.workdir ||
    !isDeepStrictEqual(physical.cliEnvironment, config.cliEnvironment)
  )
    throw new Error('Original OpenShell conversation authority is unavailable');
  return { ...target, targetRevision: binding.execution.targetRevision };
}
