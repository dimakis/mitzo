import type { AccountBinding } from '@mitzo/protocol';
import { readCodexModels } from './model-catalog.js';
import type { AccountProfiles } from './account-profiles.js';
import { createCodexNativeSeat, type OpenAiCodexSeatInput } from './symposium-codex-native.js';

/** Native login only: no inference.local, API key provider, or host login fallback. */
export const SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND = [
  '/usr/local/bin/symposium-subscription-app-server',
] as const;

export function assertSubscriptionControllerCommand(command: readonly string[]): void {
  if (
    command.length !== SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND.length ||
    command.some((part, index) => part !== SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND[index])
  )
    throw new Error('Subscription controller command differs from the reviewed native launcher');
}

/** Trusted host proof of real provider-account ownership, exact profile revision,
 * model, physical sandbox and active seat membership. Synthetic account/read
 * fields and caller-supplied booleans are never acceptable evidence. */
export type VerifySymposiumSubscriptionAuth = (
  input: Pick<OpenAiCodexSeatInput, 'sandbox' | 'execution' | 'route'>,
) => Promise<void>;

export function resolveSymposiumSubscriptionRoute(
  profiles: AccountProfiles,
  binding: AccountBinding,
) {
  if (binding.provider !== 'openai-codex') throw new Error('Not a ChatGPT subscription account');
  const profile = profiles.codexProfile(binding);
  if (profile.planType === 'api' || profile.workspaceId)
    throw new Error('Native Symposium subscription requires a personal ChatGPT account');
  if (
    profile.credentialRef ||
    profile.sandboxProviderType !== 'codex' ||
    profile.sandboxGrantId ||
    profile.nativeAuth !== 'sandbox-chatgpt' ||
    !profile.sandboxProvider ||
    !profile.sandboxProviderId
  )
    throw new Error('Native Symposium subscription cannot import host or brokered credentials');
  return {
    kind: 'chatgpt-subscription-native' as const,
    accountId: binding.accountId,
    provider: profile.sandboxProvider,
    providerId: profile.sandboxProviderId,
    profile,
    model: binding.model,
  };
}

export async function createChatGptSubscriptionSeat(
  input: OpenAiCodexSeatInput & {
    verifyPrivateAuth: VerifySymposiumSubscriptionAuth;
    assertSubscriptionDispatch?: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => void;
  },
) {
  if (input.route.kind !== 'chatgpt-subscription-native')
    throw new Error('ChatGPT native seat requires a subscription route');
  const { profile } = input.route;
  const binding = input.execution.seat.accountBinding;
  if (
    !binding ||
    binding.provider !== 'openai-codex' ||
    binding.accountId !== profile.accountId ||
    input.route.accountId !== profile.accountId ||
    binding.model !== profile.model ||
    input.route.model !== profile.model ||
    input.route.provider !== profile.sandboxProvider ||
    input.route.providerId !== profile.sandboxProviderId
  )
    throw new Error('ChatGPT native seat account or model changed');
  if (
    profile.credentialRef ||
    profile.sandboxProviderType !== 'codex' ||
    profile.nativeAuth !== 'sandbox-chatgpt' ||
    !profile.sandboxProvider ||
    !profile.sandboxProviderId ||
    profile.sandboxGrantId ||
    profile.workspaceId ||
    profile.planType === 'api'
  )
    throw new Error('ChatGPT native seat cannot use host, workspace, API or brokered credentials');
  if (typeof input.verifyPrivateAuth !== 'function')
    throw new Error('Private ChatGPT credential custody is not verified');
  if (!input.createConversation && typeof input.assertSubscriptionDispatch !== 'function')
    throw new Error('Private ChatGPT dispatch authorization is unavailable');
  await input.verifyPrivateAuth(input);
  input.execution.signal.throwIfAborted();
  return createCodexNativeSeat(input, {
    profile,
    modelProvider: 'openai',
    runtimeConfig: { forced_login_method: 'chatgpt' },
    assertCommand: assertSubscriptionControllerCommand,
    beforeDispatch: () => input.assertSubscriptionDispatch?.(input),
    verifyBinding: async (client, stored) => {
      await input.verifyPrivateAuth(input);
      if (
        stored &&
        (stored.accountId !== binding.accountId ||
          stored.provider !== binding.provider ||
          stored.model !== binding.model ||
          stored.profileRevision !== binding.profileRevision)
      )
        throw new Error('ChatGPT native account binding changed');
      // The upstream bootstrap uses a synthetic ID token. Its email/plan are
      // display metadata, not identity evidence. The host callback above must
      // attest the real provider account independently at every boundary.
      const result = await client.request('account/read', { refreshToken: false });
      if (
        !result ||
        typeof result !== 'object' ||
        !(result as { account?: { type?: string } }).account ||
        (result as { account: { type?: string } }).account.type !== 'chatgpt'
      )
        throw new Error('Native subscription runtime is not authenticated with ChatGPT');
      const models = await readCodexModels(client);
      const selected = models.find((model) => model.id === input.route.model);
      if (
        !selected ||
        (input.route.effort !== null && !selected.reasoningEfforts?.includes(input.route.effort))
      )
        throw new Error('Selected ChatGPT model or reasoning effort is unavailable');
      await input.verifyPrivateAuth(input);
      input.execution.signal.throwIfAborted();
      return binding;
    },
  });
}
