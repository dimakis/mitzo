import type { NativeBaseReadScope } from './codex-conversation.js';
import {
  captureNativeHostReadOwner,
  assertNativeHostReadCurrentSync,
  type NativeHostToolContext,
} from './native-host-tool-context.js';
import type { PreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';
import type { LocalRepositoryReadAuthority } from './local-repository-read-access.js';
import { captureLocalRepositoryReader as captureReader } from './local-repository-native-reader.js';

export { captureNativeReaderPathAuthorization } from './local-repository-native-reader.js';

/** Fresh read-only prepared-workspace validation; individual helpers retain their 30s cap. */
export const preparedRepositoryValidationReadMs = 60000;

/** Private original-command composition, never a tool, registry or grant. The
 * existing SRT default-read boundary is qualified ONLY for an actual '/' base.
 * Narrow owners fail before source lookup; every helper uses that same boundary. */
export async function captureNativeLocalRepositoryReader(
  context: NativeHostToolContext,
  options: { deadline: number },
): Promise<LocalRepositoryReadAuthority & { dispose(): Promise<void> }> {
  const owner = captureNativeHostReadOwner(context);
  const scope: NativeBaseReadScope | undefined = owner?.scope ?? context.nativeBaseReadScope;
  return captureReader(
    scope,
    owner?.signal ?? context.signal,
    () => {
      if (owner) owner.assertCurrentSync();
      else assertNativeHostReadCurrentSync(context, scope);
    },
    () => (owner ? owner.assertCurrent() : context.assertCurrent()),
    options,
  );
}

/** Fresh completed-turn owner ONLY. Retain the exact original scope object and
 * its receiver/lifetime; no expired tool context or descriptive receipt is used. */
export async function capturePreparedRepositoryReader(
  scope: PreparedRepositoryBarrierReadScope,
  options: { deadline: number },
): Promise<LocalRepositoryReadAuthority & { dispose(): Promise<void> }> {
  return captureReader(
    scope,
    scope.signal,
    () => scope.assertCurrentSync(),
    () => scope.revalidate(),
    options,
  );
}
