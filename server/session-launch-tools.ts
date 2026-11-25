import {
  StartSessionInputSchema,
  TelosCreateSessionInputSchema,
  resolveSessionLaunchConfig,
  sessionLaunchHandoverUrl,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  type SessionLaunchConfig,
  type StartSessionInput,
} from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkSkillPolicy, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { getSessionLaunches, type SessionLaunchController } from './session-launch-controller.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { publicSessionLaunchRecord } from './session-launch-store.js';
import { SessionLaunchError } from './session-launch-store.js';
import {
  resolveSessionLaunchProposalRoute,
  sessionLaunchStartupBlocker,
  type SessionLaunchScope,
} from './session-launch-runtime.js';
import type { SessionLaunchAuthority } from './session-launch-service.js';
import {
  telosSessionLaunchDefinition,
  TelosSessionProposalResponseSchema,
} from './telos-session-launch-tool.js';

export const sessionLaunchDefinitions = [
  {
    name: 'StartSession',
    description:
      'Propose a new ordinary Mitzo chat using saved defaults and optional overrides. Put the complete self-contained handover in prompt; do not rely on a temporary file path. The retained request provides handoverDownloadUrl for exact Markdown download, even before startup. The user reviews and edits configuration, title and handoff before Approve & start. A pending proposal has not allocated or started a chat. Reuse the exact requestId and arguments after uncertainty. Starts independent Local Mac Codex or Claude sessions, each on the engine New chat uses for that account; any other account returns startupBlocker at proposal and cannot be approved until a Codex or Claude account is chosen. Additional tools must already be exposed by the selected agent profile; selection grants no permissions. Unsupported account, context or workspace choices return startupBlocker and remain editable in review.',
    input_schema: z.toJSONSchema(StartSessionInputSchema),
  },
  telosSessionLaunchDefinition,
];

/** Shared native/SDK proposal owner. Its authority is captured by the verified
 * adapter; pending intent confers no workspace, role or execution permissions. */
export async function proposeTelosSession(
  controller: SessionLaunchController,
  sourceSessionId: string,
  raw: unknown,
  authority: SessionLaunchAuthority,
) {
  const input = TelosCreateSessionInputSchema.parse(raw);
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  if (!controller.telos)
    throw new SessionLaunchError(
      'Telos session creation is unavailable on this controller. Do not substitute StartSession.',
    );
  const previous = controller.launches.store.forRequest(sourceSessionId, 'user', input.requestId);
  const selected = previous?.telos
    ? {
        telos: previous.telos,
        telosReview: previous.telosReview,
        telosReviewOwner: previous.telosReviewOwner,
        configuration: previous.configuration,
      }
    : await controller.telos.propose(sourceSessionId, input, authority);
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  // Adoption keeps an existing chat's retained settings; only a new child's
  // agent-edited account or host is resolved as New chat would resolve it.
  // A retried request keeps its retained configuration; its route diagnostic
  // is recomputed so a retry cannot hide a blocker the first call reported.
  const route =
    selected.telos?.adoption || (!previous && selected.configuration)
      ? null
      : await proposedSessionLaunchConfig(
          controller,
          input.overrides,
          'telos',
          previous?.configuration,
        );
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const record = controller.launches.store.propose({
    ...input,
    ...selected,
    operatorId: 'user',
    sourceSessionId,
    originalInput: input,
    configuration: previous?.configuration ?? route?.configuration ?? selected.configuration!,
  });
  controller.changed(sourceSessionId);
  // Adoption keeps an existing Codex or Claude chat's engine; only creation of
  // a new Telos child is limited to engines Telos worker startup can start.
  const startupBlocker =
    sessionLaunchStartupBlocker(
      record.configuration,
      record.telos?.adoption ? 'session' : 'telos',
    ) ?? route?.blocker;
  return TelosSessionProposalResponseSchema.parse({
    ...publicSessionLaunchRecord(record),
    handoverDownloadUrl: sessionLaunchHandoverUrl(record.proposalId),
    ...(startupBlocker ? { startupBlocker } : {}),
  });
}

/** Saved defaults plus agent overrides, with an edited account or named host
 * resolved to the Local Mac route New chat uses for that account. A retained
 * proposal (same requestId) keeps its configuration unchanged; only its
 * blocker is recomputed. When it still matches what this input resolves to,
 * that resolution's blocker applies; when review edited it, its current host
 * is checked as an explicit choice. */
