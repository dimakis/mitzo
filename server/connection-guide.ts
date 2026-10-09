import type { ToolDefinition } from '@mitzo/harness';

export type ConnectionGuideTopic = 'connect' | 'use' | 'troubleshoot';

// This guidance ships with the tool handlers, rather than depending on a mutable
// external knowledge publication. The spoke can link to GetConnectionGuide.
const instructions: Record<ConnectionGuideTopic, string> = {
  connect: `Stay in the user's original task. Call ListConnections before preparing a new service. If an existing connection matches, use it after session approval. Otherwise ask only for the service address and information that cannot be established from documentation.
For Home Assistant, call PrepareConnectionSetup with profile "home-assistant", its HTTPS origin, and access "read" or "read-write" according to the task. Mitzo supplies its supported authentication, paths, verification, and dashboard transport. Do not ask the user to choose a protocol or authentication exchange.
For a custom REST service, research its official authentication and API documentation with available web tools. Use the documented custom authentication, paths, methods, verificationPath, evidenceUrl, and success selector in PrepareConnectionSetup; never guess or probe by sending credentials to an unverified destination. The success selector identifies a documented top-level JSON field by exact value ({field,equals}) or shape ({field,type}); successful HTTP status or an HTML login page is insufficient. If documentation is ambiguous or unsupported, ask one targeted question. OAuth/browser sign-in and arbitrary WebSocket authentication are not supported by this setup tool.
PrepareConnectionSetup returns {setup} containing a secure setupUrl and credential guidance. Show that link/card and briefly explain how to get the credential. Ask the user to enter it only in the secure setup page, never in chat, workspace files, or tool arguments. Secret values are stored privately by Mitzo and never returned to you. The setup page supplies only the missing credential and verifies the prepared connection.
GetConnectionSetup reports setup progress for this chat. Pending/verifying means wait for secure completion; cancelled/expired means offer a fresh setup when requested. When ready, continue the original task using connectionId, request session access, and read the relevant service state before performing an action. Setup completion never authorizes or performs the original action. Do not poll repeatedly, re-create the setup, or repeat a side effect after a completion notification. The running Mitzo tool registry below is authoritative for available capabilities.`,
  use: `Call ListConnections to discover destinations and permissions, then RequestConnectionAccess when needed. Approval is scoped to this chat, including reconnects, and Mitzo injects credentials privately. ConnectionRequest accepts a relative path within configured permissions. HTTP reachability alone is not proof of authenticated access.
Use HomeAssistantDashboard for Home Assistant dashboard operations: read before saving, preserve unrelated views/cards, and provide the returned configHash as expectedConfigHash. Redacted reads are not editable. An unconfirmed save may have applied; read again before any retry.
ConnectionWebSocket sends a single bounded text command through an already configured service transport. It is treated as a write, never automatically reconnected or replayed. Authentication comes from the connection; never supply credentials, authentication frames, or a destination URL. Verify service state after an unconfirmed command before retrying. Ask mode permits reads only. If a service is missing, load GetConnectionGuide with topic "connect" and prepare setup within this task.`,
  troubleshoot: `Use ListConnections and GetConnectionSetup to inspect this chat's non-secret status. Distinguish a saved connection, authenticated verification, and this chat's approved access. Do not search files for tokens or ask for secrets in chat. Authentication failures need a focused secure credential update; unavailable Keychain or host configuration needs the operator to configure Mitzo. A cancelled or expired setup cannot be completed. Request a fresh setup only when the user wants to continue.
Use the selected service's official documentation for generic authentication issues. Never infer authentication from a successful unauthenticated status endpoint. Never automatically repeat an unconfirmed command or dashboard save; inspect current service state first. Setup completion messages are informational and do not authorize additional actions.`,
};

export function connectionGuide(
  topic: ConnectionGuideTopic,
  definitions: readonly ToolDefinition[],
) {
  return {
    topic,
    version: 1,
    source: 'mitzo-runtime',
    instructions: instructions[topic],
    tools: definitions.map(({ name }) => name),
  };
}
