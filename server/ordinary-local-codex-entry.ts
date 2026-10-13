import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Router } from 'express';
import { LocalCodexFirstCommandSchema, type AccountBinding } from '@mitzo/protocol';
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
import { BASE_REPO, startOwnedLocalCodexCommand } from './chat.js';
import { nativeStartupSessionId, reserveRepositoryStartup } from './ordinary-repository-startup.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import type { SessionSseRegistry } from './session-sse-registry.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

const unavailable = 'Local Codex entry unavailable';

/** Pure configured projection. Every dispatch still qualifies the actual host/account. */
function inventory() {
  const profiles = loadAccountProfiles();
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

/** Mounted inside the existing authenticated chat router. No legacy send claim or fallback. */
export function createOwnedLocalCodexEntryRouter(
  sse: SessionSseRegistry,
  ctx: Pick<V2HandlerContext, 'connRegistry' | 'sessionRegistry' | 'eventStore'>,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' ||
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
      const { result } = inventory();
      const agentProfiles = getAgentLibrary()
        .list('user')
        .versions.filter((profile) => profile.definition.contextRecipe === undefined);
      const response = { ...result, agentProfiles };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1048576) throw Error(unavailable);
      return res.json(response);
    } catch {
      return res.status(409).json({ ok: false, code: 'entry_unavailable', error: unavailable });
    }
  });
  router.post('/send', requireSameOriginJson, async (req, res) => {
    const auth = res.locals.authSession as AuthSession | undefined;
    const connectionId = req.headers['x-connection-id'];
    const transport =
      typeof connectionId === 'string' ? ctx.connRegistry.get(connectionId)?.transport : undefined;
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
    const parsed = LocalCodexFirstCommandSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ ok: false, code: 'invalid_request', error: 'Invalid local first command' });
    const input = structuredClone(parsed.data);
    const sessionId = nativeStartupSessionId(`repository:${input.repositoryWorkspaceId}`);
    const existingOwner = ctx.sessionRegistry.findBySessionId(sessionId);
    if (existingOwner && existingOwner.session.ownedLocalAuthSessionId !== auth.id)
      return res
        .status(403)
        .json({ ok: false, code: 'connection_unavailable', error: unavailable });
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
      const { profiles, catalog, result } = inventory();
      if (
        result.capabilityRevision !== input.capabilityRevision ||
        !result.routes.some(
          (route) =>
            isDeepStrictEqual(route.account, input.runtime.account) &&
            route.targetId === input.runtime.targetId &&
            route.modes.includes(input.runtime.mode),
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
      const selected = profiles.codexProfile(binding);
      if (selected.nativeAuth !== undefined || selected.workspaceId !== undefined)
        throw Error(unavailable);
      const profile = getAgentLibrary().version(
        'user',
        input.selection.agent.profileId,
        input.selection.agent.revision,
      );
      if (!profile || profile.definition.contextRecipe !== undefined) throw Error(unavailable);
      if (!BASE_REPO || !isAbsolute(BASE_REPO)) throw Error(unavailable);
      const reservation = {
        id: input.repositoryWorkspaceId,
        binding,
        conversationId: sessionId,
        taskRoot: join(BASE_REPO, '.claude', 'repository-tasks'),
      };
      authority.assertCurrent();
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
      const resultCommand = await startOwnedLocalCodexCommand(
        transport,
        `${connectionId}:${sessionId}`,
        {
          command,
          reservation,
          commandId: input.clientMsgId,
          operatorConnectionId,
          ownerConnectionId: connectionId,
          signal: controller.signal,
        },
      );
      authority.assertCurrent();
      const receipt = ctx.eventStore.getOrdinaryLocalCommandAdmission(input.clientMsgId);
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
          state = ctx.eventStore.getOrdinaryLocalCommandAdmission(input.clientMsgId)?.state;
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
      if (timer) clearTimeout(timer);
      releaseStartup?.();
      releaseBinding?.();
      authority?.release();
    }
  });
  return router;
}