async function proposedSessionLaunchConfig(
  controller: SessionLaunchController,
  overrides: StartSessionInput['overrides'],
  scope: SessionLaunchScope,
  retained?: SessionLaunchConfig,
): Promise<{ configuration: SessionLaunchConfig; blocker: string | null }> {
  const configuration = resolveSessionLaunchConfig(
    controller.defaults.get('user').configuration ?? initialSessionLaunchConfig(),
    overrides,
  );
  const targetId = overrides?.runtime?.execution?.targetId;
  const route = await resolveSessionLaunchProposalRoute(configuration, {
    scope,
    targetSupplied: typeof targetId === 'string',
  });
  if (!retained || isDeepStrictEqual(retained, route.configuration)) return route;
  const { blocker } = await resolveSessionLaunchProposalRoute(retained, {
    scope,
    targetSupplied: true,
  });
  return { configuration: retained, blocker };
}

export function initialSessionLaunchConfig(): SessionLaunchConfig {
  return {
    version: 1,
    runtime: {
      version: 1,
      account: null,
      accountReference: null,
      agentProfile: {
        kind: 'builtin',
        profileId: DEFAULT_MITZO_PROFILE_ID,
        revision: DEFAULT_MITZO_PROFILE_REVISION,
      },
      execution: { location: 'openshell', targetId: null },
    },
    mode: 'agent',
    isolation: true,
    repositoryWorkspaceId: null,
    contextBlocks: [],
    extraTools: [],
  };
}

/** Native caller identity comes from the verified current tool callback. The
 * model can propose intent; this adapter has no allocation or dispatch method. */
export function sessionLaunchTools(options: {
  sessionId: string;
  session: ManagedSession;
  registry: SessionRegistry;
  /** Transport's exposed tool namespace; native callers use bare names. */
  permissionPrefix?: string;
  assertCurrent(): Promise<void>;
  assertCurrentSync(): void;
  controller?(): SessionLaunchController;
}) {
  return {
    async execute(
      raw: unknown,
      externalSignal: AbortSignal,
      call?: ProfileToolCall,
      name: 'StartSession' | 'TelosCreateSession' = 'StartSession',
    ) {
      if (!call?.turnId || !call.callId) throw Error('Verified current tool call required.');
      const signal = AbortSignal.any([externalSignal, options.session.abortController.signal]);
      const current = () => {
        signal.throwIfAborted();
        options.assertCurrentSync();
        const owner = options.registry.findBySessionId(options.sessionId);
        if (
          !owner ||
          owner.session !== options.session ||
          !agentToolAllowed(options.session, name) ||
          options.registry.isClosingOut(owner.clientId) ||
          options.registry.isUserClose(owner.clientId)
        )
          throw Error('Current ordinary session owner required.');
        if (
          checkSkillPolicy(
            options.registry,
            owner.clientId,
            (options.permissionPrefix ?? '') + name,
          ) === 'deny'
        )
          throw Error('Session creation is unavailable under active skill tool restrictions.');
        return owner;
      };
      const owner = current();
      const connectionId = sessionToolOperatorConnection(owner.session, owner.clientId);
      const captured = captureAgentLibraryAuthorization(connectionId);
      await options.assertCurrent();
      const next = current();
      captured.assertCurrent();
      if (sessionToolOperatorConnection(next.session, next.clientId) !== connectionId)
        throw Error('Session operator changed.');
      if (name === 'TelosCreateSession')
        return proposeTelosSession(
          (options.controller ?? getSessionLaunches)(),
          options.sessionId,
          raw,
          {
            operatorConnectionId: connectionId,
            authSessionId: captured.auth.id,
            signal,
            assertCurrent() {
              const currentOwner = current();
              captured.assertCurrent();
              if (
                sessionToolOperatorConnection(currentOwner.session, currentOwner.clientId) !==
                connectionId
              )
                throw new SessionLaunchError('Session operator changed.', 403);
            },
          },
        );
      const input = StartSessionInputSchema.parse(raw);
      const controller = (options.controller ?? getSessionLaunches)();
      const previous = controller.launches.store.forRequest(
        options.sessionId,
        'user',
        input.requestId,
      );
      const route = await proposedSessionLaunchConfig(
        controller,
        input.overrides,
        'session',
        previous?.configuration,
      );
      current();
      captured.assertCurrent();
      const record = controller.launches.store.propose({
        operatorId: 'user',
        sourceSessionId: options.sessionId,
        ...input,
        configuration: route.configuration,
        originalInput: input,
      });
      current();
      captured.assertCurrent();
      controller.changed(options.sessionId);
      const startupBlocker = sessionLaunchStartupBlocker(record.configuration) ?? route.blocker;
      return {
        ...publicSessionLaunchRecord(record),
        handoverDownloadUrl: sessionLaunchHandoverUrl(record.proposalId),
        ...(startupBlocker ? { startupBlocker } : {}),
      };
    },
  };
}
