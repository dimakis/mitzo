import { apiHarnessConnection } from './account-harness-connection.js';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { loadAccountProfiles } from './account-profiles.js';
import { credentials } from './credentials.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { assertOpenAIKeyController } from './openai-key-controller.js';
import { openAIKeyResourceBindings } from './openai-key-operation-store.js';

/** Existing account custody is authoritative regardless of which UI enrolled it.
 * New enrollment must never become a prerequisite for using a configured key,
 * nor may controller loss downgrade a managed account to a raw credential read.
 */
export function openAIAccountKeyAuthority(
  binding: AccountBinding,
  profiles = loadAccountProfiles(),
  options?: { consumer: 'host'; endpoint?: string },
) {
  binding = Object.freeze(structuredClone(binding));
  const profile = profiles.apiRoutingProfile(binding);
  const selectedResource = Object.freeze({
    id: binding.accountId,
    profileRevision: binding.profileRevision,
    credentialRef: Object.freeze(structuredClone(profile.credentialRef)),
    providerName: profile.sandboxProvider,
    providerId: profile.sandboxProviderId,
  });
  function assertConnection(current: typeof profile) {
    if (!current.connection) return;
    const selected = apiHarnessConnection(current.connection);
    if (options?.consumer !== 'host' || options.endpoint !== selected.endpoint)
      throw Error('Custom endpoint requires an endpoint-bound native Codex consumer');
  }
  assertConnection(profile);
  const runtime = getConnectionsRuntime();
  const enrolled = profiles.isEnrolledOpenAIAccount(binding.accountId);
  const enrollment = runtime?.openAIEnrollmentAuthority;
  if (enrolled && !enrollment?.manages(binding.accountId))
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
  const manager = enrolled
    ? enrollment!
    : runtime?.openAIKeys?.manages(binding.accountId)
      ? runtime.openAIKeys
      : undefined;
  function assertCurrent() {
    assertConnection(loadAccountProfiles().apiRoutingProfile(binding));
    if (getConnectionsRuntime() !== runtime) throw Error('OpenAI account controller changed');
    if (manager && !manager.manages(binding.accountId))
      throw Error('OpenAI account controller changed');
  }
  async function hostKey(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    assertCurrent();
    // A managed credential never falls back to a raw Keychain lookup.
    const key = manager
      ? await manager.resolveHostKey(binding.accountId, signal)
      : runtime?.assertOpenAIKeyReady
        ? await runtime.service.withCredentialRead(async () => {
            signal.throwIfAborted();
            assertCurrent();
            await runtime.assertOpenAIKeyReady!(binding.accountId, signal, selectedResource);
            assertCurrent();
            return credentials.resolve(selectedResource.credentialRef);
          }, signal)
        : await credentials.resolve(profile.credentialRef);
    signal.throwIfAborted();
    assertCurrent();
    if (!key.trim()) throw Error('OpenAI account credential unavailable');
    return key;
  }
  return {
    /** Gateway consumers check retained custody without copying the host key. */
    async assertReady(signal: AbortSignal): Promise<void> {
      if (options?.consumer === 'host') {
        await hostKey(signal);
        return;
      }
      signal.throwIfAborted();
      assertCurrent();
      if (runtime?.assertOpenAIKeyReady) {
        await runtime.service.assertAccountCredentialReady(binding.accountId, signal);
        signal.throwIfAborted();
        assertCurrent();
      } else if (manager) throw Error('OpenAI account controller unavailable');
      signal.throwIfAborted();
      assertCurrent();
    },
    async resolveKey(accountId: string, signal: AbortSignal): Promise<string> {
      if (accountId !== binding.accountId) throw Error('OpenAI account changed');
      if (options?.consumer === 'host') return hostKey(signal);
      signal.throwIfAborted();
      assertCurrent();
      const key = manager
        ? await manager.resolveKey(accountId, signal)
        : runtime?.assertOpenAIKeyReady
          ? await runtime.service.withCredentialRead(async () => {
              signal.throwIfAborted();
              assertCurrent();
              await runtime.assertOpenAIKeyReady!(accountId, signal, selectedResource);
              assertCurrent();
              return credentials.resolve(selectedResource.credentialRef);
            }, signal)
          : await credentials.resolve(profile.credentialRef);
      signal.throwIfAborted();
      assertCurrent();
      if (!key.trim()) throw Error('OpenAI account credential unavailable');
      return key;
    },
  };
}
