import { runtimePolicyProvenance } from './openshell-runtime-policy.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { setTimeout as delay } from 'node:timers/promises';
import type { AccountBinding } from '@mitzo/protocol';
import { CodexAppServerClient } from './codex-app-server-client.js';
import {
  OpenShellCheckpointTransport,
  type CheckpointIdentity,
} from './openshell-checkpoint-transport.js';
import { canonicalJsonPayload } from '../scripts/verify-openshell-production.mjs';
import type { ArtifactRuntime, CodexConversationStore } from './codex-conversation-store.js';
import { requireRuntimeMigrationCapacity } from './openshell-runtime-migration-capacity.js';
import { migrateRetainedRuntime } from './openshell-runtime-migration.js';
import {
  preparePublishedOpenShellSeed,
  type OpenShellRuntimeConfig,
  type OpenShellRuntimeManager,
} from './openshell-runtime.js';

const policyHash = (policy: unknown) =>
  createHash('sha256').update(canonicalJsonPayload(policy)).digest('hex');
function command(binary: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      binary,
      args,
      { signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) =>
        error ? reject(new Error('Runtime image observation unavailable')) : resolve(stdout),
    ),
  );
}
/** Exact local-driver labels establish which container belongs to this gateway resource.
 * A desired image, an arbitrary container name or a missing driver is never provenance. */
