import type { DiscoveryOperations } from './symposium-model-discovery.js';

/** A retained host capability; a caller cannot substitute a provider or stale login receipt.
 * `check` attests the OAuth-verified receipt and same gateway custody. The pinned
 * upstream launcher uses a synthetic ID token, so native email/plan are display
 * metadata, never account identity evidence. Provider name/ID/workspace and exact
 * attachment are independently verified before this client is opened.
 */
export function guardDiscoveryOperations(
  operations: DiscoveryOperations,
  check: () => void,
): DiscoveryOperations {
  const guarded = Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      async (...args: unknown[]) => {
        check();
        const value = await (operation as (...values: unknown[]) => Promise<unknown>)(...args);
        check();
        return value;
      },
    ]),
  ) as unknown as DiscoveryOperations;
  // This capability only removes an exact local journal under the host lock.
  // Gateway custody is intentionally not required to undo an undispatched intent.
  guarded.clearUndispatchedReceipt = operations.clearUndispatchedReceipt;
  guarded.openClient = async (receipt) => {
    check();
    const client = await operations.openClient(receipt);
    try {
      check();
    } catch (error) {
      client.close();
      throw error;
    }
    return {
      initialize: async () => {
        check();
        const value = await client.initialize();
        check();
        return value;
      },
      request: async (method, params) => {
        check();
        const value = await client.request(method, params);
        check();
        if (method === 'account/read') {
          const account = (value as { account?: { type?: unknown } })?.account;
          if (account?.type !== 'chatgpt')
            throw new Error('Native discovery runtime is not authenticated with ChatGPT');
        }
        return value;
      },
      // Closing the local process must remain available when custody has changed.
      close: () => client.close(),
    };
  };
  return guarded;
}
