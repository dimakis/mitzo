#!/usr/bin/env node
/**
 * Repo MCP Server — exposes open_repo and list_repos tools to the Agent SDK.
 *
 * Launched as a child process by Mitzo's chat.ts. Calls back to the Mitzo
 * HTTP API to provision worktrees. Receives config as CLI args + env:
 *   --base-url <url>  --client-id <id>  env MITZO_INTERNAL_TOKEN
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function parseArgs(argv: string[]): { baseUrl: string; clientId: string; token: string } {
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
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data;
}

const server = new McpServer({ name: 'mitzo-repos', version: '1.0.0' });

server.registerTool(
  'open_repo',
  {
    description:
      'Open an isolated worktree for a named repository. Returns the absolute path to use for all file operations in that repo. Idempotent — calling again returns the same path.',
    inputSchema: {
      repo: z.string().describe('Repository name (e.g. "mgmt", "team_home", "mitzo")'),
    },
  },
  async ({ repo }) => {
    try {
      const data = (await apiCall('POST', '/api/repos/open', {
        repoName: repo,
        clientId: config.clientId,
      })) as { path: string; repoName: string; created: boolean };
      const status = data.created ? 'Created new worktree' : 'Using existing worktree';
      return {
        content: [
          {
            type: 'text' as const,
            text: `${status} for "${data.repoName}" at:\n${data.path}\n\nUse this absolute path for all file operations in this repo.`,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
    }
  },
);

server.registerTool(
  'list_repos',
  {
    description: 'List available repositories that can be opened with open_repo.',
    inputSchema: {},
  },
  async () => {
    try {
      const data = (await apiCall('GET', '/api/repos')) as Array<{ name: string; path: string }>;
      const lines = data.map((r) => `- ${r.name}: ${r.path}`).join('\n');
      return {
        content: [{ type: 'text' as const, text: `Available repositories:\n${lines}` }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Repo MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
