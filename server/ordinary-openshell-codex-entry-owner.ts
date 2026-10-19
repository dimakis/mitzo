import { assertOrdinaryCodexContextIdentity } from './ordinary-codex-agent-context.js';
import { readOrdinaryCodexAgentProfile } from './ordinary-codex-agent-profile.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { measureHostCodexExecutable } from './frozen-host-codex-executable.js';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import {
  reviewedConnectionsRuntimeImplementationRevision,
  reviewedHandlerSourceArtifacts,
} from './connections/reviewed-handler-artifacts.js';
import { SUPPORTED_CODEX_CLI_VERSION } from './codex-app-server-client.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { readBoundedFile } from './bounded-file-read.js';
import { loadAccountProfiles } from './account-profiles.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { getAgentLibrary } from './agent-library-runtime.js';
import { getRepositoryWorkspaces } from './repository-workspace-runtime.js';
import { openAIAccountKeyAuthority } from './openai-account-key-authority.js';
import { permissionRevision } from './session-permission-revision.js';
import {
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
  assertOrdinaryOpenShellCodexRoute,
} from './ordinary-openshell-codex-route.js';
import {
  OpenShellRuntimeManager,
  openShellRuntimeConfig,
  verifiedOpenShellPolicy,
  verifiedOpenShellSeed,
} from './openshell-runtime.js';
import { assertOrdinaryOpenShellPhysicalOwner } from './openshell-lifecycle-controller.js';
import {
  OrdinaryOpenShellCodexOwnedRuntime,
  type OrdinaryOpenShellCodexOwnedDispatch,
} from './ordinary-openshell-codex-owned-runtime.js';
import type { ArtifactRuntime, CodexConversationStore } from './codex-conversation-store.js';
import type { OrdinaryOpenShellCodexExpectation } from './owned-openshell-codex-chat-admission.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';

const unavailable = () => new Error('Ordinary OpenShell Codex entry unavailable');
const Declaration = z.strictObject({
  version: z.literal(1),
  targetId: z.string().min(1).max(200).regex(/^\S+$/),
  runtimeContractRevision: z.string().min(1).max(200).regex(/^\S+$/),
  openaiApi: z.enum(['enabled', 'disabled']),
});
export function ordinaryOpenShellCodexContractRevision(
  config: import('./openshell-runtime.js').OpenShellRuntimeConfig,
  cliSha256: string,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'ordinary-openshell-codex-owner-v1',
        reviewedConnectionsRuntimeImplementationRevision,
        Object.entries(reviewedHandlerSourceArtifacts).sort(([a], [b]) => a.localeCompare(b)),
        SUPPORTED_CODEX_CLI_VERSION,
        cliSha256,
        config.image,
        config.seedStackManifest,
      ]),
    )
    .digest('hex');
}
/** Operator-owned target declaration supplements the existing OpenShell config.
 * Neither clients nor agent files can choose a CLI, gateway or credential route.
 */
