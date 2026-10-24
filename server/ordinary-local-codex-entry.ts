import { dispatchOwnedOrdinaryCommand } from './ordinary-scoped-command.js';
import { context, trace } from '@opentelemetry/api';
import { contextFromTraceparent } from './trace-context.js';
import { startCommandTimingSpan, finishCommandTimingSpan } from './command-timing-trace.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { sessionHarnessForProvider } from './session-harness-routing.js';
import { prepareDefaultOpenShellCommand } from './ordinary-openshell-default-workspace.js';
import { ordinaryWorkspaceTaskRoot } from './ordinary-workspace-runtime.js';
import type { OrdinaryWorkspaceRecord } from './ordinary-workspace-custody.js';
import {
  assertOrdinaryHistoricalAcknowledgement,
  assertOrdinaryWorkspaceHistoricalAcknowledgement,
} from './ordinary-command-historical-ack.js';
import {
  OrdinaryLocalVertexTarget,
  localVertexCapabilities,
} from './ordinary-local-vertex-capabilities.js';
import { canResumeOwnedLocalVertexDriver } from './ordinary-local-vertex-entry.js';
import { assertOrdinaryCodexContextIdentity } from './ordinary-codex-agent-context.js';
import {
  readOrdinaryCodexAgentProfile,
  ordinaryCodexAgentProfiles,
  ordinaryCodexAgentProfileRouteProjection,
} from './ordinary-codex-agent-profile.js';
import { composeOrdinaryRuntimeCapabilities } from './ordinary-runtime-capability-composition.js';
import {
  OrdinaryLocalResponsesTarget,
  localResponsesCapabilities,
  newLocalResponsesCapabilities,
} from './ordinary-local-responses-capabilities.js';
import { canResumeOwnedLocalResponsesDriver } from './chat.js';
import { createHash, randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Router } from 'express';
import {
  ORDINARY_COMMAND_STARTUP_TIMEOUT_MS,
  OrdinaryCodexFirstCommandSchema,
  OrdinaryWorkspaceFirstCommandSchema,
  OrdinaryWorkspaceContinuationCommandSchema,
  LocalCodexFirstCommandSchema,
  LocalCodexContinuationCommandSchema,
  OrdinaryRuntimeFirstCommandSchema,
  OrdinaryRuntimeContinuationCommandSchema,
  type AccountBinding,
  type SessionRuntimeBindingV2,
} from '@mitzo/protocol';
export { LocalCodexFirstCommandSchema, type LocalCodexFirstCommand } from '@mitzo/protocol';
import { operatorAuthMiddleware, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import {
  bindAgentLibraryTransport,
  captureAgentLibraryAuthorization,
} from './agent-library-transport.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { loadAccountProfiles } from './account-profiles.js';
import { getAgentLibrary } from './agent-library-runtime.js';
import {
  getRepositoryWorkspaces,
  getOrdinaryWorkspaces,
  getLocalRepositoryWorkspaces,
} from './repository-workspace-runtime.js';
import {
  OrdinaryLocalCodexCapabilityCatalog,
  loadOrdinaryLocalCodexTarget,
} from './ordinary-local-codex-capabilities.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import { BASE_REPO, detachChatIfCurrentTransport, canResumeOwnedLocalCodexDriver } from './chat.js';
import { loadOrdinaryOpenShellCodexTarget } from './ordinary-openshell-codex-entry-owner.js';
import { projectOrdinaryOpenShellCodexCapabilities } from './ordinary-openshell-codex-route.js';
import { resolveOrdinarySessionRuntime } from './ordinary-session-runtime.js';
import { canResumeOwnedOpenShellCodexDriver } from './ordinary-openshell-codex-entry.js';
import { createLogger } from './logger.js';
import { nativeStartupSessionId, reserveRepositoryStartup } from './ordinary-repository-startup.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import type { SessionSseRegistry } from './session-sse-registry.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

const unavailable = 'Local Codex entry unavailable';
const log = createLogger('local-codex-entry');

/** Pure configured projection. Every dispatch still qualifies the actual host/account. */
function inventory(
  location: 'local' | 'openshell' = 'local',
  harness: 'codex' | 'responses' | 'claude-sdk' | 'gemini' = 'codex',
  retainedBinding?: SessionRuntimeBindingV2,
) {
  const profiles = loadAccountProfiles();
  if (harness === 'claude-sdk') {
    if (
      location !== 'local' ||
      process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED !== '1' ||
      !process.env.MITZO_ACCOUNT_PROFILES_FILE
    )
      throw Error(unavailable);
    const catalog = localVertexCapabilities(
      profiles,
      new OrdinaryLocalVertexTarget(),
      getAgentLibrary().list('user').versions,
    );
    return { profiles, catalog, result: catalog.inventory() };
  }
  if (harness === 'responses' || harness === 'gemini') {
    if (
      location !== 'local' ||
      (harness === 'gemini'
        ? process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED
        : process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED) !== '1'
    )
      throw Error(unavailable);
    const source = (retainedBinding ? localResponsesCapabilities : newLocalResponsesCapabilities)(
      profiles,
      new OrdinaryLocalResponsesTarget(process.env, harness),
    );
    const catalog = {
      inventory: source.inventory,
      resolve(request: unknown) {
        const result = source.resolve(request);
        return retainedBinding &&
          result.status === 'compatible' &&
          !isDeepStrictEqual(result.binding, retainedBinding)
          ? { status: 'rejected' as const, code: 'account_identity_mismatch' as const }
          : result;
      },
    };
    return { profiles, catalog, result: catalog.inventory() };
  }
  if (location === 'openshell') {
    if (process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1') throw Error(unavailable);
    const configured = loadOrdinaryOpenShellCodexTarget();
    if (!configured) throw Error(unavailable);
    const projection = projectOrdinaryOpenShellCodexCapabilities({
      profiles,
      target: configured.target,
      deployment: 'ordinary',
    });
    return {
      profiles,
      agentContextPresets: configured.config.agentContextPresets,
      catalog: {
        inventory: () => projection.inventory,
        resolve: (request: unknown) => resolveOrdinarySessionRuntime(request, projection.catalog),
      },
      result: {
        ...projection.inventory,
        targets: [
          {
            targetId: configured.target.targetId,
            targetRevision: configured.target.targetRevision,
            label: 'OpenShell',
            location: 'openshell' as const,
            harness: 'codex' as const,
          },
        ],
        locations: [
          {
            location: 'openshell' as const,
            status: projection.inventory.routes.length
              ? ('configured' as const)
              : ('unavailable' as const),
            ...(projection.inventory.routes.length
              ? {}
              : { reason: 'No compatible OpenShell account is configured.' }),
          },
        ],
      },
    };
  }
  const target = loadOrdinaryLocalCodexTarget();
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(profiles, target, 'ordinary');
  const result = catalog.inventory();
  result.accounts = result.accounts.filter(({ account, models }) => {
    try {
      const selected = profiles.localCodexProfile(
        profiles.resolve(account.accountId, models[0]?.id),
      );
      return selected.workspaceId === undefined && selected.nativeAuth === undefined;
    } catch {
      return false;
    }
  });
  const accounts = new Set(result.accounts.map(({ account }) => JSON.stringify(account)));
  result.routes = result.routes.filter(({ account }) => accounts.has(JSON.stringify(account)));
  if (!result.routes.length)
    result.locations = result.locations.map((location) =>
      location.location === 'local'
        ? { location: 'local', status: 'unavailable', reason: 'accounts_unavailable' }
        : location,
    );
  return { profiles, catalog, result, agentContextPresets: undefined };
}

export const ordinaryRepositoryRuntimeInventory = inventory;

/** Composes the accepted projections; never creates another selection registry. */
export function ordinaryCodexCapabilities() {
  const availableInventory = (
    location: 'local' | 'openshell',
    harness: 'codex' | 'responses' | 'claude-sdk' | 'gemini' = 'codex',
  ) => {
    try {
      return inventory(location, harness).result;
    } catch {
      // An unavailable route must not hide another configured environment.
      return undefined;
    }
  };
  const local =
    process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED === '1'
      ? availableInventory('local')
      : undefined;
  const responses =
    process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED === '1'
      ? availableInventory('local', 'responses')
      : undefined;
  const vertex =
    process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED === '1'
      ? availableInventory('local', 'claude-sdk')
      : undefined;
  const gemini =
    process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED === '1'
      ? availableInventory('local', 'gemini')
      : undefined;
  const shell =
    process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED === '1'
      ? availableInventory('openshell')
      : undefined;
  const { accounts, routes } = composeOrdinaryRuntimeCapabilities(
    [local, shell, responses, vertex, gemini].map(
      (source) =>
        source && {
          ...source,
          routes: source.routes.map((route) => {
            const candidates = source.targets.filter(
              (target) => target.targetId === route.targetId && target.harness === route.harness,
            );
            if (candidates.length !== 1) throw Error(unavailable);
            return { ...route, location: candidates[0].location };
          }),
        },
    ),
  );
  const result = {
    version: 1,
    authority: 'configuration-only',
    defaultLocation: 'openshell',
    defaultLocalRepository: !!BASE_REPO && isAbsolute(BASE_REPO),
    capabilityRevision: createHash('sha256')
      .update(
        JSON.stringify([
          local?.capabilityRevision ?? null,
          shell?.capabilityRevision ?? null,
          responses?.capabilityRevision ?? null,
          vertex?.capabilityRevision ?? null,
          gemini?.capabilityRevision ?? null,
        ]),
      )
      .digest('hex'),
    accounts,
    targets: [
      ...(local?.targets ?? []),
      ...(shell?.targets ?? []),
      ...(responses?.targets ?? []),
      ...(vertex?.targets ?? []),
      ...(gemini?.targets ?? []),
    ],
    routes,
    locations: [
      [local, responses, vertex, gemini]
        .find((source) =>
          source?.locations.some(
            (entry) => entry.location === 'local' && entry.status === 'configured',
          ),
        )
        ?.locations.find((entry) => entry.location === 'local') ??
        local?.locations.find((entry) => entry.location === 'local') ??
        responses?.locations[0] ??
        vertex?.locations[0] ??
        gemini?.locations[0] ?? {
          location: 'local',
          status: 'unavailable',
          reason: [
            process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED,
            process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED,
            process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED,
            process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED,
          ].includes('1')
            ? 'The configured Local Mac route is unavailable.'
            : 'Local Mac is not enabled.',
        },
      shell?.locations[0] ?? {
        location: 'openshell',
        status: 'unavailable',
        reason:
          process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED === '1'
            ? 'The configured OpenShell route is unavailable.'
            : 'OpenShell is not enabled.',
      },
    ],
  };
  if (result.accounts.length > 64 || Buffer.byteLength(JSON.stringify(result), 'utf8') > 1048576)
    throw Error(unavailable);
  return result;
}

/** Mounted inside the existing authenticated chat router. No legacy send claim or fallback. */
function createOwnedCodexEntryRouter(
  sse: SessionSseRegistry,
  ctx: Pick<V2HandlerContext, 'connRegistry' | 'sessionRegistry' | 'eventStore'>,
  general = false,
  ordinary = false,
): Router {
  const router = Router();
  const unavailable = general
    ? 'Conversation runtime unavailable'
    : 'Local Codex entry unavailable';
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      (process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' &&
        ((!general && !ordinary) ||
          (process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1' &&
            process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED !== '1' &&
            process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED !== '1' &&
            process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED !== '1'))) ||
      custodianControllerMode ||
      custodianOwnerMode
    )
      return res.status(503).json({ ok: false, code: 'entry_disabled', error: unavailable });
    next();
  });
  router.use(operatorAuthMiddleware);
  router.get('/capabilities', (req, res) => {
    try {
      const auth = res.locals.authSession as AuthSession | undefined;
      if (!auth || auth.expiresAt <= Date.now())
        return res
          .status(401)
          .json({ ok: false, code: 'interactive_auth_required', error: unavailable });
      let result = general ? ordinaryCodexCapabilities() : inventory().result;
      let retainedAccount: SessionRuntimeBindingV2['account'] | undefined;
      if (general && req.query?.sessionId !== undefined) {
        const sessionId = req.query.sessionId;
        if (typeof sessionId !== 'string' || !/^\S{1,200}$/.test(sessionId))
          throw Error(unavailable);
        const binding = ctx.eventStore.getSessionRuntimeBinding(sessionId);
        const meta = ctx.eventStore.getSession(sessionId);
        // Prepared first commands may have workspace metadata before an event
        // binding exists. They keep the strict new-work projection above.
        if (binding?.version === 2 && binding.harness.implementation === 'responses') {
          if (!meta) throw Error(unavailable);
          const live = ctx.sessionRegistry.findBySessionId(sessionId)?.session;
          if (
            binding.execution.location !== 'local' ||
            (live
              ? live.ordinaryRuntimeOwner?.authSessionId !== auth.id ||
                live.ordinaryRuntimeOwner?.location !== 'local'
              : !canResumeOwnedLocalResponsesDriver(sessionId, auth.id))
          )
            throw Error(unavailable);
          const retained = inventory('local', 'responses', binding);
          if (
            retained.catalog.resolve({
              account: binding.account,
              harness: 'responses',
              targetId: binding.execution.targetId,
              mode: meta.mode,
            }).status !== 'compatible'
          )
            throw Error(unavailable);
          // Read-only metadata for this exact saved owner; new admission still
          // rejects Responses even if a client copies this retained revision.
          const projected = retained.result;
          retainedAccount = binding.account;
          result = projected;
        }
      }
      const agentProfiles = ordinaryCodexAgentProfiles(getAgentLibrary().list('user').versions);
      let shell: ReturnType<typeof loadOrdinaryOpenShellCodexTarget>;
      if (
        general &&
        result.routes.some((route) => 'location' in route && route.location === 'openshell')
      ) {
        try {
          shell = loadOrdinaryOpenShellCodexTarget();
        } catch {
          // A stale preset declaration must not erase another environment's inventory.
          // OpenShell recipes remain unavailable without their exact preset authority.
        }
      }
      const response = {
        ...result,
        accounts: result.accounts.filter(
          (entry) => !retainedAccount || isDeepStrictEqual(entry.account, retainedAccount),
        ),
        ...(req.query?.workspaceDefaults === '1'
          ? {
              defaultOpenShellWorkspace: result.routes.some(
                (route) =>
                  'location' in route &&
                  route.location === 'openshell' &&
                  route.harness === 'codex',
              ),
            }
          : {}),
        agentProfiles,
        routes: result.routes
          .filter((route) => !retainedAccount || isDeepStrictEqual(route.account, retainedAccount))
          .map((route) => {
            const location = 'location' in route ? route.location : 'local';
            const candidates = result.targets.filter(
              (target) =>
                target.targetId === route.targetId &&
                target.location === location &&
                target.harness === route.harness,
            );
            if (candidates.length !== 1) throw Error(unavailable);
            const target = candidates[0];
            const presets =
              target?.location === 'openshell' &&
              shell?.target.targetId === target.targetId &&
              shell?.target.targetRevision === target.targetRevision
                ? shell.config.agentContextPresets
                : undefined;
            return {
              ...route,
              ...ordinaryCodexAgentProfileRouteProjection(
                agentProfiles,
                route.account.provider,
                target.location,
                presets,
                ['responses', 'gemini', 'claude-sdk', 'codex'].includes(route.harness)
                  ? {
                      contextRecipes: route.harness === 'codex' ? 'supported' : 'none',
                      toolSelection:
                        ['responses', 'gemini', 'codex'].includes(route.harness) &&
                        target.location === 'local',
                      toolRoute: route.harness === 'codex' ? 'codex-owned-local' : 'local-api',
                    }
                  : undefined,
              ),
            };
          }),
      };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1048576) throw Error(unavailable);
      return res.json(response);
    } catch {
      return res.status(409).json({ ok: false, code: 'entry_unavailable', error: unavailable });
    }
  });
  const executeCommand =
    (continuation: boolean, observeOnly = false): import('express').RequestHandler =>
    async (req, res) => {
      // Workspace normalization and provider startup consume the same request
      // budget. A second phase must not restart the clock after preparation.
      const startupDeadline = performance.now() + ORDINARY_COMMAND_STARTUP_TIMEOUT_MS;
      const abortAtStartupDeadline = (controller: AbortController) => {
        const remaining = Math.max(0, startupDeadline - performance.now());
        if (remaining === 0) controller.abort();
        return setTimeout(() => controller.abort(), remaining);
      };
      const auth = res.locals.authSession as AuthSession | undefined;
      const connectionId = req.headers['x-connection-id'];
      const transport =
        typeof connectionId === 'string'
          ? ctx.connRegistry.get(connectionId)?.transport
          : undefined;
      if (!auth || auth.expiresAt <= Date.now())
        return res
          .status(401)
          .json({ ok: false, code: 'interactive_auth_required', error: unavailable });
      if (
        typeof connectionId !== 'string' ||
        !sse.isOpen(connectionId) ||
        !sse.isOwnedBy(connectionId, auth.id) ||
        !transport?.isOpen() ||
        liveTransportAuthSessionId(connectionId) !== auth.id
      )
        return res
          .status(403)
          .json({ ok: false, code: 'connection_unavailable', error: unavailable });
      const parsed = (
        ordinary
          ? continuation
            ? OrdinaryWorkspaceContinuationCommandSchema
            : OrdinaryWorkspaceFirstCommandSchema
          : general
            ? continuation
              ? OrdinaryRuntimeContinuationCommandSchema
              : OrdinaryRuntimeFirstCommandSchema
            : continuation
              ? LocalCodexContinuationCommandSchema
              : LocalCodexFirstCommandSchema
      ).safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({
          ok: false,
          code: 'invalid_request',
          error: general ? 'Invalid conversation command' : 'Invalid local first command',
        });
      let input = structuredClone(parsed.data);
      const automaticLocalRepository =
        !ordinary &&
        !continuation &&
        input.runOn === 'local' &&
        (!('repositoryWorkspaceId' in input) || input.repositoryWorkspaceId === undefined);
      if (automaticLocalRepository) {
        const id =
          ctx.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)?.workspace.workspaceId ||
          nativeStartupSessionId(
            `local-repository:${auth.id}:${input.runtime.account.accountId}:${input.clientMsgId}`,
          );
        // Normalize through the same public shape so exact retries retain the
        // original canonical reservation and command fingerprints.
        input = (general ? OrdinaryRuntimeFirstCommandSchema : LocalCodexFirstCommandSchema).parse({
          ...input,
          repositoryWorkspaceId: id,
        });
      }
      let ordinaryInput = ordinary ? OrdinaryWorkspaceFirstCommandSchema.parse(input) : undefined;
      const defaultOpenShell =
        !ordinary &&
        general &&
        !continuation &&
        input.runOn === 'openshell' &&
        !('repositoryWorkspaceId' in input && input.repositoryWorkspaceId);
      if (defaultOpenShell) {
        const receipt = ctx.eventStore.getOrdinaryCommandAdmission(input.clientMsgId);
        if (observeOnly || receipt) {
          const send = ctx.eventStore.getSendCommand(input.clientMsgId);
          const meta = send?.sessionId ? ctx.eventStore.getSession(send.sessionId) : undefined;
          if (
            !receipt ||
            !send ||
            !meta?.ordinaryWorkspaceId ||
            meta.repositoryWorkspaceId != null ||
            receipt.workspace.workspaceId !== meta.ordinaryWorkspaceId
          )
            return res
              .status(409)
              .json({ ok: false, code: 'receipt_pending', clientMsgId: input.clientMsgId });
          // Recover only retained identity. Creating-login allocation provenance
          // comes from its original durable owners, never the current login.
          ordinaryInput = OrdinaryWorkspaceFirstCommandSchema.parse({
            ...input,
            version: 2,
            sessionId: send.sessionId,
            workspace: { kind: 'ordinary', workspaceId: meta.ordinaryWorkspaceId },
          });
          input = ordinaryInput;
        }
      }
      if (
        !observeOnly &&
        !ordinaryInput &&
        !ordinary &&
        general &&
        !continuation &&
        input.runOn === 'openshell' &&
        !('repositoryWorkspaceId' in input && input.repositoryWorkspaceId)
      ) {
        const controller = new AbortController();
        let authority: ReturnType<typeof retainAgentContextAuthority> | undefined;
        const timer = abortAtStartupDeadline(controller);
        try {
          const captured = captureAgentLibraryAuthorization(connectionId);
          captured.assertCurrent();
          if (captured.auth.id !== auth.id) throw Error(unavailable);
          authority = retainAgentContextAuthority({ ...captured.auth }, controller);
          const request = OrdinaryCodexFirstCommandSchema.parse(input);
          ordinaryInput = await prepareDefaultOpenShellCommand({
            input: request,
            authSessionId: auth.id,
            workspaces: getOrdinaryWorkspaces(),
            events: ctx.eventStore,
            taskRoot: () => ordinaryWorkspaceTaskRoot(true),
            signal: controller.signal,
            qualify: () => {
              authority!.assertCurrent();
              const { profiles, catalog, result, agentContextPresets } = inventory('openshell');
              const resolved = catalog.resolve(request.runtime);
              const account = result.accounts.find((a) =>
                isDeepStrictEqual(a.account, request.runtime.account),
              );
              const model = account?.models.find((m) => m.id === request.selection.model);
              const profile = readOrdinaryCodexAgentProfile(
                getAgentLibrary(),
                request.selection.agent,
              );
              if (
                result.capabilityRevision !== request.capabilityRevision ||
                resolved.status !== 'compatible' ||
                !account ||
                account.modelDiscovery.stale ||
                !model ||
                !profile ||
                profile.definition.contextRecipe ||
                request.selection.context.source !== 'none' ||
                !result.routes.some(
                  (r) =>
                    isDeepStrictEqual(r.account, request.runtime.account) &&
                    r.targetId === request.runtime.targetId &&
                    r.modes.some((mode) => mode === request.runtime.mode),
                ) ||
                (request.selection.thinking === null
                  ? !!model.reasoningEfforts?.length
                  : !model.reasoningEfforts?.includes(request.selection.thinking)) ||
                ordinaryCodexAgentProfileRouteProjection(
                  [profile],
                  account.account.provider,
                  'openshell',
                  agentContextPresets,
                  {
                    contextRecipes: 'supported',
                    toolSelection: false,
                    toolRoute: 'codex-owned-local',
                  },
                ).agentProfileRejections.length
              )
                throw Error(unavailable);
              assertOrdinaryCodexContextIdentity(
                profile,
                request.selection,
                undefined,
                account.account.provider,
              );
              return {
                binding: profiles.resolve(
                  request.runtime.account.accountId,
                  request.selection.model,
                ),
                agentProfile: profile,
              };
            },
          });
          authority.assertCurrent();
          input = ordinaryInput;
        } catch {
          return res.status(409).json({ ok: false, code: 'entry_unavailable', error: unavailable });
        } finally {
          clearTimeout(timer);
          authority?.release();
        }
      }
      const repositoryWorkspaceId =
        'repositoryWorkspaceId' in input ? input.repositoryWorkspaceId : undefined;
      let ordinaryWorkspace: OrdinaryWorkspaceRecord | undefined;
      if (input.selection.context.source === 'packs')
        return res.status(409).json({
          ok: false,
          code: 'native_context_unavailable',
          error:
            'Reusable context packs require a trusted native continuation barrier; native Codex context admission is unavailable.',
        });
      if (
        (input.runOn === 'local'
          ? input.runtime.harness === 'claude-sdk'
            ? process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED
            : ['responses', 'gemini'].includes(input.runtime.harness)
              ? input.runtime.harness === 'gemini'
                ? process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED
                : process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED
              : process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED
          : process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED) !== '1'
      )
        return res.status(503).json({ ok: false, code: 'entry_disabled', error: unavailable });
      const sessionId = ordinaryInput
        ? ordinaryInput.sessionId
        : continuation
          ? (general
              ? OrdinaryRuntimeContinuationCommandSchema
              : LocalCodexContinuationCommandSchema
            ).parse(req.body).sessionId
          : nativeStartupSessionId(`repository:${repositoryWorkspaceId}`);
      const existingOwner = ctx.sessionRegistry.findBySessionId(sessionId);
      if (
        existingOwner &&
        !(input.runOn === 'local' && input.runtime.harness === 'codex'
          ? ordinaryOperatorOwnsConversation(existingOwner.session.ownedLocalAuthSessionId, auth.id)
          : existingOwner.session.ownedLocalAuthSessionId === auth.id)
      )
        return res
          .status(403)
          .json({ ok: false, code: 'connection_unavailable', error: unavailable });
      try {
        const captured = captureAgentLibraryAuthorization(connectionId);
        captured.assertCurrent();
        if (captured.auth.id !== auth.id) throw Error(unavailable);
        if (ordinaryInput) {
          ordinaryWorkspace = getOrdinaryWorkspaces(true).getOrdinaryWorkspace(
            ordinaryInput.workspace.workspaceId,
          );
          const meta = ctx.eventStore.getSession(sessionId);
          const prepared = ctx.eventStore.getOrdinaryWorkspaceSessionPreparation(
            ordinaryWorkspace.allocationOperationId,
          );
          if (
            ordinaryWorkspace.conversationId !== sessionId ||
            !meta ||
            meta.ordinaryWorkspaceId !== ordinaryWorkspace.id ||
            meta.repositoryWorkspaceId != null ||
            meta.isHidden ||
            meta.cwd !== ordinaryWorkspace.directory ||
            prepared?.sessionId !== sessionId ||
            prepared.workspaceId !== ordinaryWorkspace.id ||
            prepared.preparationFingerprint !== ordinaryWorkspace.preparationFingerprint
          )
            throw Error(unavailable);
        }
        if (
          ordinaryInput
            ? assertOrdinaryWorkspaceHistoricalAcknowledgement(
                ctx.eventStore,
                sessionId,
                auth.id,
                ordinaryInput,
                !continuation,
              )
            : assertOrdinaryHistoricalAcknowledgement(
                ctx.eventStore,
                sessionId,
                auth.id,
                (general
                  ? continuation
                    ? OrdinaryRuntimeContinuationCommandSchema
                    : OrdinaryRuntimeFirstCommandSchema
                  : continuation
                    ? LocalCodexContinuationCommandSchema
                    : LocalCodexFirstCommandSchema
                ).parse(input),
                !continuation,
              )
        ) {
          captured.assertCurrent();
          return res.status(202).json({
            ok: true,
            clientMsgId: input.clientMsgId,
            sessionId,
            dispatched: false,
            state: 'consumed',
          });
        }
      } catch {
        return res.status(409).json({
          ok: false,
          code: 'retained_command',
          error: unavailable,
          clientMsgId: input.clientMsgId,
          sessionId,
        });
      }
      // This endpoint observes exact durable acceptance only. In particular it
      // cannot reserve workspaces, bootstrap a provider or dispatch a retry.
      if (observeOnly)
        return res
          .status(409)
          .json({ ok: false, code: 'receipt_pending', clientMsgId: input.clientMsgId, sessionId });
      if (
        !continuation &&
        input.runtime.harness !== sessionHarnessForProvider(input.runtime.account.provider)
      )
        return res.status(409).json({
          ok: false,
          code: 'new_work_harness_unsupported',
          error: 'The selected account does not support this harness for new work.',
          clientMsgId: input.clientMsgId,
          sessionId,
        });
      const savedBinding = ctx.eventStore.getSessionRuntimeBinding(sessionId);
      const retainedRuntimeBinding = savedBinding?.version === 2 ? savedBinding : undefined;
      if (continuation) {
        const meta = ctx.eventStore.getSession(sessionId);
        const binding = retainedRuntimeBinding;
        if (
          (!existingOwner &&
            !(input.runOn === 'local'
              ? input.runtime.harness === 'claude-sdk'
                ? canResumeOwnedLocalVertexDriver(sessionId, auth.id)
                : ['responses', 'gemini'].includes(input.runtime.harness)
                  ? canResumeOwnedLocalResponsesDriver(sessionId, auth.id)
                  : canResumeOwnedLocalCodexDriver(sessionId, auth.id)
              : canResumeOwnedOpenShellCodexDriver(sessionId, auth.id))) ||
          !meta ||
          !binding ||
          (ordinaryInput
            ? meta.ordinaryWorkspaceId !== ordinaryInput.workspace.workspaceId ||
              meta.repositoryWorkspaceId != null
            : meta.repositoryWorkspaceId !== repositoryWorkspaceId ||
              meta.ordinaryWorkspaceId != null) ||
          binding.execution.location !== input.runOn ||
          binding.harness.implementation !== input.runtime.harness ||
          binding.version !== 2 ||
          binding.execution.targetId !== input.runtime.targetId ||
          !isDeepStrictEqual(binding.account, input.runtime.account)
        )
          return res
            .status(409)
            .json({ ok: false, code: 'bound_route_unavailable', error: unavailable });
      }
      const controller = new AbortController();
      let authority: ReturnType<typeof retainAgentContextAuthority> | undefined;
      let releaseBinding: (() => void) | undefined;
      let releaseStartup: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const captured = captureAgentLibraryAuthorization(connectionId);
        captured.assertCurrent();
        if (captured.auth.id !== auth.id) throw Error(unavailable);
        authority = retainAgentContextAuthority({ ...captured.auth }, controller);
        // Detach does not revoke login authority. This server-only binding survives
        // source preparation awaits; the driver separately retains the same subject.
        const operatorConnectionId = `owned-local-entry:${randomUUID()}`;
        releaseBinding = bindAgentLibraryTransport(operatorConnectionId, { ...captured.auth });
        releaseStartup = reserveRepositoryStartup(sessionId);
        timer = abortAtStartupDeadline(controller);
        authority.assertCurrent();
        const { profiles, catalog, result, agentContextPresets } = inventory(
          input.runOn,
          input.runtime.harness,
          continuation ? retainedRuntimeBinding : undefined,
        );
        if (
          result.capabilityRevision !== input.capabilityRevision ||
          !result.routes.some(
            (route) =>
              isDeepStrictEqual(route.account, input.runtime.account) &&
              route.targetId === input.runtime.targetId &&
              route.modes.some((mode) => mode === input.runtime.mode),
          ) ||
          catalog.resolve(input.runtime).status !== 'compatible'
        )
          throw Error(unavailable);
        const account = result.accounts.find((entry) =>
          isDeepStrictEqual(entry.account, input.runtime.account),
        );
        const model = account?.models.find((entry) => entry.id === input.selection.model);
        if (
          !account ||
          account.modelDiscovery.stale ||
          !model ||
          (input.selection.thinking === null
            ? !!model.reasoningEfforts?.length
            : !model.reasoningEfforts?.includes(input.selection.thinking))
        )
          throw Error(unavailable);
        const binding: AccountBinding = profiles.resolve(
          input.runtime.account.accountId,
          input.selection.model,
        );
        const { accountId, provider, profileRevision } = binding;
        if (!isDeepStrictEqual({ accountId, provider, profileRevision }, input.runtime.account))
          throw Error(unavailable);
        if (input.runOn === 'local' && input.runtime.harness === 'codex') {
          const selected = profiles.localCodexProfile(binding);
          if (selected.nativeAuth !== undefined || selected.workspaceId !== undefined)
            throw Error(unavailable);
        }
        const profile = readOrdinaryCodexAgentProfile(getAgentLibrary(), input.selection.agent);
        if (!profile || profile.definition.contextRecipe?.source === 'packs')
          throw Error(unavailable);
        assertOrdinaryCodexContextIdentity(profile, input.selection, undefined, binding.provider);
        if (
          ordinaryCodexAgentProfileRouteProjection(
            [profile],
            binding.provider,
            input.runOn,
            agentContextPresets,
            {
              contextRecipes: 'supported',
              toolSelection:
                input.runOn === 'local' &&
                ['responses', 'gemini', 'codex'].includes(input.runtime.harness),
              toolRoute: input.runtime.harness === 'codex' ? 'codex-owned-local' : 'local-api',
            },
          ).agentProfileRejections.length
        )
          throw Error(unavailable);
        if (!ordinaryInput && (!BASE_REPO || !isAbsolute(BASE_REPO))) throw Error(unavailable);
        if (automaticLocalRepository) {
          authority.assertCurrent();
          await getLocalRepositoryWorkspaces().selectLocalRepository(
            binding,
            'primary',
            {
              runOn: 'local',
              runtime: {
                account: input.runtime.account,
                harness: input.runtime.harness,
                targetId: input.runtime.targetId,
              },
            },
            controller.signal,
            repositoryWorkspaceId!,
          );
          authority.assertCurrent();
        }
        const preparedRepository =
          !ordinaryInput && !continuation
            ? ctx.eventStore.getOrdinarySessionPreparationForConversation(sessionId)
            : undefined;
        const preparedRepositoryRecord = preparedRepository
          ? getRepositoryWorkspaces(true).get(preparedRepository.workspaceId)
          : undefined;
        if (preparedRepository) {
          const meta = ctx.eventStore.getSession(sessionId);
          const resolved = catalog.resolve(input.runtime);
          if (
            input.runOn !== 'local' ||
            input.runtime.harness !== 'codex' ||
            preparedRepository.workspaceId !== repositoryWorkspaceId ||
            preparedRepository.sessionId !== sessionId ||
            (preparedRepository.firstCommandId !== null &&
              preparedRepository.firstCommandId !== input.clientMsgId) ||
            resolved.status !== 'compatible' ||
            !isDeepStrictEqual(resolved.binding, preparedRepository.settings.binding) ||
            !isDeepStrictEqual(input.selection, preparedRepository.settings.selection) ||
            !meta ||
            meta.isHidden ||
            meta.ordinaryWorkspaceId != null ||
            meta.repositoryWorkspaceId !== repositoryWorkspaceId ||
            meta.cwd !== preparedRepositoryRecord?.directory ||
            !preparedRepositoryRecord?.hostReservation ||
            !preparedRepositoryRecord.ordinaryPreparation ||
            !isDeepStrictEqual(meta.accountBinding, binding)
          )
            throw Error(unavailable);
        }
        const retainedRepository =
          !ordinaryInput && repositoryWorkspaceId
            ? getRepositoryWorkspaces(true).get(repositoryWorkspaceId)
            : undefined;
        const reservation = {
          id: ordinaryWorkspace ? ordinaryWorkspace.id : repositoryWorkspaceId!,
          binding: ordinaryWorkspace
            ? ordinaryWorkspace.binding
            : continuation
              ? ctx.eventStore.getSession(sessionId)!.accountBinding!
              : binding,
          conversationId: sessionId,
          taskRoot: ordinaryWorkspace
            ? ordinaryWorkspace.hostReservation.taskRoot
            : (retainedRepository?.hostReservation?.taskRoot ??
              (retainedRepository?.localSource
                ? join(retainedRepository.localSource.path, '.claude', 'worktrees')
                : join(BASE_REPO, '.claude', 'repository-tasks'))),
          ...(ordinaryWorkspace
            ? { commandFingerprint: ordinaryWorkspace.preparationFingerprint }
            : !continuation
              ? {
                  commandFingerprint:
                    preparedRepository?.preparationFingerprint ??
                    createHash('sha256').update(JSON.stringify(input)).digest('hex'),
                }
              : {}),
          runtimeBinding: (() => {
            const resolved = catalog.resolve(input.runtime);
            if (resolved.status !== 'compatible') throw Error(unavailable);
            return resolved.binding;
          })(),
        };
        authority.assertCurrent();
        if (!ordinaryInput && !continuation && input.runOn === 'local')
          await getRepositoryWorkspaces(true).reserveHostTask({
            ...reservation,
            signal: controller.signal,
          });
        else if (!ordinaryInput && !continuation)
          await getRepositoryWorkspaces(true).reserveOrdinarySandboxTask({
            ...reservation,
            signal: controller.signal,
          });
        authority.assertCurrent();
        const live = ctx.sessionRegistry.findBySessionId(sessionId);
        if (
          live &&
          !(input.runOn === 'local' && input.runtime.harness === 'codex'
            ? ordinaryOperatorOwnsConversation(live.session.ownedLocalAuthSessionId, auth.id)
            : live.session.ownedLocalAuthSessionId === auth.id)
        )
          throw Error(unavailable);
        ctx.connRegistry.watch(connectionId, sessionId);
        ctx.connRegistry.setActive(connectionId, sessionId);
        const command = {
          clientMsgId: input.clientMsgId,
          capabilityRevision: input.capabilityRevision,
          runtime: input.runtime,
          selection: input.selection,
          payload: input.payload,
        };
        const resultCommand = await dispatchOwnedOrdinaryCommand({
          transport,
          clientId: `${connectionId}:${sessionId}`,
          sessionId,
          commandId: input.clientMsgId,
          command,
          reservation,
          operatorConnectionId,
          ownerConnectionId: connectionId,
          ownerAuthSessionId: auth.id,
          signal: controller.signal,
          continuation,
          existingOwner: Boolean(existingOwner),
          workspaceKind: ordinaryInput ? 'ordinary' : 'repository',
          ...(!continuation && ordinaryWorkspace
            ? { preparationOperationId: ordinaryWorkspace.allocationOperationId }
            : preparedRepository
              ? { preparationOperationId: preparedRepository.allocationOperationId }
              : {}),
          profile,
          ...(input.runOn === 'openshell'
            ? { sandboxWorkdir: loadOrdinaryOpenShellCodexTarget()!.config.workdir }
            : {}),
        });
        authority.assertCurrent();
        const receipt = ctx.eventStore.getOrdinaryCommandAdmission(input.clientMsgId);
        if (!receipt || ctx.eventStore.getSendCommand(input.clientMsgId)?.sessionId !== sessionId)
          throw Error(unavailable);
        return res.status(202).json({
          ok: true,
          clientMsgId: input.clientMsgId,
          sessionId: resultCommand.sessionId,
          dispatched: resultCommand.dispatched,
          state: receipt.state,
        });
      } catch {
        let state: string | undefined;
        try {
          if (ctx.eventStore.getSendCommand(input.clientMsgId)?.sessionId === sessionId)
            state = ctx.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)?.state;
        } catch {
          /* Retain original evidence. */
        }
        return res.status(409).json({
          ok: false,
          code: state ? 'retained_command' : 'entry_unavailable',
          error: unavailable,
          clientMsgId: input.clientMsgId,
          sessionId,
          ...(state ? { state } : {}),
        });
      } finally {
        try {
          if (!transport.isOpen()) {
            const current = ctx.sessionRegistry.findBySessionId(sessionId);
            if (current) detachChatIfCurrentTransport(current.clientId, transport);
          }
        } catch {
          log.warn('Local chat attachment cleanup remains unconfirmed', { sessionId });
        }
        if (timer) clearTimeout(timer);
        releaseStartup?.();
        releaseBinding?.();
        authority?.release();
      }
    };
  const sendCommand = (
    continuation: boolean,
    observeOnly = false,
  ): import('express').RequestHandler => {
    const execute = executeCommand(continuation, observeOnly);
    return async (req, res, next) => {
      const header = req.headers.traceparent;
      const parent = typeof header === 'string' ? contextFromTraceparent(header) : context.active();
      const span = startCommandTimingSpan('codex.command.http', req.body?.clientMsgId, parent);
      try {
        return await context.with(span ? trace.setSpan(parent, span) : parent, () =>
          execute(req, res, next),
        );
      } finally {
        finishCommandTimingSpan(span, res.statusCode);
      }
    };
  };
  router.post(ordinary ? '/first' : '/send', requireSameOriginJson, sendCommand(false));
  router.post('/continue', requireSameOriginJson, sendCommand(true));
  router.post(
    ordinary ? '/first/receipt' : '/send/receipt',
    requireSameOriginJson,
    sendCommand(false, true),
  );
  router.post('/continue/receipt', requireSameOriginJson, sendCommand(true, true));
  return router;
}

export function createOwnedLocalCodexEntryRouter(
  sse: SessionSseRegistry,
  ctx: Pick<V2HandlerContext, 'connRegistry' | 'sessionRegistry' | 'eventStore'>,
  general = false,
): Router {
  return createOwnedCodexEntryRouter(sse, ctx, general);
}
/** Explicit ordinary V2 wire; no repository or alternate-provider fallback. */
export function createOwnedOrdinaryWorkspaceCommandRouter(
  sse: SessionSseRegistry,
  ctx: Pick<V2HandlerContext, 'connRegistry' | 'sessionRegistry' | 'eventStore'>,
): Router {
  return createOwnedCodexEntryRouter(sse, ctx, false, true);
}
