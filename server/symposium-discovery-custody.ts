import type { DiscoveryOperations } from './symposium-model-discovery.js';

/** A retained host capability; a caller cannot substitute a provider or stale login receipt. */
export function guardDiscoveryOperations(
  operations: DiscoveryOperations,
  check: () => void,
  expectedAccount: { email: string; planType: string },
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
          const account = (
            value as { account?: { type?: unknown; email?: unknown; planType?: unknown } }
          )?.account;
          if (
            account?.type !== 'chatgpt' ||
            account.email !== expectedAccount.email ||
            account.planType !== expectedAccount.planType
          )
            throw new Error('Discovery account differs from verified receipt');
        }
        return value;
      },
      // Closing the local process must remain available when custody has changed.
      close: () => client.close(),
    };
  };
  return guarded;
}
