import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexAppServerClient, type CodexLifecycleTransport } from './codex-app-server-client.js';
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
  const fail = () => {
    terminate();
    if (settled) return;
    settled = true;
    removeListeners();
    options.signal?.removeEventListener('abort', fail);
    rejectWrite(new Error('Subscription identity transport failed'));
  };
  const timer = setTimeout(fail, 10_000);
  timer.unref();
  const removeListeners = () => {
    clearTimeout(timer);
    child.off('error', fail);
    child.off('exit', fail);
    child.stdin.off('error', fail);
    child.stdout.off('error', fail);
    child.stderr.off('error', fail);
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stderr.resume();
  options.signal?.addEventListener('abort', fail, { once: true });
  try {
    options.signal?.throwIfAborted();
    const frame = subscriptionIdentityFrame(identity, claim);
    child.stdin.write(frame, (error) => {
      if (error) return fail();
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
    fail();
    throw new Error('Subscription identity transport failed');
  }
  const initialize = client.initialize.bind(client);
  client.initialize = async () => {
    try {
      await written;
      options.signal?.throwIfAborted();
      identity.assertCurrent();
      await initialize();
      options.signal?.throwIfAborted();
      identity.assertCurrent();
    } catch {
      terminate();
      await cleanup?.catch(() => {
        throw new Error('Subscription identity cleanup is unconfirmed');
      });
      throw new Error('Subscription identity initialization failed');
    } finally {
      options.signal?.removeEventListener('abort', fail);
    }
  };
  return client;
}
