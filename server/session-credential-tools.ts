import { sessionAgentTaskTools, agentTaskToolDefinitions } from './session-agent-task-tools.js';
import { agentToolAllowed, filterAgentTools } from './agent-tool-selection.js';
import {
  sessionKnowledgeTools,
  knowledgeToolDefinitions,
  KNOWLEDGE_TOOL_INSTRUCTIONS,
} from './session-knowledge-tools.js';
import {
  sessionProfileTools,
  profileToolDefinitions,
  type ProfileToolCall,
} from './session-profile-tools.js';
import { sessionRepositoryTools, REPOSITORY_CHAT_INSTRUCTIONS } from './repository-chat-tools.js';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import {
  sessionConnectionTools,
  CONNECTION_ACCESS_INSTRUCTIONS,
  type SessionConnectionOptions,
} from './session-connection-tools.js';

export const CONNECTION_TOOL_INSTRUCTIONS =
  CONNECTION_ACCESS_INSTRUCTIONS + REPOSITORY_CHAT_INSTRUCTIONS + KNOWLEDGE_TOOL_INSTRUCTIONS;
/** Native API tools run on the host; shared OpenShell CLI guidance cannot grant their shell egress. */
export const API_CONNECTION_INSTRUCTIONS =
  '\nThis is a host API chat. For live Jira, call ListConnections and use approved ConnectionRequest reads through a Keychain connection. Load GetConnectionGuide for Jira setup and pagination. Shared ./mgmt jira guidance applies to the OpenShell transport; API Bash never receives connection credentials; its network policy is stated in the execution environment. Installing a CLI does not grant service authentication. Do not search editor configuration for credentials.\n';
export function sessionCredentialTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  toolPrefix = '',
  integrations?: SessionConnectionOptions['integrations'],
  assertRuntimeCurrent?: () => Promise<void>,
  assertRuntimeCurrentSync?: () => void,
  enableAgentTasks = false,
  connectionOptions: Pick<SessionConnectionOptions, 'boundary' | 'enableOwnedFrames'> = {},
) {
  const taskToolsEnabled = enableAgentTasks && !!assertRuntimeCurrent && !!assertRuntimeCurrentSync;
  const taskTools = taskToolsEnabled
    ? sessionAgentTaskTools(
        sessionId,
        session,
        registry,
        toolPrefix,
        assertRuntimeCurrent,
        assertRuntimeCurrentSync,
      )
    : undefined;
  const knowledgeTools = sessionKnowledgeTools(
    sessionId,
    session,
    registry,
    toolPrefix,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
  );
  const profileTools = sessionProfileTools(
    sessionId,
    session,
    registry,
    toolPrefix,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
  );
  const repositoryTools = sessionRepositoryTools(
    sessionId,
    session,
    registry,
    toolPrefix,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
  );
  const connections = sessionConnectionTools({
    sessionId,
    session,
    registry,
    toolPrefix,
    integrations,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
    ...connectionOptions,
  });
  return {
    definitions: filterAgentTools(session, [
      ...connections.definitions,
      ...repositoryTools.definitions,
      ...profileToolDefinitions,
      ...(taskToolsEnabled ? agentTaskToolDefinitions : []),
      ...knowledgeToolDefinitions,
    ]),
    async execute(
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      call?: ProfileToolCall,
    ) {
      if (connections.handles(name)) return connections.execute(name, input, signal);
      if (name === 'ReadKnowledge' || name === 'SaveKnowledgeDraft')
        return knowledgeTools.execute(name, input, signal);
      await assertRuntimeCurrent?.();
      if (!agentToolAllowed(session, name))
        return {
          content: 'Tool is not selected by this session’s published agent profile',
          isError: true,
        };
      const taskResult = await taskTools?.execute(name, input, signal, call);
      if (taskResult) return taskResult;
      const profileResult = await profileTools.execute(name, input, signal, call);
      if (profileResult) return profileResult;
      const repositoryResult = await repositoryTools.execute(name, input, signal);
      if (repositoryResult) return repositoryResult;
      return undefined;
    },
  };
}
