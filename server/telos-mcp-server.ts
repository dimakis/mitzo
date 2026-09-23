#!/usr/bin/env node
/** Telos MCP server — safe, structured outcome creation through Mitzo's internal API. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
  'TelosCreateOutcome',
  {
    description:
      'Create one durable Telos outcome with an explicit result, rationale, evidence criteria, and ordered milestone children. This mutates Telos and requires user approval.',
    inputSchema: {
      summary: z.string().trim().min(1).max(160).describe('Short, scannable outcome title'),
      intent: z.string().trim().min(1).max(2000).describe('What will be true when achieved'),
      rationale: z.string().trim().min(1).max(2000).describe('Why the outcome matters'),
      acceptanceCriteria: z
        .array(z.string().trim().min(1).max(500))
        .min(1)
        .max(12)
        .describe('Observable evidence that proves completion'),
      milestones: z
        .array(z.string().trim().min(1).max(500))
        .min(1)
        .max(24)
        .describe('Ordered milestones; the first unfinished entry is the next action'),
      profile: z.string().trim().min(1).max(100),
      contextHints: z
        .object({
          repos: z.array(z.string()).optional(),
          paths: z.array(z.string()).optional(),
          issues: z.array(z.string()).optional(),
          docIds: z.array(z.string()).optional(),
          people: z.array(z.string()).optional(),
          jiraKeys: z.array(z.string()).optional(),
          keywords: z.array(z.string()).optional(),
          taskHint: z.string().optional(),
        })
        .optional(),
      links: z
        .array(
          z.object({
            type: z.string(),
            url: z.string(),
            title: z.string(),
            description: z.string().optional(),
          }),
        )
        .max(24)
        .optional(),
    },
  },
  async (input) => {
    try {
      const response = await fetch(`${baseUrl}/api/internal/telos/outcomes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
          'X-Client-Id': clientId,
        },
        body: JSON.stringify(input),
      });
      const result = (await response.json()) as {
        error?: string;
        created?: boolean;
        item?: { id?: string; summary?: string };
      };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              created: result.created,
              id: result.item?.id,
              title: result.item?.summary,
              path: result.item?.id ? `/todos/${result.item.id}` : undefined,
            }),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
