import { GoogleAuth } from 'google-auth-library';
import type { ModelSession, ModelSessionConfig } from '@mitzo/harness';
import { GeminiSession } from './gemini-session.js';
import { geminiThinkingConfig } from './gemini-thinking.js';
import { loadAccountProfiles } from './account-profiles.js';
import type { AdviserRequest } from './terminal-adviser.js';
import { createNativeAdviserSession, type AdviserFeatureOwner } from './adviser-harness-runtime.js';

/** Gemini remains deferred; all supported OpenAI and Claude advice uses the shared harness owners. */
export async function createTerminalAdviserSession(
  config: ModelSessionConfig,
  request: AdviserRequest,
  owner?: AdviserFeatureOwner,
): Promise<ModelSession> {
  if (request.accountId.startsWith('chatgpt_plan_'))
    throw Error(
      'This saved adviser registration is retained. Select an explicitly configured Codex subscription account to continue; registration credentials are never substituted.',
    );
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve(request.accountId, request.model);
  profiles.validateModelSelection(binding, request.model, request.reasoningEffort);
  if (binding.provider !== 'google-vertex') {
    if (!owner) throw Error('Authenticated adviser feature owner required');
    return createNativeAdviserSession(config, request, owner, binding);
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
  throw Error('Selected adviser harness unavailable');
}
