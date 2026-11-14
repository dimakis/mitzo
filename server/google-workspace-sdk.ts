import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import {
  GoogleWorkspaceReadSchema,
  googleWorkspaceReadDefinition,
} from './google-workspace-read.js';
import { sessionGoogleWorkspaceTools } from './session-google-workspace-tools.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { copyCallbackOutcome, type TurnCallbackRunner } from './turn-callbacks.js';
import { qualifyToolResult, reportToolFailure } from './tool-failure-reporting.js';

/** MCP accepts the canonical union schema; the SDK tool() helper only accepts object shapes. */
export function registerGoogleWorkspaceSdkTool(
  server: McpServer,
  sessionId: () => string | undefined,
  session: ManagedSession,
  registry: SessionRegistry,
  boundary: {
    assertCurrent(signal: AbortSignal): Promise<void>;
    assertCurrentSync(signal: AbortSignal): void;
    runCallback?: TurnCallbackRunner;
  },
) {
  const name = googleWorkspaceReadDefinition.name;
  if (!agentToolAllowed(session, name) || !getConnectionsRuntime()?.googleWorkspace) return;
  server.registerTool(
    name,
    {
      description: googleWorkspaceReadDefinition.description,
      inputSchema: GoogleWorkspaceReadSchema,
    },
    async (input, extra) => {
      const signal = AbortSignal.any([session.abortController.signal, extra.signal]);
      return (boundary.runCallback ?? ((work) => work()))(async () => {
        try {
          signal.throwIfAborted();
          await boundary.assertCurrent(signal);
          const id = sessionId();
          if (!id) throw Error('Original Google read session unavailable');
          const tools = sessionGoogleWorkspaceTools({
            sessionId: id,
            session,
            registry,
            toolName: `mcp__mitzo-connections__${name}`,
            assertCurrent: () => boundary.assertCurrent(signal),
            assertCurrentSync: () => boundary.assertCurrentSync(signal),
          });
          const result = qualifyToolResult(name, input, signal, await tools.execute(input, signal));
          await boundary.assertCurrent(signal);
          signal.throwIfAborted();
          return copyCallbackOutcome(result, {
            content: [{ type: 'text' as const, text: result.content }],
            isError: result.isError,
          });
        } catch (error) {
          const result = reportToolFailure(error, {
            sessionId: sessionId() ?? 'unavailable',
            tool: name,
            signal,
          });
          // The original query owns authority retirement; do not turn its refusal into success.
          boundary.assertCurrentSync(signal);
          signal.throwIfAborted();
          return copyCallbackOutcome(result, {
            content: [{ type: 'text' as const, text: result.content }],
            isError: true,
          });
        }
      });
    },
  );
}
