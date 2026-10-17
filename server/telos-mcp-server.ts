#!/usr/bin/env node
import {
  telosArtifactDefinitions,
  telosSaveArtifactShape,
  telosFindArtifactsShape,
  telosReadArtifactShape,
  executeTelosArtifactTool,
  type TelosArtifactToolName,
} from './telos-artifact-tools.js';
/** Telos MCP server — safe, structured outcome creation through Mitzo's internal API. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  executeTelosWorkTool,
  TelosStartSliceInputSchema,
  TELOS_START_SLICE_TOOL,
  telosWorkDefinitions,
} from './telos-work-tools.js';
import {
  telosItemDefinitions,
  telosItemSchemas,
  executeTelosItemTool,
  type TelosItemToolName,
} from './telos-item-tools.js';
import {
  executeTelosCreateOutcome,
  telosOutcomeShape,
  TELOS_CREATE_OUTCOME_TOOL,
  telosApprovalExecutionField,
  TELOS_ADOPT_SOURCE_TOOL,
  TelosAdoptSourceInput,
  executeTelosAdoptSource,
} from './telos-tool.js';

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

const baseUrl = readArg('--base-url');
const clientId = readArg('--client-id');
const sessionId = readArg('--session-id');
const token = process.env.MITZO_INTERNAL_TOKEN ?? '';
if (!baseUrl || !clientId || !token) throw new Error('Missing Telos MCP configuration');

const server = new McpServer({ name: 'telos', version: '1.0.0' });
if (sessionId) {
  server.registerTool(
    TELOS_START_SLICE_TOOL,
    {
      description: telosWorkDefinitions[0].description,
      inputSchema: TelosStartSliceInputSchema.shape,
    },
    async (input: Record<string, unknown>) => {
      const result = await executeTelosWorkTool(
        baseUrl,
        clientId,
        sessionId,
        token,
        TELOS_START_SLICE_TOOL,
        input,
      );
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}

server.registerTool(
  TELOS_CREATE_OUTCOME_TOOL,
  {
    description:
      'Create one durable Telos outcome with an explicit result, rationale, evidence criteria, and ordered milestone children. This mutates Telos and requires user approval.',
    inputSchema: { ...telosOutcomeShape, ...telosApprovalExecutionField },
  },
  async (input: Record<string, unknown>) => {
    const result = await executeTelosCreateOutcome(baseUrl, clientId, token, input);
    return {
      content: [{ type: 'text' as const, text: result.content }],
      ...(result.isError ? { isError: true } : {}),
    };
  },
);
server.registerTool(
  TELOS_ADOPT_SOURCE_TOOL,
  {
    description:
      'Adopt an explicitly reviewed original exchange and retained materials into one exact existing Telos item. Requires one operator source review; no progress, assignment or execution change.',
    inputSchema: { ...TelosAdoptSourceInput.shape, ...telosApprovalExecutionField },
  },
  async (input: Record<string, unknown>) => {
    const result = await executeTelosAdoptSource(baseUrl, clientId, token, input);
    return {
      content: [{ type: 'text' as const, text: result.content }],
      ...(result.isError ? { isError: true } : {}),
    };
  },
);

for (const definition of telosArtifactDefinitions) {
  const name = definition.name as TelosArtifactToolName;
  const shape = {
    TelosSaveArtifact: telosSaveArtifactShape,
    TelosFindArtifacts: telosFindArtifactsShape,
    TelosReadArtifact: telosReadArtifactShape,
  }[name];
  server.registerTool(
    name,
    { description: definition.description, inputSchema: shape },
    async (input: Record<string, unknown>) => {
      const result = await executeTelosArtifactTool(baseUrl, clientId, token, name, input);
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}
for (const definition of telosItemDefinitions) {
  const name = definition.name as TelosItemToolName;
  server.registerTool(
    name,
    { description: definition.description, inputSchema: telosItemSchemas[name].shape },
    async (input: Record<string, unknown>) => {
      const result = await executeTelosItemTool(baseUrl, clientId, token, name, input);
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}
await server.connect(new StdioServerTransport());
