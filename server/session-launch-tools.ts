import {
  StartSessionInputSchema,
  resolveSessionLaunchConfig,
  sessionLaunchConfigurationReason,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  type SessionLaunchConfig,
} from '@mitzo/protocol';
import { z } from 'zod';
import { checkSkillPolicy, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { getSessionLaunches, type SessionLaunchController } from './session-launch-controller.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { publicSessionLaunchRecord } from './session-launch-store.js';

export const sessionLaunchDefinitions = [
  {
    name: 'StartSession',
    description:
      'Propose a new ordinary Mitzo chat using saved defaults and optional overrides. Put the complete self-contained handover in prompt; do not rely on a temporary file path. The retained request provides handoverDownloadUrl for exact Markdown download, even before startup. The user reviews and edits configuration, title and handoff before Approve & start. Pending has not allocated or started a chat. Reuse the exact requestId and arguments after uncertainty. Supports independent Local Mac Codex sessions and additional tools already exposed by the selected agent profile; selection grants no permissions. Unsupported context/workspace choices return startupBlocker and remain editable in review.',
    input_schema: z.toJSONSchema(StartSessionInputSchema),
  },
];

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
  assertCurrent(): Promise<void>;
  assertCurrentSync(): void;
  controller?(): SessionLaunchController;
}) {
  return {
    async execute(raw: unknown, externalSignal: AbortSignal, call?: ProfileToolCall) {
      if (!call?.turnId || !call.callId) throw Error('Verified current tool call required.');
      const signal = AbortSignal.any([externalSignal, options.session.abortController.signal]);
      const current = () => {
        signal.throwIfAborted();
        options.assertCurrentSync();
        const owner = options.registry.findBySessionId(options.sessionId);
        if (
          !owner ||
          owner.session !== options.session ||
          !agentToolAllowed(options.session, 'StartSession') ||
          checkSkillPolicy(options.registry, owner.clientId, 'StartSession') === 'deny' ||
          options.registry.isClosingOut(owner.clientId) ||
          options.registry.isUserClose(owner.clientId)
        )
          throw Error('Current ordinary session owner required.');
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
      const input = StartSessionInputSchema.parse(raw);
      const controller = (options.controller ?? getSessionLaunches)();
      const previous = controller.launches.store.forRequest(
        options.sessionId,
        'user',
        input.requestId,
      );
      const configuration =
        previous?.configuration ??
        resolveSessionLaunchConfig(
          controller.defaults.get('user').configuration ?? initialSessionLaunchConfig(),
          input.overrides,
        );
      const record = controller.launches.store.propose({
        operatorId: 'user',
        sourceSessionId: options.sessionId,
        ...input,
        configuration,
        originalInput: input,
      });
      current();
      captured.assertCurrent();
      controller.changed(options.sessionId);
      const startupBlocker = sessionLaunchConfigurationReason(record.configuration);
      return {
        ...publicSessionLaunchRecord(record),
        handoverDownloadUrl: `/api/session-launch/requests/${encodeURIComponent(record.proposalId)}/handover.md`,
        ...(startupBlocker ? { startupBlocker } : {}),
      };
    },
  };
}
