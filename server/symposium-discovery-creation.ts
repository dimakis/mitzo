import { z } from 'zod';
import type { DiscoveryOperations } from './symposium-model-discovery.js';
import type { SandboxCreationFence } from './symposium-workspace-lifecycle.js';
const rowsSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string(),
    workspace: z.string(),
    phase: z.string(),
    labels: z.record(z.string(), z.string()),
  }),
);
/** The durable workspace coordinator must observe the exact identity before releasing creation. */
export function fenceDiscoveryCreation(
  operations: DiscoveryOperations,
  workspace: string,
  fence: SandboxCreationFence,
  verify: () => void,
) {
  let uncertain = false;
  return {
    creationUncertain: () => uncertain,
    operations: {
      ...operations,
      async create(receipt, config) {
        try {
          await fence(verify, async () => {
            await operations.create(receipt, config);
            verify();
            for (let attempt = 0; attempt < 12; attempt++) {
              verify();
              const rows = rowsSchema.parse(await operations.list());
              verify();
              const selected = rows.filter((row) => row.name === receipt.name);
              if (
                selected.length > 1 ||
                (selected[0] &&
                  (selected[0].workspace !== workspace ||
                    selected[0].labels['mitzo.discovery'] !== 'models' ||
                    selected[0].labels['mitzo.discovery.claim'] !== receipt.claim ||
                    (receipt.id && selected[0].id !== receipt.id)))
              )
                throw new Error('Discovery creation identity changed');
              if (selected[0]?.phase === 'Ready') {
                receipt.id = selected[0].id;
                await operations.persistReceipt(receipt, false);
                verify();
                return;
              }
              await operations.wait();
              verify();
            }
            throw new Error('Discovery creation identity unconfirmed');
          });
        } catch (error) {
          uncertain = true;
          throw error;
        }
      },
    } satisfies DiscoveryOperations,
  };
}
