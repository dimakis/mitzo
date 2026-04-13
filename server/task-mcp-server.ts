#!/usr/bin/env node
/**
 * Task Board MCP Server — exposes TaskSet, TaskComplete, TaskStatus,
 * TaskBlock tools to the Agent SDK.
 *
 * Launched as a child process by Mitzo's chat.ts. Calls back to the
 * Mitzo HTTP API for all operations. Receives config as CLI args + env:
 *   --base-url <url>  --client-id <id>  env MITZO_INTERNAL_TOKEN
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function parseArgs(argv: string[]): {
  baseUrl: string;
  clientId: string;
  token: string;
} {
  let baseUrl = '';
  let clientId = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url' && argv[i + 1]) baseUrl = argv[++i];
    else if (argv[i] === '--client-id' && argv[i + 1]) clientId = argv[++i];
  }
  const token = process.env.MITZO_INTERNAL_TOKEN || '';
  if (!baseUrl || !clientId || !token) {
    throw new Error('Missing required args: --base-url, --client-id; env: MITZO_INTERNAL_TOKEN');
  }
  return { baseUrl, clientId, token };
}

const config = parseArgs(process.argv.slice(2));

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': config.token,
      'X-Client-Id': config.clientId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data;
}

const server = new McpServer({ name: 'task-board', version: '1.0.0' });

server.registerTool(
  'TaskSet',
  {
    description:
      "Replace the current task's subtasks with a new decomposition. " +
      'Deletes existing children and creates new ones.',
    inputSchema: {
      tasks: z
        .array(
          z.object({
            title: z.string().describe('Subtask title'),
            description: z.string().optional().describe('Optional details'),
            priority: z.number().optional().describe('Priority (higher = first)'),
          }),
        )
        .min(1)
        .describe('List of subtasks to create'),
    },
  },
  async ({ tasks }) => {
    try {
      const data = (await apiCall('POST', '/api/internal/task-tools/set', { tasks })) as {
        result: string;
      };
      return { content: [{ type: 'text' as const, text: data.result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

server.registerTool(
  'TaskComplete',
  {
    description: 'Mark the current task as completed with a summary of what was done.',
    inputSchema: {
      summary: z.string().min(1).describe('Summary of what was accomplished'),
    },
  },
  async ({ summary }) => {
    try {
      const data = (await apiCall('POST', '/api/internal/task-tools/complete', { summary })) as {
        result: string;
      };
      return { content: [{ type: 'text' as const, text: data.result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

server.registerTool(
  'TaskStatus',
  {
    description: 'Get the status of the current task, its siblings, and progress.',
    inputSchema: {},
  },
  async () => {
    try {
      const data = (await apiCall('GET', '/api/internal/task-tools/status')) as { result: string };
      return { content: [{ type: 'text' as const, text: data.result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

server.registerTool(
  'TaskBlock',
  {
    description: 'Mark the current task as blocked with a reason.',
    inputSchema: {
      reason: z.string().min(1).describe('Why this task is blocked'),
    },
  },
  async ({ reason }) => {
    try {
      const data = (await apiCall('POST', '/api/internal/task-tools/block', { reason })) as {
        result: string;
      };
      return { content: [{ type: 'text' as const, text: data.result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`task-mcp-server fatal: ${err}\n`);
  process.exit(1);
});