export async function observePodmanRuntimeImage(
  runtime: ArtifactRuntime['runtime'],
  signal: AbortSignal,
) {
  const ids = (
    await command(
      'podman',
      [
        'ps',
        '--all',
        '--filter',
        `label=openshell.ai/sandbox-id=${runtime.sandboxId}`,
        '--format',
        '{{.ID}}',
      ],
      signal,
    )
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 1) throw new Error('Runtime source driver ownership is ambiguous');
  const containers = JSON.parse(
    await command('podman', ['inspect', '--type', 'container', ids[0]], signal),
  );
  const container = containers[0];
  if (
    containers.length !== 1 ||
    container.Config?.Labels?.['openshell.ai/sandbox-id'] !== runtime.sandboxId ||
    container.Config?.Labels?.['openshell.ai/sandbox-name'] !== runtime.sandboxName ||
    container.Config?.Labels?.['openshell.ai/sandbox-workspace'] !== runtime.workspace
  )
    throw new Error('Runtime source driver ownership changed');
  const images = JSON.parse(await command('podman', ['image', 'inspect', container.Image], signal));
  const digest = images[0]?.Digest;
  if (images.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error('Runtime source immutable image digest unavailable');
  return digest as string;
}
/** Invoked under the startup/resume lifecycle reservation, before any app-server starts.
 * Capture's strict process scan supplies the actual source-writer barrier. */
export async function prepareRetainedRuntimeMigration(input: {
  conversationId: string;
  binding: AccountBinding;
  store: CodexConversationStore;
  source: ArtifactRuntime;
  config: OpenShellRuntimeConfig;
  manager: OpenShellRuntimeManager;
  privateDirectory: string;
  signal: AbortSignal;
  closeOwnedTransport?: () => Promise<void>;
}): Promise<ArtifactRuntime> {
  const { config, signal, manager, source, conversationId: id } = input;
  const runtimeContract = config.seedStackManifest?.runtime as Record<string, unknown> | undefined;
  if (runtimeContract?.knowledgeSchemaVersion !== 1) return source;
  const targetImage = String(runtimeContract.digest);
  if (!/^sha256:[a-f0-9]{64}$/.test(targetImage))
    throw new Error('Retained migration target digest is invalid');
  const targetPolicy = policyHash(load(readFileSync(config.policy, 'utf8')));
  const supported = ['sha256:b89016abe4c17850ee31e2c4613697f6a4871356953952b0edcdb4fdfb8db624'];
  const root = join(
    input.privateDirectory,
    'runtime-migrations',
    createHash('sha256').update(id).digest('hex'),
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const probes = new Set<string>();
  let preparedSeed: { seed: string; cleanup: () => void } | undefined;
  let checkpointDigest: string | undefined;
  let approvedSourceGrants: readonly string[] | undefined;
  let sourceProbe: { path: string; digest: string } | undefined;
  const captureOrVerify = async (
    runtime: ArtifactRuntime,
    identity: CheckpointIdentity,
    directory: string,
  ) => {
    const transport = new OpenShellCheckpointTransport(runtime.runtime);
    const path = join(directory, `mitzo-${createHash('sha256').update(id).digest('hex')}.tar`);
    if (existsSync(path)) return { path, ...(await transport.verify(path, identity, signal)) };
    return transport.capture(directory, identity, signal);
  };
  const quiescentCapture = async (
    runtime: ArtifactRuntime,
    identity: CheckpointIdentity,
    label: string,
  ) => {
    const deadline = Date.now() + 5_000;
    while (true) {
      signal.throwIfAborted();
      const directory = join(root, `${label}-${randomUUID()}`);
      probes.add(directory);
      try {
        return await captureOrVerify(runtime, identity, directory);
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        probes.delete(directory);
        if (
          !(error instanceof Error) ||
          !/writer.*(?:open|running)|execution process.*running/i.test(error.message) ||
          Date.now() >= deadline
        )
          throw error;
        await delay(100, undefined, { signal });
      }
    }
  };
  try {
    return await migrateRetainedRuntime({
      ...input,
      targetImage,
      targetPolicy,
      supportedSourceImages: supported,
      adapters: {
        observe: async (original) => {
          const observation = await manager
            .forSandbox(original.runtime.sandboxName)
            .observeContract(id, original.runtime, signal);
          approvedSourceGrants = observation.approvedGrantableProviders;
          return {
            policyAttestation: runtimePolicyProvenance(observation.attestation),
            image: await observePodmanRuntimeImage(original.runtime, signal),
            policy: policyHash(observation.attestation.basePolicy),
            resourceVersion: observation.resourceVersion,
          };
        },
        quiescent: async (original) => {
          await input.closeOwnedTransport?.();
          signal.throwIfAborted();
          const record = input.store.readRuntimeMigration(id, input.binding)!;
          // Fresh strict capture probes both source writers and current contents on
          // every retry. A cached archive is never proof of current quiescence.
          sourceProbe = await quiescentCapture(original, record.identity, 'source-probe');
          if (record.checkpoint && sourceProbe.digest !== record.checkpoint.digest)
            throw new Error('Migration source task/provider state changed after checkpoint');
        },
        capture: async () => {
          if (!sourceProbe) throw new Error('Migration source quiescence unverified');
          return sourceProbe;
        },
        capacity: async (checkpoint) => {
          let proof: Awaited<ReturnType<typeof requireRuntimeMigrationCapacity>> | undefined;
          preparedSeed = await preparePublishedOpenShellSeed(config, signal, async (selected) => {
            proof = await requireRuntimeMigrationCapacity(
              {
                checkpointPath: checkpoint.path,
                privateDirectory: root,
                seedDirectory: selected,
                targetImage,
                imageReference: config.image,
              },
              (args) => command('podman', args, signal),
            );
          });
          if (!proof) throw new Error('Migration selected seed capacity unverified');
          return proof;
        },
        create: async (name) => {
          const runtime = await manager
            .forSandbox(name)
            .ensure(id, signal, undefined, preparedSeed, approvedSourceGrants);
          if (!runtime.sandboxId) throw new Error('Migration candidate has no physical identity');
          return { runtime: { ...runtime, sandboxId: runtime.sandboxId }, route: source.route };
        },
        attest: async (candidate) => {
          const observation = await manager
            .forSandbox(candidate.runtime.sandboxName)
            .observeContract(id, candidate.runtime, signal);
          if (policyHash(observation.attestation.basePolicy) !== targetPolicy)
            throw new Error('Migration target actual policy differs');
          if ((await observePodmanRuntimeImage(candidate.runtime, signal)) !== targetImage)
            throw new Error('Migration target physical image differs');
          await manager
            .forSandbox(candidate.runtime.sandboxName)
            .verifyKnowledgeRuntime(candidate.runtime, signal);
          return runtimePolicyProvenance(observation.attestation);
        },
        restore: async (candidate, checkpoint, identity) => {
          checkpointDigest = checkpoint.digest;
          await new OpenShellCheckpointTransport(candidate.runtime).restore(
            checkpoint.path,
            identity,
            checkpoint.digest,
            signal,
          );
        },
        verifyRestored: async (candidate, identity) => {
          const record = input.store.readRuntimeMigration(id, input.binding)!;
          const candidateIdentity = {
            ...identity,
            image: targetImage,
            sandboxId: candidate.runtime.sandboxId,
            resourceVersion: candidate.runtime.resourceVersion!,
          };
          const directory = join(root, `candidate-probe-${randomUUID()}`);
          probes.add(directory);
          const restored = await captureOrVerify(candidate, candidateIdentity, directory);
          if (restored.digest !== (checkpointDigest ?? record.checkpoint?.digest))
            throw new Error('Migration restored task/provider state differs');
          const client = CodexAppServerClient.launchOpenShell(candidate.runtime, process.env, {
            onNotification: () => {},
            onClose: () => {},
            onRequest: async () => {
              throw new Error('Migration validation cannot execute tools or approvals');
            },
          });
          try {
            await client.initialize();
            const response = (await client.request('thread/resume', {
              threadId: identity.thread,
              cwd: candidate.runtime.workdir,
              model: input.binding.model,
              modelProvider: 'openshell',
              allowProviderModelFallback: false,
            })) as { thread: { id: string }; model: string; modelProvider: string };
            if (
              response.thread?.id !== identity.thread ||
              response.model !== input.binding.model ||
              response.modelProvider !== 'openshell'
            )
              throw new Error('Migration provider thread or model changed');
          } finally {
            client.close();
            // close() requests process exit; fresh strict capture proves the actual
            // writer barrier before any durable ownership switch, including errors.
            await quiescentCapture(candidate, candidateIdentity, 'validated-probe');
          }
        },
      },
    });
  } finally {
    preparedSeed?.cleanup();
    // Only this invocation's disposable probe directories are ours to remove.
    // The durably recorded original checkpoint survives failures and retries.
    const retained = input.store.readRuntimeMigration(id, input.binding)?.checkpoint?.path;
    for (const directory of probes) {
      if (!retained || dirname(retained) !== directory)
        rmSync(directory, { recursive: true, force: true });
    }
  }
}
