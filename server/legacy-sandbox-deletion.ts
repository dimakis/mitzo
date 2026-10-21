import type { CodexConversationStore } from './codex-conversation-store.js';
import type { EventStore } from './event-store.js';
import type { OpenShellLifecycleRecord } from './openshell-lifecycle.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';

/** Qualify historical ordinary ownership for one explicit deletion review.
 * This is capture-time compatibility, not a claim about the original image or
 * policy. Physical labels and protection are checked by the lifecycle adapter.
 * No ownership, checkpoint, sandbox or automatic-retention state is written here.
 */
export function readLegacySandboxDeletionRecord(
  id: string,
  events: Pick<EventStore, 'getSession' | 'listRetainedSymposiumSandboxOwners'>,
  native: Pick<
    CodexConversationStore,
    'read' | 'readArtifactRuntime' | 'readRuntimeMigration' | 'listSandboxOwnership'
  >,
  config: Pick<
    OpenShellRuntimeConfig,
    'workspace' | 'gateway' | 'gatewayEndpoint' | 'gatewayInsecure' | 'workdir' | 'image'
  >,
  policyDigest: string,
): OpenShellLifecycleRecord {
  const unavailable = () => new Error('Legacy sandbox ownership needs review in Sandboxes.');
  const meta = events.getSession(id);
  if (!meta?.accountBinding || meta.sessionType === 'symposium' || meta.symposiumConfig)
    throw unavailable();
  const binding = meta.accountBinding;
  if (!['openai', 'openai-codex'].includes(binding.provider)) throw unavailable();
  const saved = native.read(id, binding);
  const artifact = native.readArtifactRuntime(id, binding);
  if (!saved.threadId || saved.recovery || !artifact || native.readRuntimeMigration(id, binding))
    throw unavailable();
  const { runtime, route } = artifact;
  if (
    route.kind === 'chatgpt-subscription-native' ||
    route.model !== binding.model ||
    events.listRetainedSymposiumSandboxOwners(
      runtime.sandboxId,
      runtime.sandboxName,
      runtime.workspace,
    ).length
  )
    throw unavailable();
  const owners = native
    .listSandboxOwnership()
    .filter((owner) => owner.physicalId === runtime.sandboxId);
  if (owners.length !== 1) throw unavailable();
  const owner = owners[0]!;
  if (
    owner.conversationId !== id ||
    owner.ownerKind !== 'ordinary' ||
    owner.relation !== 'runtime' ||
    owner.accountId !== binding.accountId ||
    owner.sandboxName !== runtime.sandboxName ||
    owner.workspace !== runtime.workspace ||
    owner.gateway !== runtime.gateway ||
    (owner.gatewayEndpoint ?? null) !== (runtime.gatewayEndpoint ?? null) ||
    runtime.workspace !== config.workspace ||
    runtime.gateway !== config.gateway ||
    (runtime.gatewayEndpoint ?? null) !== (config.gatewayEndpoint ?? null) ||
    runtime.gatewayInsecure !== config.gatewayInsecure ||
    runtime.workdir !== config.workdir ||
    saved.cwd !== runtime.workdir ||
    !Number.isFinite(meta.updatedAt) ||
    meta.updatedAt <= 0
  )
    throw unavailable();
  return {
    conversationId: id,
    workspace: runtime.workspace,
    gateway: runtime.gateway,
    gatewayEndpoint: runtime.gatewayEndpoint ?? null,
    sandboxName: runtime.sandboxName,
    physicalSandboxId: runtime.sandboxId,
    accountProvider: route.provider,
    ownerClientId: null,
    phase: 'retained',
    generation: 1,
    lastActivityAt: meta.updatedAt,
    idleSince: null,
    stoppedAt: null,
    stoppedResourceVersion: null,
    checkpoint: null,
    retentionConsent: false,
    identity: {
      threadId: saved.threadId,
      accountId: binding.accountId,
      provider: binding.provider,
      model: binding.model,
      profileRevision: binding.profileRevision,
      image: config.image,
      policyDigest,
      runtimeScope: runtime.workspace,
      route,
    },
  };
}
