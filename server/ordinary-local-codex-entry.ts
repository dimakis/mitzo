import {
  OrdinaryLocalVertexTarget,
  localVertexCapabilities,
} from './ordinary-local-vertex-capabilities.js';
import {
  startOwnedLocalVertexCommand,
  sendOwnedLocalVertexCommand,
  canResumeOwnedLocalVertexDriver,
} from './ordinary-local-vertex-entry.js';
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
} from './ordinary-local-responses-capabilities.js';
import {
  startOwnedLocalResponsesCommand,
  sendOwnedLocalResponsesCommand,
  canResumeOwnedLocalResponsesDriver,
} from './chat.js';
import { createHash, randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Router } from 'express';
import {
  LocalCodexFirstCommandSchema,
  LocalCodexContinuationCommandSchema,
  OrdinaryRuntimeFirstCommandSchema,
  OrdinaryRuntimeContinuationCommandSchema,
  type AccountBinding,
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
import { getRepositoryWorkspaces } from './repository-workspace-runtime.js';
import {
  OrdinaryLocalCodexCapabilityCatalog,
  loadOrdinaryLocalCodexTarget,
} from './ordinary-local-codex-capabilities.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import {
  BASE_REPO,
  detachChatIfCurrentTransport,
  startOwnedLocalCodexCommand,
  sendOwnedLocalCodexCommand,
  canResumeOwnedLocalCodexDriver,
} from './chat.js';
import { loadOrdinaryOpenShellCodexTarget } from './ordinary-openshell-codex-entry-owner.js';
import { projectOrdinaryOpenShellCodexCapabilities } from './ordinary-openshell-codex-route.js';
import { resolveOrdinarySessionRuntime } from './ordinary-session-runtime.js';
import {
  startOwnedOpenShellCodexCommand,
  sendOwnedOpenShellCodexCommand,
  canResumeOwnedOpenShellCodexDriver,
} from './ordinary-openshell-codex-entry.js';
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
  harness: 'codex' | 'responses' | 'claude-sdk' = 'codex',
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
  if (harness === 'responses') {
    if (location !== 'local' || process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED !== '1')
      throw Error(unavailable);
    const catalog = localResponsesCapabilities(profiles, new OrdinaryLocalResponsesTarget());
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
      const selected = profiles.codexProfile(profiles.resolve(account.accountId, models[0]?.id));
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
  return { profiles, catalog, result };
}

