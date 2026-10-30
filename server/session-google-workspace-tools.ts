import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { agentToolAllowed } from './agent-tool-selection.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import {
  GoogleWorkspaceReadSchema,
  googleWorkspaceReadDefinition,
} from './google-workspace-read.js';

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
    async execute(input: Record<string, unknown>, signal: AbortSignal) {
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
        const permission = await buildPermissionHandler(owner.clientId, options.registry)(
          name,
          review,
          {
            signal: combined,
            toolUseID: randomUUID(),
            forcePrompt: true,
            rememberSessionGrant: false,
            allowSessionGrant: false,
            approvalScope: 'request',
            title: 'Read Google Workspace?',
            description: `Read using ${prepared.email}. Review the exact operation and resource. Credentials remain private to Mitzo.`,
          },
        );
        await guard();
        combined.throwIfAborted();
        if (permission.behavior !== 'allow') return { content: permission.message, isError: true };
        if (!isDeepStrictEqual(permission.updatedInput, review))
          throw Error('Google read approval changed');
        const content = await prepared.read(guard);
        await guard();
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