export function loadOrdinaryOpenShellCodexTarget(env: NodeJS.ProcessEnv = process.env) {
  const path = env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE;
  if (path === undefined) return undefined;
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw unavailable();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid!()) ||
      stat.nlink !== 1n ||
      (stat.mode & 0o777n) !== 0o600n
    )
      throw unavailable();
    const declaration = Declaration.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(fd, 65536))),
    );
    if (realpathSync(path) !== path) throw unavailable();
    for (const current of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
      for (const field of [
        'dev',
        'ino',
        'size',
        'mtimeNs',
        'ctimeNs',
        'uid',
        'mode',
        'nlink',
      ] as const)
        if (current[field] !== stat[field]) throw unavailable();
    const config = openShellRuntimeConfig(env);
    if (
      !config ||
      env.MITZO_OPENSHELL_SANDBOX_NAME ||
      (declaration.openaiApi === 'enabled' && env.MITZO_OPENSHELL_OPENAI_API_ENABLED === '0')
    )
      throw unavailable();
    if (!isAbsolute(config.cli) || !config.seedStackManifest) throw unavailable();
    const measurement = measureHostCodexExecutable(config.cli);
    verifiedOpenShellPolicy(config);
    verifiedOpenShellSeed(config);
    if (
      declaration.runtimeContractRevision !==
      ordinaryOpenShellCodexContractRevision(config, measurement.sha256)
    )
      throw unavailable();
    measurement.assertCurrent();
    registerWorkspaceRuntimeAuthorityPaths([path, config.cli, config.policy, config.seed], [path]);
    return {
      config,
      declaration,
      target: ordinaryOpenShellCodexTarget({ ...declaration, config }),
    };
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Actual owning configuration/account/operator/workspace composition. Only
 * read-only metadata/provider diagnostics run during qualification; the existing
 * runtime manager and Codex adapter retain sandbox/native continuation ownership.
 */
export function createOrdinaryOpenShellCodexEntryOwner(input: {
  events: EventStore;
  nativeStore: CodexConversationStore;
  resume?: boolean;
  account: AccountBinding;
  selectedModel?: string;
  sessionId: string;
  workspaceId: string;
  taskRoot: string;
  operatorConnectionId: string;
  signal: AbortSignal;
  readRetained(): ArtifactRuntime | undefined;
  dispatch(input: OrdinaryOpenShellCodexOwnedDispatch): Promise<void>;
  dispatchContinuation(input: OrdinaryOpenShellCodexOwnedDispatch): Promise<void>;
  close(): void;
}) {
  if (
    process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1' ||
    custodianControllerMode ||
    custodianOwnerMode
  )
    throw unavailable();
  input.signal.throwIfAborted();
  if (input.resume && !hasPersistentRevocationAuthority()) throw unavailable();
  if (
    !input.resume &&
    input.nativeStore.hasConversation(input.sessionId) &&
    !input.events.getSessionRuntimeBinding(input.sessionId)
  )
    throw unavailable();
  const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
  const configured = loadOrdinaryOpenShellCodexTarget();
  if (!configured) throw unavailable();
  const profiles = loadAccountProfiles();
  const configuredAccount = profiles.resolve(
    input.account.accountId,
    input.selectedModel ?? input.account.model,
  );
  if (
    configuredAccount.provider !== input.account.provider ||
    configuredAccount.profileRevision !== input.account.profileRevision
  )
    throw unavailable();
  const projection = projectOrdinaryOpenShellCodexCapabilities({
    profiles,
    target: configured.target,
    deployment: 'ordinary',
  });
  const workspace = getRepositoryWorkspaces(true);
  const originalWorkspace = workspace.get(input.workspaceId);
  const permission = permissionRevision(input.events, input.sessionId);
  const retainedAbort = new AbortController();
  const retainedAuthority = retainAgentContextAuthority({ ...captured.auth }, retainedAbort);
  const signal = AbortSignal.any([input.signal, retainedAbort.signal]);
  const retainedDriver: { current?: OrdinaryOpenShellCodexOwnedRuntime } = {};
  const onOwnedAbort = () => {
    retainedDriver.current?.close();
  };
  signal.addEventListener('abort', onOwnedAbort, { once: true });
  const onAbort = () => retainedAbort.abort(input.signal.reason);
  input.signal.addEventListener('abort', onAbort, { once: true });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    input.signal.removeEventListener('abort', onAbort);
    signal.removeEventListener('abort', onOwnedAbort);
    retainedAuthority.release();
    input.close();
  };
  let providerExpiresAt = 0;
  const assertCurrentIdentitySync = (expected: OrdinaryOpenShellCodexExpectation) => {
    signal.throwIfAborted();
    retainedAuthority.assertCurrent();
    if (
      process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1' ||
      custodianControllerMode ||
      custodianOwnerMode ||
      permissionRevision(input.events, input.sessionId) !== permission ||
      expected.selection.permission.revision !== 0
    )
      throw unavailable();
    const current = loadOrdinaryOpenShellCodexTarget();
    const currentProfiles = loadAccountProfiles();
    if (!current || !isDeepStrictEqual(current.target, configured.target)) throw unavailable();
    const currentProjection = projectOrdinaryOpenShellCodexCapabilities({
      profiles: currentProfiles,
      target: current.target,
      deployment: 'ordinary',
    });
    if (
      !currentProjection.inventory.accounts.some((account) =>
        isDeepStrictEqual(account.account, expected.binding.account),
      )
    )
      throw unavailable();
    if (
      !expected.agentProfile ||
      !isDeepStrictEqual(
        readOrdinaryCodexAgentProfile(getAgentLibrary(), expected.selection.agent),
        expected.agentProfile,
      ) ||
      expected.agentProfile.definition.contextRecipe?.source === 'packs'
    )
      throw unavailable();
    assertOrdinaryCodexContextIdentity(
      expected.agentProfile,
      expected.selection,
      expected.agentContext,
      expected.binding.account.provider,
    );
    const record = workspace.get(input.workspaceId);
    if (
      !isDeepStrictEqual(record.binding, input.account) ||
      record.baseOid !== originalWorkspace.baseOid ||
      record.sourceDigest !== originalWorkspace.sourceDigest ||
      record.featureBranch !== originalWorkspace.featureBranch ||
      record.connectionId !== originalWorkspace.connectionId ||
      record.connectionRevision !== originalWorkspace.connectionRevision ||
      !['ready', 'claimed'].includes(record.state) ||
      (record.state === 'claimed' && (record.conversationId !== input.sessionId || !record.sandbox))
    )
      throw unavailable();
    if (
      input.account.provider === 'openai-codex' &&
      providerExpiresAt &&
      Date.now() >= providerExpiresAt
    )
      throw unavailable();
    const retained = input.readRetained();
    if (retained) assertOrdinaryOpenShellPhysicalOwner(input.sessionId, retained, input.account);
  };
  const assertCurrentSync = (expected: OrdinaryOpenShellCodexExpectation) => {
    assertCurrentIdentitySync(expected);
    assertOrdinaryOpenShellCodexRoute({
      binding: expected.binding,
      account: input.account,
      profiles: loadAccountProfiles(),
      catalog: projection.catalog,
      target: configured.target,
      model: expected.selection.model,
      reasoningEffort: expected.selection.thinking,
      mode: expected.selection.permission.mode,
    });
  };
  const assertCurrent = async (expected: OrdinaryOpenShellCodexExpectation) => {
    assertCurrentSync(expected);
    const route = assertOrdinaryOpenShellCodexRoute({
      binding: expected.binding,
      account: input.account,
      profiles: loadAccountProfiles(),
      catalog: projection.catalog,
      target: configured.target,
      model: expected.selection.model,
      reasoningEffort: expected.selection.thinking,
      mode: expected.selection.permission.mode,
    });
    if (route.kind === 'chatgpt-subscription') {
      const manager = new OpenShellRuntimeManager({
        ...configured.config,
        account: route,
        connectionAccountId: input.account.accountId,
      });
      providerExpiresAt = await manager.verifySubscriptionSignIn(signal);
      if (Date.now() >= providerExpiresAt) throw unavailable();
    } else {
      const currentProfiles = loadAccountProfiles();
      const profile = currentProfiles.apiRoutingProfile(input.account);
      if (!profile.sandboxProviderId) throw unavailable();
      const authority = openAIAccountKeyAuthority(input.account, currentProfiles);
      await authority.assertReady(signal);
      const manager = new OpenShellRuntimeManager({
        ...configured.config,
        account: route,
        connectionAccountId: input.account.accountId,
      });
      await manager.verifyAPIAccountProvider(profile.sandboxProviderId, signal);
      await authority.assertReady(signal);
    }
    const artifact = input.readRetained();
    if (artifact) {
      const manager = new OpenShellRuntimeManager({
        ...configured.config,
        account: route,
        connectionAccountId: input.account.accountId,
        sandboxNameOverride: artifact.runtime.sandboxName,
      });
      const physical = await manager.inspect(
        input.sessionId,
        artifact.runtime.sandboxId,
        signal,
        artifact.runtime.sandboxName,
      );
      if (!physical || physical.phase !== 'Ready') throw unavailable();
    }
    assertCurrentSync(expected);
    const record = workspace.get(input.workspaceId);
    if (record.state === 'claimed' && !record.sourceReleased)
      await workspace.startupSeed(input.workspaceId, input.account, input.sessionId, signal);
    assertCurrentSync(expected);
  };
  const capabilitiesCurrent = () => {
    const target = loadOrdinaryOpenShellCodexTarget();
    if (!target || !isDeepStrictEqual(target.target, configured.target)) throw unavailable();
    const profiles = loadAccountProfiles();
    return {
      profiles,
      projection: projectOrdinaryOpenShellCodexCapabilities({
        profiles,
        target: target.target,
        deployment: 'ordinary',
      }),
    };
  };
  const driver = new OrdinaryOpenShellCodexOwnedRuntime({
    enabled: true,
    resume: input.resume,
    nativeStore: input.nativeStore,
    authSessionId: captured.auth.id,
    events: input.events,
    profiles,
    workspace,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    taskRoot: input.taskRoot,
    target: configured.target,
    config: configured.config,
    projection,
    capabilitiesCurrent,
    account: input.account,
    assertCurrentSync,
    assertCurrentIdentitySync,
    assertCurrent,
    readRetained: input.readRetained,
    assertRetainedAuthority: (artifact) =>
      assertOrdinaryOpenShellPhysicalOwner(input.sessionId, artifact, input.account),
    dispatch: input.dispatch,
    dispatchContinuation: input.dispatchContinuation,
    signal,
    close: release,
  });
  retainedDriver.current = driver;
  return { driver, inventory: projection.inventory, authSessionId: captured.auth.id };
}
