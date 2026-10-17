import type { AgentToolReference } from '@mitzo/protocol';
import type { buildPermissionHandler } from '@mitzo/harness';
import type { ApiToolCatalog } from './api-tool-catalog.js';
import type { CredentialConnections } from './credential-connections.js';
import { createCredentialConnectionTools } from './credential-connection-tools.js';
import { apiToolInputSchema, apiToolRequest, mapApiToolOutput } from './api-tool-template.js';

/** Internal adapter, never a general request wrapper or an additional grant surface. */
export function admitApiTools(options: {
  catalog: ApiToolCatalog;
  service: CredentialConnections;
  sessionId: string;
  refs: AgentToolReference[];
  approve: ReturnType<typeof buildPermissionHandler>;
  stillAllowed(name: string): boolean;
  assertCurrent(): void;
  assertRuntimeCurrent?: () => Promise<void>;
}) {
  options.assertCurrent();
  const receipts = options.refs.map((ref) => options.catalog.resolve(ref, options.service));
  const admitted = receipts.map((receipt) => ({
    wireName: receipt.definition.name,
    reference: options.catalog.reference(receipt.entry),
  }));
  return {
    admitted,
    definitions: receipts.map((r) => structuredClone(r.definition)),
    async execute(name: string, input: Record<string, unknown>, signal: AbortSignal) {
      const receipt = receipts.find((r) => r.definition.name === name);
      if (!receipt) return undefined;
      try {
        apiToolInputSchema.parse(input);
        const check = () => {
          signal.throwIfAborted();
          options.assertCurrent();
          options.catalog.resolve(options.catalog.reference(receipt.entry), options.service);
          if (!options.stillAllowed(name)) throw Error('API tool permission revoked');
        };
        check();
        const tools = createCredentialConnectionTools(
          options.service,
          options.sessionId,
          options.approve,
          (canonical) => {
            check();
            return options.stillAllowed(canonical);
          },
          options.assertRuntimeCurrent,
        );
        const result = await tools.execute(
          'ConnectionRequest',
          {
            connectionId: receipt.configuration.connectionId,
            ...apiToolRequest(receipt.configuration),
          },
          signal,
        );
        check();
        if (!result || result.isError)
          return result ?? { content: 'API tool unavailable', isError: true };
        return {
          content: JSON.stringify(
            mapApiToolOutput(receipt.configuration, JSON.parse(result.content)),
          ),
          isError: false,
        };
      } catch {
        return {
          content: signal.aborted
            ? 'API tool request cancelled'
            : 'API tool unavailable. Check its verification, connection access and current permissions.',
          isError: true,
        };
      }
    },
  };
}
