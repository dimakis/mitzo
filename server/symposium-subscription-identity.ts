import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  CodexAppServerClient,
  CodexRequestError,
  CodexTransportError,
  type CodexLifecycleTransport,
} from './codex-app-server-client.js';
import { nativeFailureCategories } from './codex-native-diagnostics.js';
import { reviewedSymposiumOwnedRuntime } from './symposium-owned-runtime-contract.js';

/** Private, receipt-owned capability. Never persist or expose it through account profiles. */
export interface SubscriptionLaunchIdentity {
  readonly accountId: string;
  assertCurrent(): void;
}

export function subscriptionIdentityRequired(image: string): boolean {
  const { build } = reviewedSymposiumOwnedRuntime(image);
  return (
    'subscriptionIdentityProtocol' in build && build.subscriptionIdentityProtocol === 'stdin-v1'
  );
}

export function subscriptionIdentityFrame(identity: SubscriptionLaunchIdentity, claim: string) {
  identity.assertCurrent();
  if (
    !/^[a-f0-9]{64}$/.test(claim) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identity.accountId)
  )
    throw new Error('Subscription launch identity is unavailable');
  const frame = Buffer.from(
    JSON.stringify({ version: 1, claim, accountId: identity.accountId }) + '\n',
    'ascii',
  );
  if (frame.length > 512) throw new Error('Subscription launch identity is unavailable');
  return frame;
}

/** Does not carry the received or expected account identifier. */
export class SubscriptionRoutingIdentityError extends Error {
  constructor(readonly category: 'routing_identity_missing' | 'routing_identity_mismatch') {
    super('Native subscription workspace identity differs from the verified receipt');
    this.name = 'SubscriptionRoutingIdentityError';
  }
}

export function assertSubscriptionRoutingIdentity(
  result: unknown,
  identity: SubscriptionLaunchIdentity,
) {
  identity.assertCurrent();
  const routing = (result as { workspaceRouting?: { chatgptAccountId?: unknown } } | null)
    ?.workspaceRouting;
  if (routing?.chatgptAccountId !== identity.accountId)
    throw new SubscriptionRoutingIdentityError(
      typeof routing?.chatgptAccountId === 'string' && routing.chatgptAccountId
        ? 'routing_identity_mismatch'
        : 'routing_identity_missing',
    );
}

/** Install the RPC reader before queueing the bounded preface, then hold initialize
 * until its write completes. Every failed preface retains exact controller cleanup. */
export function createSubscriptionIdentityClient(
  child: ChildProcessWithoutNullStreams,
  identity: SubscriptionLaunchIdentity,
  claim: string,
  stop: () => Promise<void>,
  options: { lifecycle?: CodexLifecycleTransport; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const client = new CodexAppServerClient(child, options);
  let cleanup: Promise<void> | undefined;
  let settled = false;
  let resolveWrite!: () => void;
  let rejectWrite!: (error: Error) => void;
  const written = new Promise<void>((resolve, reject) => {
    resolveWrite = resolve;
    rejectWrite = reject;
  });
  void written.catch(() => undefined);
  const terminate = () => {
    if (cleanup) return;
    cleanup = Promise.resolve().then(stop);
    client.close();
    void cleanup.catch(() => undefined);
  };
  const fail = (category?: 'timeout' | 'connection') => {
    if (settled) {
      terminate();
      return;
    }
    settled = true;
    removeListeners();
    options.signal?.removeEventListener('abort', aborted);
    terminate();
    rejectWrite(
      category
        ? new CodexTransportError(category)
        : new Error('Subscription identity transport failed'),
    );
  };
  // Discard event arguments; only locally established transport failures are typed.
  const connectionFailed = () => fail('connection');
  const aborted = () => fail();
  const timer = setTimeout(() => fail('timeout'), 10_000);
  timer.unref();
  const removeListeners = () => {
    clearTimeout(timer);
    child.off('error', connectionFailed);
    child.off('exit', connectionFailed);
    child.stdin.off('error', connectionFailed);
    child.stdout.off('error', connectionFailed);
    child.stderr.off('error', connectionFailed);
  };
  child.on('error', connectionFailed);
  child.on('exit', connectionFailed);
  child.stdin.on('error', connectionFailed);
  child.stdout.on('error', connectionFailed);
  child.stderr.on('error', connectionFailed);
  child.stderr.resume();
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    options.signal?.throwIfAborted();
    const frame = subscriptionIdentityFrame(identity, claim);
    try {
      child.stdin.write(frame, (error) => {
        if (error) return connectionFailed();
        if (settled) return;
        try {
          identity.assertCurrent();
        } catch {
          return fail();
        }
        settled = true;
        removeListeners();
        resolveWrite();
      });
    } catch {
      connectionFailed();
    }
  } catch {
    fail();
    throw new Error('Subscription identity transport failed');
  }
  const assertReady = () => {
    try {
      options.signal?.throwIfAborted();
      identity.assertCurrent();
    } catch {
      // Authorization and abort causes may contain private data.
      throw new Error('Subscription identity initialization failed');
    }
  };
  const initialize = client.initialize.bind(client);
  client.initialize = async () => {
    try {
      await written;
      assertReady();
      await initialize();
      assertReady();
    } catch (error) {
      terminate();
      await cleanup?.catch(() => {
        throw new Error('Subscription identity cleanup is unconfirmed');
      });
      if (options.signal?.aborted) {
        // eslint-disable-next-line preserve-caught-error -- Abort reasons are private and are not transport evidence.
        throw new Error('Subscription identity initialization failed');
      }
      // Reconstruct only the fixed local transport category after confirmed cleanup.
      // Arbitrary failure objects and identity assertions remain private.
      if (
        error instanceof CodexTransportError &&
        (error.category === 'timeout' ||
          error.category === 'connection' ||
          error.category === 'protocol')
      )
        throw new CodexTransportError(error.category);
      if (error instanceof CodexRequestError && nativeFailureCategories.includes(error.category))
        throw new CodexRequestError(
          'initialize',
          error.category,
          Number.isInteger(error.code) && error.code! >= -2147483648 && error.code! <= 2147483647
            ? error.code
            : undefined,
        );
      // eslint-disable-next-line preserve-caught-error -- A cause could retain private identity or provider data.
      throw new Error('Subscription identity initialization failed');
    } finally {
      options.signal?.removeEventListener('abort', aborted);
    }
  };
  return client;
}
