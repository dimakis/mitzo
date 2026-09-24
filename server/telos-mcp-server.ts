#!/usr/bin/env node
/** Telos MCP server — safe, structured outcome creation through Mitzo's internal API. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  executeTelosCreateOutcome,
  telosOutcomeShape,
  TELOS_CREATE_OUTCOME_TOOL,
} from './telos-tool.js';

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

const baseUrl = readArg('--base-url');
const clientId = readArg('--client-id');
const token = process.env.MITZO_INTERNAL_TOKEN ?? '';
if (!baseUrl || !clientId || !token) throw new Error('Missing Telos MCP configuration');

const server = new McpServer({ name: 'telos', version: '1.0.0' });

server.registerTool(
  TELOS_CREATE_OUTCOME_TOOL,
  {
    description:
      'Create one durable Telos outcome with an explicit result, rationale, evidence criteria, and ordered milestone children. This mutates Telos and requires user approval.',
    inputSchema: telosOutcomeShape,
  },
  async (input) => {
    const result = await executeTelosCreateOutcome(baseUrl, clientId, token, input);
    return {
      content: [{ type: 'text' as const, text: result.content }],
      ...(result.isError ? { isError: true } : {}),
    };
  },
);

await server.connect(new StdioServerTransport());
