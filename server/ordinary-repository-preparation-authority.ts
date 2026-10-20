import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import { loadAccountProfiles } from './account-profiles.js';
import { OpenShellRuntimeManager } from './openshell-runtime.js';
import { loadOrdinaryOpenShellCodexTarget } from './ordinary-openshell-codex-entry-owner.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';
import {
  readPrivateRuntimeSettings,
  OrdinaryLocalCodexHostRuntime,
} from './ordinary-local-codex-host-runtime.js';
import {
  OrdinaryRepositoryPreparationSchema,
  OrdinarySilentPreparationSelectionSchema,
  type OrdinaryRepositoryPreparation,
  type OrdinaryRepositoryRuntimeSelection,
} from './ordinary-repository-preparation.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => Error('Original ordinary repository preparation authority unavailable');
function privateFile(path: string | undefined) {
  if (!path || realpathSync(path) !== path) throw unavailable();
  const before = lstatSync(path),
    value = readPrivateRuntimeSettings(path),
    after = lstatSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw unavailable();
  return { path, dev: after.dev, ino: after.ino, digest: digest(value) };
}
async function credentialDigest(
  binding: AccountBinding,
  selection: OrdinaryRepositoryRuntimeSelection,
  signal: AbortSignal,
) {
  const profiles = loadAccountProfiles();
  const source = process.env.MITZO_ACCOUNT_PROFILES_FILE
    ? privateFile(process.env.MITZO_ACCOUNT_PROFILES_FILE)
    : undefined;
  let credential: unknown;
  if (binding.provider === 'anthropic-vertex' || binding.provider === 'google-vertex') {
    const env =
      binding.provider === 'anthropic-vertex'
        ? profiles.sdkEnv(binding, {})
        : (() => {
            const profile = profiles.googleProfile(binding);
            return {
              CLAUDE_CODE_USE_VERTEX: '1',
              GOOGLE_APPLICATION_CREDENTIALS: profile.credentialRef,
              ANTHROPIC_VERTEX_PROJECT_ID: profile.projectId,
              CLOUD_ML_REGION: profile.region,
            };
          })();
    credential = VertexAdcCustody.capture(env).snapshot();
  } else if (binding.provider === 'openai-codex' && selection.runOn === 'local') {
    const profile = profiles.codexRoutingProfile(binding);
    if (!profile.credentialRef || realpathSync(profile.credentialRef) !== profile.credentialRef)
      throw unavailable();
    const root = lstatSync(profile.credentialRef);
    if (!root.isDirectory() || root.mode & 0o077 || root.uid !== process.getuid?.())
      throw unavailable();
    credential = {
      root: { path: profile.credentialRef, dev: root.dev, ino: root.ino },
      auth: privateFile(join(profile.credentialRef, 'auth.json')),
      native: await new OrdinaryLocalCodexHostRuntime().observe(),
    };
  } else if (binding.provider === 'openai' && selection.runOn === 'local') {
    const runtime = getConnectionsRuntime();
    const manager = runtime?.openAIEnrollmentAuthority;
    if (
      !profiles.isEnrolledOpenAIAccount(binding.accountId) ||
      !manager?.manages(binding.accountId)
    )
      throw unavailable();
    await manager.assertReady(binding.accountId, signal);
    credential = digest(await manager.resolveKey(binding.accountId, signal));
    await manager.assertReady(binding.accountId, signal);
    if (!manager.manages(binding.accountId)) throw unavailable();
  } else {
    const configured = loadOrdinaryOpenShellCodexTarget();
    if (!configured) throw unavailable();
    const route =
      binding.provider === 'openai-codex'
        ? (() => {
            const profile = profiles.codexRoutingProfile(binding);
            if (
              !profile.sandboxProvider ||
              !profile.sandboxProviderId ||
              !profile.sandboxGrantId ||
              profile.sandboxProviderType !== 'openai-codex-oauth' ||
              profile.credentialRef ||
              profile.nativeAuth
            )
              throw unavailable();
            return {
              kind: 'chatgpt-subscription' as const,
              provider: profile.sandboxProvider,
              providerType: 'openai-codex-oauth' as const,
              providerId: profile.sandboxProviderId,
              grantId: profile.sandboxGrantId,
              model: binding.model,
            };
          })()
        : (() => {
            const profile = profiles.apiRoutingProfile(binding);
            if (!profile.sandboxProvider) throw unavailable();
            return {
              kind: 'api' as const,
              provider: profile.sandboxProvider,
              model: binding.model,
            };
          })();
    if (route.kind === 'chatgpt-subscription') {
      const manager = new OpenShellRuntimeManager({
        ...configured.config,
        account: route,
        connectionAccountId: binding.accountId,
      });
      const expiresAt = await manager.verifySubscriptionSignIn(signal);
      if (Date.now() >= expiresAt) throw unavailable();
      credential = {
        kind: route.kind,
        provider: route.provider,
        providerType: route.providerType,
        providerId: route.providerId,
        grantId: route.grantId,
      };
    } else {
      const runtime = getConnectionsRuntime();
      if (
        !profiles.isEnrolledOpenAIAccount(binding.accountId) ||
        !runtime?.openAIEnrollmentAuthority?.manages(binding.accountId) ||
        !runtime.assertOpenAIKeyReady
      )
        throw unavailable();
      await runtime.assertOpenAIKeyReady(binding.accountId, signal);
      credential = digest(
        await runtime.openAIEnrollmentAuthority.resolveKey(binding.accountId, signal),
      );
      await runtime.assertOpenAIKeyReady(binding.accountId, signal);
    }
    const current = loadOrdinaryOpenShellCodexTarget();
    if (!current || !isDeepStrictEqual(current.target, configured.target)) throw unavailable();
  }
  signal.throwIfAborted();
  if (
    !isDeepStrictEqual(
      source,
      process.env.MITZO_ACCOUNT_PROFILES_FILE
        ? privateFile(process.env.MITZO_ACCOUNT_PROFILES_FILE)
        : undefined,
    )
  )
    throw unavailable();
  return digest({
    routingSourcePath: source?.path ?? null,
    enrolledSourcePath: process.env.MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB ?? null,
    credential,
  });
}
export async function captureOrdinaryRepositoryPreparation(
  binding: AccountBinding,
  selection: OrdinaryRepositoryRuntimeSelection,
  signal: AbortSignal,
  requireModelReadiness = true,
): Promise<OrdinaryRepositoryPreparation> {
  signal.throwIfAborted();
  const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
  const { profiles, catalog } = ordinaryRepositoryRuntimeInventory(
    selection.runOn,
    selection.runtime.harness,
  );
  const resolved = catalog.resolve({ ...selection.runtime, mode: 'agent' });
  if (
    resolved.status !== 'compatible' ||
    resolved.binding.execution.location !== selection.runOn ||
    !isDeepStrictEqual(resolved.binding.account, {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    })
  )
    throw unavailable();
  profiles.resumeRouting(binding);
  if (requireModelReadiness) profiles.validateModelSelection(binding, binding.model);
  const proof = OrdinaryRepositoryPreparationSchema.parse({
    version: 1,
    originalBinding: binding,
    runtimeBinding: resolved.binding,
    credentialDigest: await credentialDigest(binding, selection, signal),
  });
  signal.throwIfAborted();
  // Re-resolve after credential waits; a prior projection is not a final fence.
  const current = ordinaryRepositoryRuntimeInventory(
    selection.runOn,
    selection.runtime.harness,
  ).catalog.resolve({ ...selection.runtime, mode: 'agent' });
  if (current.status !== 'compatible' || !isDeepStrictEqual(current.binding, proof.runtimeBinding))
    throw unavailable();
  return proof;
}
export async function assertOrdinaryRepositoryPreparation(
  raw: OrdinaryRepositoryPreparation,
  binding: AccountBinding,
  signal: AbortSignal,
  requireModelReadiness = false,
  selection?: Pick<
    import('@mitzo/protocol').OrdinaryWorkspaceSettings['selection'],
    'model' | 'thinking'
  >,
) {
  const saved = OrdinaryRepositoryPreparationSchema.parse(raw);
  if (
    !isDeepStrictEqual(
      { ...saved.originalBinding, accountLabel: binding.accountLabel, model: binding.model },
      binding,
    )
  )
    throw unavailable();
  // Explicit ordinary V2 selections qualify exact thinking before allocation.
  // Legacy callers without this extra tuple retain their existing behavior.
  const assertSelectionCurrent = () => {
    if (!selection) return;
    if (!requireModelReadiness || selection.model !== binding.model) throw unavailable();
    const profiles = loadAccountProfiles();
    profiles.validateModelSelection(binding, selection.model, selection.thinking);
    const model = profiles
      .catalog()
      .find((account) => account.id === binding.accountId)
      ?.models.find((model) => model.id === selection.model);
    if (!model || (selection.thinking === null && model.reasoningEfforts?.length))
      throw unavailable();
  };
  assertSelectionCurrent();
  const current = await captureOrdinaryRepositoryPreparation(
    binding,
    {
      runOn: saved.runtimeBinding.execution.location,
      runtime: {
        account: saved.runtimeBinding.account,
        harness: saved.runtimeBinding.harness.implementation,
        targetId: saved.runtimeBinding.execution.targetId,
      },
    },
    signal,
    requireModelReadiness,
  );
  if (
    !isDeepStrictEqual(current.runtimeBinding, saved.runtimeBinding) ||
    current.credentialDigest !== saved.credentialDigest
  )
    throw unavailable();
  assertSelectionCurrent();
}

/** Read-only requalification for silent allocation; API/SDK queue preparation and
 * native recipes remain unavailable. The existing account/runtime custody owner
 * is the authority, with model readiness rechecked before recording allocation. */
export async function assertOrdinarySilentPreparationAuthority(
  raw: OrdinaryRepositoryPreparation,
  binding: AccountBinding,
  settings: import('@mitzo/protocol').CollaborationSettings,
  signal: AbortSignal,
): Promise<void> {
  const selection = OrdinarySilentPreparationSelectionSchema.parse(settings);
  const proof = OrdinaryRepositoryPreparationSchema.parse(raw);
  if (
    !isDeepStrictEqual(proof.runtimeBinding, selection.binding) ||
    binding.model !== selection.selection.model
  )
    throw unavailable();
  await assertOrdinaryRepositoryPreparation(proof, binding, signal, true);
}
