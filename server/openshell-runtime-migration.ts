import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { RuntimeMigrationCapacity } from './openshell-runtime-migration-capacity.js';
import type { AccountBinding } from '@mitzo/protocol';
import type { ArtifactRuntime, CodexConversationStore } from './codex-conversation-store.js';
import type { CheckpointIdentity } from './openshell-checkpoint-transport.js';

export interface RuntimeMigration {
  generation: number;
  phase: 'observed' | 'checkpointed' | 'candidate' | 'restored' | 'committed' | 'blocked';
  threadGeneration: number;
  source: ArtifactRuntime;
  identity: CheckpointIdentity;
  targetImage: string;
  targetPolicy: string;
  candidateName: string;
  candidate?: ArtifactRuntime;
  checkpoint?: { path: string; digest: string };
  failure?: string;
  resumePhase?: RuntimeMigration['phase'];
  retryNotBefore?: number;
  retryable?: boolean;
  bootstrappedSource?: boolean;
  capacity?: RuntimeMigrationCapacity;
}
export interface RuntimeMigrationAdapters {
  /** Must verify actual image, policy, physical ownership and source resource version. */
  observe(
    source: ArtifactRuntime,
  ): Promise<{ image: string; policy: string; resourceVersion: string }>;
  /** No killing writers. Unknown activity is a blocker. */
  quiescent(source: ArtifactRuntime): Promise<void>;
  capture(
    source: ArtifactRuntime,
    identity: CheckpointIdentity,
    generation: number,
  ): Promise<{ path: string; digest: string }>;
  capacity?(checkpoint: { path: string; digest: string }): Promise<RuntimeMigrationCapacity>;
  create(name: string): Promise<ArtifactRuntime>;
  attest(candidate: ArtifactRuntime): Promise<void>;
  restore(
    candidate: ArtifactRuntime,
    checkpoint: { path: string; digest: string },
    identity: CheckpointIdentity,
  ): Promise<void>;
  /** Offline native protocol resume must confirm the same persisted thread before switching. */
  verifyRestored(candidate: ArtifactRuntime, identity: CheckpointIdentity): Promise<void>;
}
export async function migrateRetainedRuntime(input: {
  conversationId: string;
  binding: AccountBinding;
  store: CodexConversationStore;
  source: ArtifactRuntime;
  targetImage: string;
  targetPolicy: string;
  supportedSourceImages: readonly string[];
  adapters: RuntimeMigrationAdapters;
}): Promise<ArtifactRuntime> {
  const { conversationId: id, binding, store, adapters } = input;
  const conversation = store.read(id, binding);
  let record = store.readRuntimeMigration(id, binding);
  if (
    record &&
    (record.targetImage !== input.targetImage || record.targetPolicy !== input.targetPolicy)
  )
    throw new Error('Retained migration target changed; original sandbox and checkpoint retained');
  if (
    record &&
    record.phase !== 'committed' &&
    (conversation.threadId !== record.identity.thread ||
      conversation.threadGeneration !== record.threadGeneration)
  )
    throw new Error('Retained migration authoritative provider thread changed');
  if (record?.phase === 'committed') {
    const current = store.readArtifactRuntime(id, binding);
    // Migration is terminal history. The ordinary lifecycle may later recreate
    // the same candidate under a strictly verified newer checkpoint identity.
    if (
      !record.candidate ||
      !current ||
      current.runtime.sandboxName !== record.candidateName ||
      input.source.runtime.sandboxName !== record.candidateName ||
      !isDeepStrictEqual(current.route, record.candidate.route) ||
      !isDeepStrictEqual(input.source.route, record.candidate.route) ||
      input.source.runtime.workspace !== record.candidate.runtime.workspace ||
      input.source.runtime.gateway !== record.candidate.runtime.gateway ||
      input.source.runtime.gatewayEndpoint !== record.candidate.runtime.gatewayEndpoint ||
      input.source.runtime.workdir !== record.candidate.runtime.workdir
    )
      throw new Error('Retained migration committed routing changed');
    return input.source;
  }
  if (!conversation.threadId || conversation.recoveryStrategy !== 'resume')
    throw new Error('Retained migration requires an authoritative resumable provider thread');
  if (store.hasAmbiguousRuntimeActivity(id, binding))
    throw new Error('Retained migration blocked by active or ambiguous provider execution');
  if (record?.phase === 'blocked') {
    if (
      !record.retryable ||
      !record.resumePhase ||
      Date.now() < (record.retryNotBefore ?? Infinity)
    )
      throw new Error(
        'Retained migration blocked; inspect its preserved checkpoint and diagnostic before retrying',
      );
    record = store.advanceRuntimeMigration(id, binding, record.generation, {
      phase: record.resumePhase,
      failure: undefined,
      retryable: undefined,
      retryNotBefore: undefined,
    });
  }
  const observed = await adapters.observe(record?.source ?? input.source);
  if (!record && observed.image === input.targetImage) {
    if (observed.policy !== input.targetPolicy)
      throw new Error('Retained migration target policy differs');
    return input.source;
  }
  if (
    !input.supportedSourceImages.includes(observed.image) ||
    observed.policy !== input.targetPolicy
  )
    throw new Error(
      'Retained migration source image or policy is not a reviewed supported contract',
    );
  if (!record) {
    const source = input.source;
    if (source.route.kind === 'chatgpt-subscription-native' || !source.runtime.sandboxId)
      throw new Error('Retained migration supports ordinary owned OpenShell Codex only');
    const route = source.route;
    const identity: CheckpointIdentity = {
      conversation: id,
      thread: conversation.threadId,
      binding: JSON.stringify([
        binding.accountId,
        binding.provider,
        binding.model,
        binding.profileRevision,
      ]),
      image: observed.image,
      policy: observed.policy,
      sandboxId: source.runtime.sandboxId,
      resourceVersion: observed.resourceVersion,
      accountProvider: route.provider,
      accountId: binding.accountId,
      provider: binding.provider,
      model: binding.model,
      profileRevision: binding.profileRevision,
      runtimeScope: source.runtime.workspace,
      routeKind: route.kind,
      routeProvider: route.provider,
      ...(route.kind === 'chatgpt-subscription'
        ? {
            routeProviderType: route.providerType,
            routeProviderId: route.providerId,
            routeGrantId: route.grantId,
          }
        : {}),
    };
    record = store.beginRuntimeMigration(id, binding, {
      generation: 1,
      phase: 'observed',
      threadGeneration: conversation.threadGeneration,
      source,
      identity,
      targetImage: input.targetImage,
      targetPolicy: input.targetPolicy,
      candidateName: `mitzo-migrate-${randomUUID()}`,
    });
  }
  if (record.identity.image !== observed.image || record.identity.policy !== observed.policy)
    throw new Error('Retained migration source contract changed');
  const advance = (next: Partial<RuntimeMigration>) => {
    record = store.advanceRuntimeMigration(id, binding, record!.generation, next);
  };
  try {
    await adapters.quiescent(record.source);
    if (record.phase === 'observed') {
      const checkpoint = await adapters.capture(record.source, record.identity, record.generation);
      advance({ phase: 'checkpointed', checkpoint });
    }
    if (record.phase === 'checkpointed') {
      if (adapters.capacity) advance({ capacity: await adapters.capacity(record.checkpoint!) });
      // Name is committed before the create call; recovery finds this exact candidate,
      // never creates another or deletes the old sandbox after an uncertain call.
      const candidate = await adapters.create(record.candidateName);
      if (
        !candidate.runtime.sandboxId ||
        candidate.runtime.sandboxId === record.source.runtime.sandboxId ||
        candidate.runtime.sandboxName !== record.candidateName ||
        !isDeepStrictEqual(candidate.route, record.source.route) ||
        candidate.runtime.workspace !== record.source.runtime.workspace ||
        candidate.runtime.gateway !== record.source.runtime.gateway ||
        candidate.runtime.gatewayEndpoint !== record.source.runtime.gatewayEndpoint ||
        candidate.runtime.workdir !== record.source.runtime.workdir
      )
        throw new Error('Retained migration candidate identity differs');
      advance({ phase: 'candidate', candidate });
    }
    await adapters.attest(record.candidate!);
    if (record.phase === 'candidate') {
      await adapters.restore(record.candidate!, record.checkpoint!, record.identity);
      advance({ phase: 'restored' });
    }
    await adapters.verifyRestored(record.candidate!, record.identity);
    // Atomic SQLite transaction records the explicit source-to-target relation and
    // authoritative candidate routing, checking the same thread generation again.
    return store.commitRuntimeMigration(id, binding, record.generation);
  } catch (error) {
    // Preserve the entire original sandbox, checkpoint and candidate for inspection.
    // No deletion, image-label rewriting or ambiguous automatic rollback mutation.
    try {
      const retryable =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.name === 'TimeoutError' ||
          /storage capacity insufficient|timed out|connection (?:closed|refused)|writer.*(?:running|open)|execution process.*(?:running|remaining)/i.test(
            error.message,
          ));
      advance({
        phase: 'blocked',
        resumePhase: record.phase,
        retryable,
        retryNotBefore: retryable ? Date.now() + 60_000 : undefined,
        failure: error instanceof Error ? error.message : 'Retained migration failed',
      });
    } catch {
      /* a competing generation owns recovery */
    }
    throw error;
  }
}
