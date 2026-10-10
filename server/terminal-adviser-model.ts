import { join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { ResponsesSession, type ModelSession, type ModelSessionConfig } from '@mitzo/harness';
import { GeminiSession } from './gemini-session.js';
import { geminiThinkingConfig } from './gemini-thinking.js';
import { loadAccountProfiles } from './account-profiles.js';
import { credentials } from './credentials.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { assertOpenAIKeyController } from './openai-key-controller.js';
import { openAIKeyResourceBindings } from './openai-key-operation-store.js';
import type { AdviserRequest } from './terminal-adviser.js';

/** Native inference APIs only. No CLI agent, inherited tools, credentials or route fallback. */
export async function createTerminalAdviserSession(
  config: ModelSessionConfig,
  request: AdviserRequest,
): Promise<ModelSession> {
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve(request.accountId, request.model);
  profiles.validateModelSelection(binding, request.model, request.reasoningEffort);
  if (binding.provider === 'openai-codex')
    throw Error('ChatGPT subscription adviser requires an isolated inference-only runtime');
  if (binding.provider === 'openai') {
    const profile = profiles.apiProfile(binding),
      runtime = getConnectionsRuntime();
    if (
      profiles.isEnrolledOpenAIAccount(binding.accountId) &&
      !runtime?.openAIEnrollmentAuthority?.manages(binding.accountId)
    )
      throw Error('Enrolled account controller unavailable');
    assertOpenAIKeyController(
      binding.accountId,
      join(process.env.REPO_PATH ?? process.cwd(), '.mitzo'),
      !!runtime?.assertOpenAIKeyReady,
      openAIKeyResourceBindings({
        credentialRef: profile.credentialRef,
        providerName: profile.sandboxProvider,
        providerId: profile.sandboxProviderId,
      }),
    );
    const manager = runtime?.openAIEnrollmentAuthority?.manages(binding.accountId)
      ? runtime.openAIEnrollmentAuthority
      : runtime?.openAIKeys?.manages(binding.accountId)
        ? runtime.openAIKeys
        : undefined;
    const signal = config.signal ?? AbortSignal.timeout(60000);
    const apiKey = manager
      ? await manager.resolveKey(binding.accountId, signal)
      : runtime?.assertOpenAIKeyReady
        ? await runtime.service.withCredentialMutation(async () => {
            await runtime.assertOpenAIKeyReady!(binding.accountId, signal);
            return credentials.resolve(profile.credentialRef);
          })
        : await credentials.resolve(profile.credentialRef);
    return new ResponsesSession(
      { ...config, tools: [] },
      { accountId: binding.accountId, apiKey, textTranscript: true },
    );
  }
  if (binding.provider === 'google-vertex') {
    geminiThinkingConfig(config.model, config.reasoningEffort, true);
    const profile = profiles.googleProfile(binding);
    const auth = new GoogleAuth({
      keyFilename: profile.credentialRef,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    return new GeminiSession(
      { ...config, tools: [] },
      {
        accountId: binding.accountId,
        textTranscript: true,
        projectId: profile.projectId,
        region: profile.region,
        getAccessToken: async () => {
          const token = await auth.getAccessToken();
          if (!token) throw Error('Selected account credential unavailable');
          return token;
        },
      },
    );
  }
  const env = profiles.sdkEnv(binding, {});
  const projectId = env.ANTHROPIC_VERTEX_PROJECT_ID,
    region = env.CLOUD_ML_REGION;
  if (!projectId || !region || !env.GOOGLE_APPLICATION_CREDENTIALS)
    throw Error('Selected Vertex profile unavailable');
  const client = new AnthropicVertex({
    projectId,
    region,
    baseURL:
      region === 'global'
        ? 'https://aiplatform.googleapis.com/v1'
        : `https://${region}-aiplatform.googleapis.com/v1`,
    googleAuth: new GoogleAuth({
      keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }),
    maxRetries: 0,
  });
  const effort = config.reasoningEffort;
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
    throw Error('Thinking mode unavailable');
  return {
    provider: 'anthropic-vertex',
    async *turn(messages) {
      const response = await client.messages.create(
        {
          model: config.model,
          system: config.systemPrompt,
          max_tokens: config.maxTokens,
          messages: messages.map((message) => ({
            role: message.role,
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text)
                    .join('\n'),
          })),
          tools: [],
          ...(effort
            ? {
                thinking: { type: 'adaptive' as const },
                output_config: { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
              }
            : {}),
        },
        { signal: config.signal },
      );
      for (const [index, block] of response.content.entries()) {
        if (block.type === 'tool_use') throw Error('Adviser tools unavailable');
        if (block.type === 'text')
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text },
          };
      }
    },
  };
}
