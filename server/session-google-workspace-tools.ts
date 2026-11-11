import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { agentToolAllowed } from './agent-tool-selection.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import {
  GoogleWorkspaceReadSchema,
  googleWorkspaceReadDefinition,
  googleReadCapability,
  googleReadSessionApproval,
} from './google-workspace-read.js';
import { captureSessionCapability } from './session-capability-grants.js';

/** The admitted Local Mac owner supplies both fences; no shell credential access is granted. */
export function sessionGoogleWorkspaceTools(options: {
  sessionId: string;
  session: ManagedSession;
  registry: SessionRegistry;
  assertCurrent(): Promise<void>;
  assertCurrentSync(): void;
}) {
  const name = googleWorkspaceReadDefinition.name;
  const service = getConnectionsRuntime()?.googleWorkspace;
  const current = () => {
    options.assertCurrentSync();
    const owner = options.registry.findBySessionId(options.sessionId);
    if (
      !owner ||
      owner.session !== options.session ||
      options.session.abortController.signal.aborted ||
      !agentToolAllowed(options.session, name) ||
      checkSkillPolicy(options.registry, owner.clientId, name) === 'deny' ||
      !service ||
      getConnectionsRuntime()?.googleWorkspace !== service
    )
      throw Error('Google read owner unavailable');
    return owner;
  };
  const guard = async () => {
    await options.assertCurrent();
    current();
  };
  return {
    assertCurrent: guard,
    definitions:
      service && agentToolAllowed(options.session, name) ? [googleWorkspaceReadDefinition] : [],
    async execute(
      input: Record<string, unknown>,
      signal: AbortSignal,
      onAuthorized?: (assertConsentCurrent: () => void) => void,
    ) {
      const combined = AbortSignal.any([
        signal,
        options.session.abortController.signal,
        AbortSignal.timeout(30_000),
      ]);
      try {
        const request = GoogleWorkspaceReadSchema.parse(input);
        combined.throwIfAborted();
        await guard();
        const prepared = await service!.prepareRead(request, combined);
        await guard();
        combined.throwIfAborted();
        const review = { account: prepared.email, request };
        const owner = current();
        const consent = captureSessionCapability(
          options.session,
          googleReadCapability(request, prepared.email),
        );
        const approval = googleReadSessionApproval(options.session, prepared.email);
        // Auto reads freely; a lowered mode must not deliver an Auto-admitted read.
        const autoRead = !consent && effectivePermissionMode(options.session) === 'auto';
        let sessionGranted = false;
        const readCurrent = () => {
          current();
          consent?.();
          if (autoRead && effectivePermissionMode(options.session) !== 'auto')
            throw Error('Google read mode changed');
          if (
            sessionGranted &&
            (!options.session.sessionAllowList.has(approval.sessionGrantKey) ||
              googleReadSessionApproval(options.session, prepared.email).sessionGrantKey !==
                approval.sessionGrantKey)
          )
            throw Error('Google read session grant changed');
        };
        const readGuard = async () => {
          await guard();
          readCurrent();
        };
        readCurrent();
        const permission =
          consent || autoRead
            ? { behavior: 'allow' as const, updatedInput: review }
            : await buildPermissionHandler(owner.clientId, options.registry)(name, review, {
                signal: combined,
                toolUseID: randomUUID(),
                // Reads are never tier auto-allowed outside Auto; a retained
                // account-scoped session grant still satisfies the prompt.
                forcePrompt: true,
                allowSessionGrant: true,
                approvalScope: 'session',
                ...approval,
                description: `Read using ${prepared.email}. Allow for session covers further reads by this account in this chat. Credentials remain private to Mitzo.`,
              });
        sessionGranted =
          'decisionClassification' in permission &&
          permission.decisionClassification === 'user_permanent';
        await readGuard();
        combined.throwIfAborted();
        if (permission.behavior !== 'allow') return { content: permission.message, isError: true };
        if (!isDeepStrictEqual(permission.updatedInput, review))
          throw Error('Google read approval changed');
        onAuthorized?.(readCurrent);
        const content = await prepared.read(readGuard);
        await readGuard();
        combined.throwIfAborted();
        return { content, isError: false };
      } catch {
        // OAuth, CLI and HTTP diagnostics can contain secrets. Never return causes.
        return {
          content: combined.aborted
            ? 'Google read cancelled or timed out.'
            : 'Google read unavailable. Check the configured Google sign-in, resource access and current chat permissions, then retry.',
          isError: true,
        };
      }
    },
  };
}
