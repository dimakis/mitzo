import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import { agentToolAllowed, filterAgentTools } from './agent-tool-selection.js';
import {
  credentialConnectionToolDefinitions,
  nativeConnectionToolNames,
  type ConnectionAccessPending,
} from './credential-connection-tools.js';
import type { CredentialConnections } from './credential-connections.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import {
  sessionConnectionTools,
  CONNECTION_ACCESS_INSTRUCTIONS,
} from './session-connection-tools.js';
import {
  sessionKnowledgeTools,
  knowledgeToolDefinitions,
  KNOWLEDGE_TOOL_INSTRUCTIONS,
} from './session-knowledge-tools.js';

const definitions = [
  ...credentialConnectionToolDefinitions.filter((tool) => nativeConnectionToolNames.has(tool.name)),
  ...knowledgeToolDefinitions,
];
const knowledgeNames = new Set(knowledgeToolDefinitions.map((tool) => tool.name));

/** Focused controller composition. Each request owns its private native-call
 * fence; only pending connection consent is shared within this conversation. */
export function sessionLocalServiceTools(options: {
  sessionId: string;
  session: ManagedSession;
  registry: SessionRegistry;
  assertCurrent(): Promise<void>;
  assertCurrentSync(): void;
}) {
  const selected = filterAgentTools(options.session, definitions);
  const names = new Set(selected.map((tool) => tool.name));
  const pendingByService = new WeakMap<CredentialConnections, ConnectionAccessPending>();
  return {
    definitions: selected,
    instructions: selected.length
      ? CONNECTION_ACCESS_INSTRUCTIONS + KNOWLEDGE_TOOL_INSTRUCTIONS
      : '',
    handles: (name: string) => names.has(name),
    async execute(
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      call: { assertCurrentSync?: () => void },
    ) {
      if (!names.has(name) || !agentToolAllowed(options.session, name))
        throw Error('Local service tool not selected');
      const assertCall = call.assertCurrentSync;
      if (typeof assertCall !== 'function') throw Error('Original native service call required');
      const assertCurrentSync = () => {
        options.assertCurrentSync();
        assertCall();
      };
      const assertCurrent = async () => {
        await options.assertCurrent();
        assertCall();
      };
      assertCurrentSync();
      let result;
      if (knowledgeNames.has(name)) {
        result = await sessionKnowledgeTools(
          options.sessionId,
          options.session,
          options.registry,
          '',
          assertCurrent,
          assertCurrentSync,
        ).execute(name, input, signal);
      } else {
        const service = getCredentialConnectionsRuntime();
        let pendingAccess = service ? pendingByService.get(service) : undefined;
        if (service && !pendingAccess) {
          pendingAccess = new Map();
          pendingByService.set(service, pendingAccess);
        }
        result = await sessionConnectionTools({
          ...options,
          assertRuntimeCurrent: assertCurrent,
          assertRuntimeCurrentSync: assertCurrentSync,
          enableOwnedFrames: true,
          pendingAccess,
        }).execute(name, input, signal);
      }
      assertCurrentSync();
      if (!result) throw Error('Local service handler unavailable');
      return result;
    },
  };
}
