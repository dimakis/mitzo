import { googleWorkspaceReadDefinition } from './google-workspace-read.js';
import { localRepositoryPreparationDefinition } from './local-repository-preparation-tool.js';
import { localRepositoryToolDefinitions } from './session-local-repository-tools.js';
import { taskMcpToolCatalog } from './task-mcp-selection.js';
import { githubMainPublicationTool } from './telos-main-publication.js';
import { agentTaskToolDefinitions } from './session-agent-task-tools.js';
import { agentCommunicationDefinitions } from './agent-communication-tools.js';
import type { AgentToolCatalogEntry } from '@mitzo/protocol';
import { nativeToolDefinitions } from './native-tool-executor.js';
import {
  credentialConnectionToolDefinitions,
  nativeConnectionToolNames,
} from './credential-connection-tools.js';
import { repositoryChatToolDefinitions } from './repository-chat-tools.js';
import { profileToolDefinitions } from './session-profile-tools.js';
import { webAccessDefinition } from './request-web-access.js';
import { githubPublishingDefinition } from './github-publishing-tool.js';
import { knowledgeToolDefinitions } from './session-knowledge-tools.js';
import { telosCreateOutcomeDefinition, telosAdoptSourceDefinition } from './telos-tool.js';
import { telosItemDefinitions } from './telos-item-tools.js';
import { telosBacklogDefinitions, isTelosBacklogTool } from './telos-backlog-tools.js';
import { telosArtifactDefinitions } from './telos-artifact-tools.js';
import { telosWorkControlDefinitions } from './telos-work-control-tools.js';
import { telosWorkDefinitions } from './telos-work-tools.js';
import { sessionHistoryToolDefinitions } from './session-history-tools.js';

