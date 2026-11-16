import { isOrdinaryRepositoryParticipantBinding, type AccountBinding } from '@mitzo/protocol';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { sessionHarnessForProvider } from './session-harness-routing.js';

/** The ordinary primary repository, with a fresh account-bound preparation.
 * No source-chat directory, first command or model invocation is borrowed.
 */
export async function prepareOrdinaryDefaultRepository(options: {
  workspaces: RepositoryWorkspaces;
  binding: AccountBinding;
  mode: 'ask' | 'agent' | 'auto';
  requestId: string;
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  options.assertCurrent();
  const harness = sessionHarnessForProvider(options.binding.provider);
  if (harness !== 'codex' && harness !== 'claude-sdk')
    throw Error('Default repository joining is unavailable for this engine');
  if (
    process.env[`MITZO_ORDINARY_LOCAL_${harness === 'codex' ? 'CODEX' : 'VERTEX'}_ENABLED`] !== '1'
  )
    throw Error('Default repository runtime is unavailable');
  const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
  options.assertCurrent();
  const inventory = ordinaryRepositoryRuntimeInventory('local', harness);
  const account = {
    accountId: options.binding.accountId,
    provider: options.binding.provider,
    profileRevision: options.binding.profileRevision,
  };
  const candidates = inventory.result.targets
    .filter((target) => target.location === 'local' && target.harness === harness)
    .map((target) =>
      inventory.catalog.resolve({
        account,
        harness,
        targetId: target.targetId,
        mode: options.mode,
      }),
    )
    .filter((result) => result.status === 'compatible');
  if (
    candidates.length !== 1 ||
    candidates[0].status !== 'compatible' ||
    !isOrdinaryRepositoryParticipantBinding(candidates[0].binding)
  )
    throw Error('Default repository needs one supported runtime');
  options.assertCurrent();
  const runtime = candidates[0].binding;
  const record = await options.workspaces.selectLocalRepository(
    options.binding,
    'primary',
    {
      runOn: 'local',
      runtime: { account: runtime.account, harness, targetId: runtime.execution.targetId },
    },
    options.signal,
    options.requestId,
  );
  options.assertCurrent();
  return record.id;
}