/** Composes the accepted projections; never creates another selection registry. */
export function ordinaryCodexCapabilities() {
  const availableInventory = (
    location: 'local' | 'openshell',
    harness: 'codex' | 'responses' | 'claude-sdk' = 'codex',
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
  const shell =
    process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED === '1'
      ? availableInventory('openshell')
      : undefined;
  const { accounts, routes } = composeOrdinaryRuntimeCapabilities(
    [local, shell, responses, vertex].map(
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
    capabilityRevision: createHash('sha256')
      .update(
        JSON.stringify([
          local?.capabilityRevision ?? null,
          shell?.capabilityRevision ?? null,
          responses?.capabilityRevision ?? null,
          vertex?.capabilityRevision ?? null,
        ]),
      )
      .digest('hex'),
    accounts,
    targets: [
      ...(local?.targets ?? []),
      ...(shell?.targets ?? []),
      ...(responses?.targets ?? []),
      ...(vertex?.targets ?? []),
    ],
    routes,
    locations: [
      [local, responses, vertex]
        .find((source) =>
          source?.locations.some(
            (entry) => entry.location === 'local' && entry.status === 'configured',
          ),
        )
        ?.locations.find((entry) => entry.location === 'local') ??
        local?.locations.find((entry) => entry.location === 'local') ??
        responses?.locations[0] ??
        vertex?.locations[0] ?? {
          location: 'local',
          status: 'unavailable',
          reason: [
            process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED,
            process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED,
            process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED,
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
export function createOwnedLocalCodexEntryRouter(
  sse: SessionSseRegistry,
  ctx: Pick<V2HandlerContext, 'connRegistry' | 'sessionRegistry' | 'eventStore'>,
  general = false,
): Router {
  const router = Router();
  const unavailable = general
    ? 'Conversation runtime unavailable'
    : 'Local Codex entry unavailable';
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      (process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' &&
        (!general ||
          (process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1' &&
            process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED !== '1' &&
            process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED !== '1'))) ||
      custodianControllerMode ||
      custodianOwnerMode
    )
      return res.status(503).json({ ok: false, code: 'entry_disabled', error: unavailable });
    next();
  });
  router.use(operatorAuthMiddleware);
  router.get('/capabilities', (_req, res) => {
    try {
      const auth = res.locals.authSession as AuthSession | undefined;
      if (!auth || auth.expiresAt <= Date.now())
        return res
          .status(401)
          .json({ ok: false, code: 'interactive_auth_required', error: unavailable });
      const result = general ? ordinaryCodexCapabilities() : inventory().result;
      const agentProfiles = ordinaryCodexAgentProfiles(getAgentLibrary().list('user').versions);
      const shell = general ? loadOrdinaryOpenShellCodexTarget() : undefined;
      const response = {
        ...result,
        agentProfiles,
        routes: result.routes.map((route) => {
          const candidates = result.targets.filter(
            (target) =>
              target.targetId === route.targetId &&
              target.harness === route.harness &&
              (!('location' in route) || !route.location || target.location === route.location),
          );
          if (candidates.length !== 1) throw Error(unavailable);
          const target = candidates[0];
          const presets =
            target?.location === 'openshell' &&
            shell?.target.targetRevision === target.targetRevision
              ? shell.config.agentContextPresets
              : undefined;
          return {
            ...route,
            ...ordinaryCodexAgentProfileRouteProjection(
              agentProfiles,
              route.account.provider,
              target?.location ?? 'local',
              presets,
              route.harness === 'responses' ? { contextRecipes: 'none' } : undefined,
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
  const sendCommand =
    (continuation: boolean): import('express').RequestHandler =>
    async (req, res) => {
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
        general
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
      const input = structuredClone(parsed.data);
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
            : input.runtime.harness === 'responses'
              ? process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED
              : process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED
          : process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED) !== '1'
      )
        return res.status(503).json({ ok: false, code: 'entry_disabled', error: unavailable });
      const sessionId = continuation
        ? (general
            ? OrdinaryRuntimeContinuationCommandSchema
            : LocalCodexContinuationCommandSchema
          ).parse(req.body).sessionId
        : nativeStartupSessionId(`repository:${input.repositoryWorkspaceId}`);
      const existingOwner = ctx.sessionRegistry.findBySessionId(sessionId);
      if (existingOwner && existingOwner.session.ownedLocalAuthSessionId !== auth.id)
        return res
          .status(403)
          .json({ ok: false, code: 'connection_unavailable', error: unavailable });
      if (continuation) {
        const meta = ctx.eventStore.getSession(sessionId);
        const binding = ctx.eventStore.getSessionRuntimeBinding(sessionId);
        if (
          (!existingOwner &&
            !(input.runOn === 'local'
              ? input.runtime.harness === 'claude-sdk'
                ? canResumeOwnedLocalVertexDriver(sessionId, auth.id)
                : input.runtime.harness === 'responses'
                  ? canResumeOwnedLocalResponsesDriver(sessionId, auth.id)
                  : canResumeOwnedLocalCodexDriver(sessionId, auth.id)
              : canResumeOwnedOpenShellCodexDriver(sessionId, auth.id))) ||
          !meta ||
          !binding ||
          meta.repositoryWorkspaceId !== input.repositoryWorkspaceId ||
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
        timer = setTimeout(() => controller.abort(), 120000);
        authority.assertCurrent();
        const { profiles, catalog, result } = inventory(input.runOn, input.runtime.harness);
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
          const selected = profiles.codexProfile(binding);
          if (selected.nativeAuth !== undefined || selected.workspaceId !== undefined)
            throw Error(unavailable);
        }
        const profile = readOrdinaryCodexAgentProfile(getAgentLibrary(), input.selection.agent);
        if (!profile || profile.definition.contextRecipe?.source === 'packs')
          throw Error(unavailable);
        assertOrdinaryCodexContextIdentity(profile, input.selection, undefined, binding.provider);
        if (!BASE_REPO || !isAbsolute(BASE_REPO)) throw Error(unavailable);
        const reservation = {
          id: input.repositoryWorkspaceId,
          binding: continuation ? ctx.eventStore.getSession(sessionId)!.accountBinding! : binding,
          conversationId: sessionId,
          taskRoot: join(BASE_REPO, '.claude', 'repository-tasks'),
        };
        authority.assertCurrent();
        if (!continuation && input.runOn === 'local')
          await getRepositoryWorkspaces(true).reserveHostTask({
            ...reservation,
            signal: controller.signal,
          });
        authority.assertCurrent();
        const live = ctx.sessionRegistry.findBySessionId(sessionId);
        if (live && live.session.ownedLocalAuthSessionId !== auth.id) throw Error(unavailable);
        ctx.connRegistry.watch(connectionId, sessionId);
        ctx.connRegistry.setActive(connectionId, sessionId);
        const command = {
          clientMsgId: input.clientMsgId,
          capabilityRevision: input.capabilityRevision,
          runtime: input.runtime,
          selection: input.selection,
          payload: input.payload,
        };
        const resultCommand =
          input.runtime.harness === 'claude-sdk'
            ? continuation && existingOwner
              ? await sendOwnedLocalVertexCommand({ sessionId, command, operatorConnectionId })
              : await startOwnedLocalVertexCommand(transport, `${connectionId}:${sessionId}`, {
                  command,
                  reservation,
                  operatorConnectionId,
                  ownerConnectionId: connectionId,
                  ownerAuthSessionId: auth.id,
                  resume: continuation,
                })
            : input.runtime.harness === 'responses'
              ? continuation && existingOwner
                ? await sendOwnedLocalResponsesCommand({ sessionId, command, operatorConnectionId })
                : await startOwnedLocalResponsesCommand(transport, `${connectionId}:${sessionId}`, {
                    command,
                    reservation,
                    operatorConnectionId,
                    ownerConnectionId: connectionId,
                    ownerAuthSessionId: auth.id,
                    resume: continuation,
                  })
              : input.runOn === 'openshell'
                ? continuation && existingOwner
                  ? await sendOwnedOpenShellCodexCommand({
                      sessionId,
                      command,
                      operatorConnectionId,
                    })
                  : await startOwnedOpenShellCodexCommand(
                      transport,
                      `${connectionId}:${sessionId}`,
                      {
                        command,
                        meta: {
                          sessionId,
                          repositoryWorkspaceId: input.repositoryWorkspaceId,
                          accountBinding: reservation.binding,
                          agentProfile: profile,
                          cwd: loadOrdinaryOpenShellCodexTarget()!.config.workdir,
                          selectedModel: input.selection.model,
                          reasoningEffort: input.selection.thinking,
                          mode: input.selection.permission.mode,
                        },
                        taskRoot: reservation.taskRoot,
                        operatorConnectionId,
                        ownerConnectionId: connectionId,
                        signal: controller.signal,
                        resume: continuation,
                      },
                    )
                : continuation && existingOwner
                  ? await sendOwnedLocalCodexCommand({ sessionId, command, operatorConnectionId })
                  : await startOwnedLocalCodexCommand(transport, `${connectionId}:${sessionId}`, {
                      command,
                      reservation,
                      commandId: input.clientMsgId,
                      operatorConnectionId,
                      ownerConnectionId: connectionId,
                      signal: controller.signal,
                      resume: continuation,
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
  router.post('/send', requireSameOriginJson, sendCommand(false));
  router.post('/continue', requireSameOriginJson, sendCommand(true));
  return router;
}
