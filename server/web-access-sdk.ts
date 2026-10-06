import { randomUUID } from 'node:crypto';
import {
  GithubPublishingFields,
  githubPublishingDefinition,
  REQUEST_GITHUB_PUBLISH,
} from './github-publishing-tool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { buildPermissionHandler } from '@mitzo/harness';
import {
  webAccessDefinition,
  REQUEST_WEB_ACCESS,
  WebAccessToolFields,
} from './request-web-access.js';
export const GITHUB_PUBLISH_SDK_TOOL = 'mcp__mitzo-web-access__RequestGithubPublish';
export const WEB_ACCESS_SDK_TOOL = 'mcp__mitzo-web-access__RequestWebAccess';

export function createWebAccessSdkServer(
  execute: (input: unknown, signal: AbortSignal) => Promise<{ content: string; isError: boolean }>,
  sessionSignal: AbortSignal,
  publish?: (
    input: unknown,
    signal: AbortSignal,
    call: { turnId: string; callId: string },
  ) => Promise<{ content: string; isError: boolean }>,
): McpSdkServerConfigWithInstance {
  const publishingRuntimeId = randomUUID();
  const instance = new McpServer({ name: 'mitzo-web-access', version: '1.0.0' });
  instance.registerTool(
    REQUEST_WEB_ACCESS,
    {
      description: webAccessDefinition.description,
      inputSchema: WebAccessToolFields,
    },
    async (input, extra) => {
      const result = await execute(input, AbortSignal.any([sessionSignal, extra.signal]));
      return { content: [{ type: 'text', text: result.content }], isError: result.isError };
    },
  );
  if (publish)
    instance.registerTool(
      REQUEST_GITHUB_PUBLISH,
      { description: githubPublishingDefinition.description, inputSchema: GithubPublishingFields },
      async (input, extra) => {
        const result = await publish(input, AbortSignal.any([sessionSignal, extra.signal]), {
          turnId: `sdk:${publishingRuntimeId}`,
          callId: String(extra.requestId),
        });
        return { content: [{ type: 'text', text: result.content }], isError: result.isError };
      },
    );
  return { type: 'sdk', name: 'mitzo-web-access', instance };
}

/** The inner shared executor always gates this tool, including Auto, cached grants and hooks. */
export function webAccessSdkPermission(
  decide: ReturnType<typeof buildPermissionHandler>,
): ReturnType<typeof buildPermissionHandler> {
  return (name, input, opts) =>
    name === WEB_ACCESS_SDK_TOOL || name === GITHUB_PUBLISH_SDK_TOOL
      ? Promise.resolve({ behavior: 'allow', updatedInput: input })
      : decide(name, input, opts);
}