const reads = new Set([
  'DiscoverLocalRepository',
  'InspectLocalRepository',
  'Read',
  'GitHubRead',
  'GoogleWorkspaceRead',
  'ListConnections',
  'GetConnectionGuide',
  'GetConnectionSetup',
  'GetSecretRelay',
  'ListRepositories',
  'GetRepositoryChatPreparation',
  'SymposiumReadProfiles',
  'AgentReadTasks',
  'TelosGetItem',
  'TelosListItems',
  'TelosSearchItems',
  'TelosFindArtifacts',
  'TelosReadArtifact',
  'ReadKnowledge',
  'SearchPastSessions',
  'ReadPastSession',
]);
const mixed = new Set([
  'TelosManageItem',
  'Bash',
  'ConnectionRequest',
  'HomeAssistantDashboard',
  'AgentCommunication',
]);
/** Read-only projection of executable registrations. No server discovery or credential reads. */
export function agentToolCatalog(): AgentToolCatalogEntry[] {
  const groups = [
    { source: 'Workspace', definitions: nativeToolDefinitions },
    { source: 'Google Workspace', definitions: [googleWorkspaceReadDefinition] },
    { source: 'Connections', definitions: credentialConnectionToolDefinitions },
    { source: 'Repositories', definitions: repositoryChatToolDefinitions },
    {
      source: 'Local repositories',
      definitions: [...localRepositoryToolDefinitions, localRepositoryPreparationDefinition],
    },
    {
      source: 'Agent Library',
      definitions: [...profileToolDefinitions, ...agentTaskToolDefinitions],
    },
    { source: 'Web', definitions: [webAccessDefinition] },
    { source: 'GitHub publishing', definitions: [githubPublishingDefinition] },
    { source: 'Knowledge', definitions: knowledgeToolDefinitions },
    { source: 'Agent communication', definitions: agentCommunicationDefinitions },
    { source: 'History', definitions: sessionHistoryToolDefinitions },
    {
      source: 'Telos',
      definitions: [
        githubMainPublicationTool,
        telosCreateOutcomeDefinition,
        telosAdoptSourceDefinition,
        ...telosItemDefinitions,
        ...telosBacklogDefinitions,
        ...telosArtifactDefinitions,
        ...telosWorkDefinitions,
        ...telosWorkControlDefinitions,
      ],
    },
  ];
  const builtin = groups.flatMap(({ source, definitions }) =>
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
        source === 'Google Workspace' ||
        source === 'Agent communication' ||
        source === 'History' ||
        source === 'Local repositories'
          ? ['codex-owned-local']
          : source === 'Telos'
            ? [
                githubMainPublicationTool.name,
                'TelosStartSlice',
                'TelosWorkControl',
                'TelosCreateOutcome',
                'TelosAdoptSource',
                'TelosSaveArtifact',
                'TelosReadArtifact',
                'TelosGetItem',
                'TelosUpdateItem',
                ...telosBacklogDefinitions.map((tool) => tool.name),
              ].includes(tool.name)
              ? ['codex-owned-local']
              : []
            : source === 'Agent Library' || source === 'Knowledge'
              ? ['local-api', 'codex-owned-local']
              : source === 'GitHub publishing'
                ? ['local-api', 'codex', 'codex-owned-local']
                : source === 'Workspace'
                  ? ['local-api', 'codex', 'codex-owned-local']
                  : source === 'Connections' || source === 'Web'
                    ? [
                        'local-api',
                        'codex',
                        ...(source === 'Web' || nativeConnectionToolNames.has(tool.name)
                          ? ['codex-owned-local']
                          : []),
                      ]
                    : ['local-api'],
      requirement:
        tool.name === 'GoogleWorkspaceRead'
          ? 'Requires the configured controller Google sign-in, current Local Mac owner and exact one-use read approval. Credentials remain private; selection grants no service access.'
          : tool.name === githubMainPublicationTool.name
            ? 'Requires a current Telos lead or worker role, an explicitly selected native tool, separately configured account-bound merge capability and one-use operator approval.'
            : tool.name === 'TelosWorkControl'
              ? 'Requires explicit native tool selection, a current retained lead or worker role and original request-only tool approval. The existing coordinator and scope checks still control every operation; selection grants no role or hold authority.'
              : tool.name === 'TelosStartSlice'
                ? 'Requires explicit native tool selection, this conversation’s current retained lead role and original tool approval. Allocates only the exact reviewed child; selection grants no lead role or model execution.'
                : [
                      'TelosCreateOutcome',
                      'TelosAdoptSource',
                      'TelosSaveArtifact',
                      'TelosReadArtifact',
                    ].includes(tool.name)
                  ? 'Requires explicit native tool selection, current signed operator and exact one-use approval. Artifact reads require a retained exact revision; writes use the canonical Telos store.'
                  : isTelosBacklogTool(tool.name)
                    ? 'Requires the current authenticated operator and original tool selection; brief and lifecycle mutations use exact request approval. Browsing and maintenance require no lead assignment.'
                    : source === 'Telos'
                      ? ['TelosGetItem', 'TelosUpdateItem'].includes(tool.name)
                        ? 'Requires explicit native selection, a current retained lead and its current canonical assignment for this item or exact direct child, plus request-only approval. Writes retain fresh revision, evidence and original receipt checks; selection grants no completion authority.'
                        : 'Explicit profile selection is not supported on this native OpenShell route.'
                      : [
                            'ConnectionRequest',
                            'ConnectionWebSocket',
                            'HomeAssistantDashboard',
                            'RequestConnectionAccess',
                          ].includes(tool.name)
                        ? 'Requires a configured connection and current session approval. Missing connections must be set up in Connections; selection grants no access.'
                        : source === 'Local repositories'
                          ? tool.name === localRepositoryPreparationDefinition.name
                            ? 'Requires a Local Mac Codex chat with native command and file tools (Bash, Read, Write and Edit) selected. Approve the displayed repository and task changes each time, in every mode. Selecting this tool grants no access. The prepared task becomes active after the current turn finishes.'
                            : 'Requires the current signed native call and qualified original base read scope, with current account, tool and skill gates. Reads do not prepare a task or grant filesystem access.'
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
                                    : source === 'History'
                                      ? 'Requires the current signed native operator and original owned-local call. Reads only registered visible durable history within current tool and skill scope; no SDK transcript or credential discovery.'
                                      : 'Existing session permissions, cancellation and runtime admission apply.',
    })),
  );
  return [...taskMcpToolCatalog(), ...builtin];
}
