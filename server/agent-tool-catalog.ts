import { githubMainPublicationTool } from './telos-main-publication.js';
import { agentTaskToolDefinitions } from './session-agent-task-tools.js';
import { agentCommunicationDefinitions } from './agent-communication-tools.js';
import type { AgentToolCatalogEntry } from '@mitzo/protocol';
import { nativeToolDefinitions } from './native-tool-executor.js';
import { credentialConnectionToolDefinitions } from './credential-connection-tools.js';
import { repositoryChatToolDefinitions } from './repository-chat-tools.js';
import { profileToolDefinitions } from './session-profile-tools.js';
import { webAccessDefinition } from './request-web-access.js';
import { githubPublishingDefinition } from './github-publishing-tool.js';
import { knowledgeToolDefinitions } from './session-knowledge-tools.js';
import { telosCreateOutcomeDefinition, telosAdoptSourceDefinition } from './telos-tool.js';
import { telosItemDefinitions } from './telos-item-tools.js';
import { telosArtifactDefinitions } from './telos-artifact-tools.js';
import { telosWorkControlDefinitions } from './telos-work-control-tools.js';
import { telosWorkDefinitions } from './telos-work-tools.js';

const reads = new Set([
  'Read',
  'GitHubRead',
  'ListConnections',
  'GetConnectionGuide',
  'GetConnectionSetup',
  'ListRepositories',
  'GetRepositoryChatPreparation',
  'SymposiumReadProfiles',
  'AgentReadTasks',
  'TelosGetItem',
  'TelosFindArtifacts',
  'TelosReadArtifact',
  'ReadKnowledge',
]);
const mixed = new Set([
  'Bash',
  'ConnectionRequest',
  'HomeAssistantDashboard',
  'AgentCommunication',
]);
/** Read-only projection of executable registrations. No server discovery or credential reads. */
export function agentToolCatalog(): AgentToolCatalogEntry[] {
  const groups = [
    { source: 'Workspace', definitions: nativeToolDefinitions },
    { source: 'Connections', definitions: credentialConnectionToolDefinitions },
    { source: 'Repositories', definitions: repositoryChatToolDefinitions },
    {
      source: 'Agent Library',
      definitions: [...profileToolDefinitions, ...agentTaskToolDefinitions],
    },
    { source: 'Web', definitions: [webAccessDefinition] },
    { source: 'GitHub publishing', definitions: [githubPublishingDefinition] },
    { source: 'Knowledge', definitions: knowledgeToolDefinitions },
    { source: 'Agent communication', definitions: agentCommunicationDefinitions },
    {
      source: 'Telos',
      definitions: [
        githubMainPublicationTool,
        telosCreateOutcomeDefinition,
        telosAdoptSourceDefinition,
        ...telosItemDefinitions,
        ...telosArtifactDefinitions,
        ...telosWorkDefinitions,
        ...telosWorkControlDefinitions,
      ],
    },
  ];
  return groups.flatMap(({ source, definitions }) =>
    definitions.map((tool) => ({
      id: `mitzo:${tool.name}`,
      version: 1,
      name: tool.name,
      description: tool.description,
      source,
      required: tool.name === 'AskUserQuestion',
      behavior:
        tool.name === 'AskUserQuestion'
          ? ('interaction' as const)
          : reads.has(tool.name)
            ? ('read' as const)
            : mixed.has(tool.name)
              ? ('mixed' as const)
              : ('write' as const),
      routes:
        source === 'Agent communication'
          ? ['codex-owned-local']
          : source === 'Telos'
            ? [
                githubMainPublicationTool.name,
                'TelosCreateOutcome',
                'TelosAdoptSource',
                'TelosSaveArtifact',
                'TelosReadArtifact',
              ].includes(tool.name)
              ? ['codex-owned-local']
              : []
            : source === 'Agent Library'
              ? ['local-api', 'codex-owned-local']
              : source === 'GitHub publishing'
                ? ['local-api', 'codex', 'codex-owned-local']
                : source === 'Workspace'
                  ? ['local-api', 'codex', 'codex-owned-local']
                  : source === 'Connections' || source === 'Web'
                    ? ['local-api', 'codex']
                    : ['local-api'],
      requirement:
        tool.name === githubMainPublicationTool.name
          ? 'Requires a current Telos lead or worker role, an explicitly selected native tool, separately configured account-bound merge capability and one-use operator approval.'
          : [
                'TelosCreateOutcome',
                'TelosAdoptSource',
                'TelosSaveArtifact',
                'TelosReadArtifact',
              ].includes(tool.name)
            ? 'Requires explicit native tool selection, current signed operator and exact one-use approval. Artifact reads require a retained exact revision; writes use the canonical Telos store.'
            : source === 'Telos'
              ? 'Explicit profile selection is not supported on this native OpenShell route.'
              : [
                    'ConnectionRequest',
                    'ConnectionWebSocket',
                    'HomeAssistantDashboard',
                    'RequestConnectionAccess',
                  ].includes(tool.name)
                ? 'Requires a configured connection and current session approval. Missing connections must be set up in Connections; selection grants no access.'
                : source === 'Repositories'
                  ? 'Requires an authorized repository connection for the selected account.'
                  : source === 'GitHub publishing' || tool.name === 'GitHubRead'
                    ? 'Requires existing GitHub access and the usual action approval.'
                    : tool.name === 'Bash'
                      ? 'Requires an available OS sandbox and existing workspace permissions; no network or credentials.'
                      : source === 'Web'
                        ? 'Requires supported provider web search and current approval.'
                        : source === 'Knowledge'
                          ? 'Requires host Knowledge Library enrollment and current interactive operator authorization. Draft saves do not submit review or change accepted knowledge.'
                          : 'Existing session permissions, cancellation and runtime admission apply.',
    })),
  );
}
