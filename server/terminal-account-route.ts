import type { AccountBinding } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import type { OpenShellAccountRoute } from './openshell-runtime.js';
import { selectedOpenShellAccountRoute } from './codex-chat-session.js';
import { resolveSymposiumSubscriptionRoute } from './symposium-subscription-native.js';
/** Validate the saved account's route for a human shell; never create or dispatch an agent. */
export function terminalAccountRoute(
  profiles: AccountProfiles,
  binding: AccountBinding,
  model: string,
): OpenShellAccountRoute {
  if (binding.provider === 'openai') {
    const profile = profiles.apiProfile(binding);
    if (!profile.sandboxProvider) throw Error('Sandbox provider unavailable');
    return { kind: 'api', provider: profile.sandboxProvider, model };
  }
  const profile = profiles.codexProfile(binding);
  if (profile.nativeAuth === 'sandbox-chatgpt') {
    const route = resolveSymposiumSubscriptionRoute(profiles, { ...binding, model });
    return {
      kind: 'chatgpt-subscription-native',
      provider: route.provider,
      providerType: 'codex',
      providerId: route.providerId,
      model,
    };
  }
  return selectedOpenShellAccountRoute({ binding, model, profile });
}
