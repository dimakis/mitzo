import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readCodexModels, type CatalogModel } from './model-catalog.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const configSchema = z
  .object({
    cliSha256: z.string().regex(/^[a-f0-9]{64}$/),
    workloadImage: z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    podmanUrl: z.string().regex(/^unix:\/\/\/[^\0]+$/),
    gateway: identifier,
    workspace: identifier,
    provider: z.object({ name: identifier, id: identifier }),
  })
  .strict();
export type DiscoveryConfig = z.infer<typeof configSchema>;
const receiptSchema = z
  .object({
    name: z.string().regex(/^md-[a-f0-9]{16}$/),
    claim: z.string().regex(/^[a-f0-9]{64}$/),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    id: identifier.optional(),
  })
  .strict();
export type DiscoveryReceipt = z.infer<typeof receiptSchema>;
const sandboxSchema = z.object({
  id: identifier,
  name: identifier,
  workspace: identifier,
  phase: z.string(),
  labels: z.record(z.string(), z.string()),
});
type Sandbox = z.infer<typeof sandboxSchema>;
export interface DiscoveryReadClient {
  initialize(): Promise<unknown>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
/** Trusted host adapters only; never supplied by an HTTP caller or sandbox. */
/** Internal proof from the host adapter that no external create was dispatched. */
export class DiscoveryNotDispatchedError extends Error {}
export interface DiscoveryOperations {
  withExclusiveAttempt<T>(operation: () => Promise<T>): Promise<T>;
  verifyCustody(config: DiscoveryConfig): Promise<void>;
  readReceipt(): Promise<unknown>;
  persistReceipt(receipt: DiscoveryReceipt, exclusive: boolean): Promise<void>;
  clearReceipt(): Promise<void>;
  list(): Promise<unknown>;
  create(
    receipt: DiscoveryReceipt,
    config: DiscoveryConfig,
    beforeDispatch?: () => void,
  ): Promise<void>;
  attachedProviders(receipt: DiscoveryReceipt): Promise<unknown>;
  providerInventory(): Promise<unknown>;
  openClient(receipt: DiscoveryReceipt): Promise<DiscoveryReadClient>;
  cancel(receipt: DiscoveryReceipt): Promise<void>;
  delete(receipt: DiscoveryReceipt): Promise<void>;
  physicalAbsent(receipt: DiscoveryReceipt): Promise<boolean>;
  wait(): Promise<void>;
}
export type DiscoveryResult =
  | { status: 'complete'; inference: false; modelCount: number; lunaModels: string[] }
  | { status: 'failed' | 'reconciliation_required' | 'reconciled'; inference: false };

/** Account and model metadata only. No thread/turn API, inference, or automatic retry. */
export async function runSymposiumModelDiscovery(
  input: DiscoveryConfig,
  ops: DiscoveryOperations,
  onCatalog?: (models: CatalogModel[]) => void,
): Promise<DiscoveryResult> {
  try {
    return await ops.withExclusiveAttempt(() => runExclusiveDiscovery(input, ops, onCatalog));
  } catch {
    return { status: 'reconciliation_required', inference: false };
  }
}
async function runExclusiveDiscovery(
  input: DiscoveryConfig,
  ops: DiscoveryOperations,
  onCatalog?: (models: CatalogModel[]) => void,
): Promise<DiscoveryResult> {
  let receipt: DiscoveryReceipt | undefined;
  let config: DiscoveryConfig;
  let client: DiscoveryReadClient | undefined;
  let result: DiscoveryResult;
  let discovered: CatalogModel[] | undefined;
  let resumed = false;
  let creationConfirmed = false;
  const verify = async () => ops.verifyCustody(config);
  const owned = (row: Sandbox, expected: DiscoveryReceipt) =>
    row.name === expected.name &&
    row.workspace === config.workspace &&
    row.labels['mitzo.discovery'] === 'models' &&
    row.labels['mitzo.discovery.claim'] === expected.claim &&
    (!expected.id || row.id === expected.id);
  try {
    config = configSchema.parse(input);
    await verify();
    const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const previous = await ops.readReceipt();
    if (previous) {
      const parsed = receiptSchema.parse(previous);
      if (parsed.configHash !== configHash)
        return { status: 'reconciliation_required', inference: false };
      receipt = parsed;
      resumed = true;
      creationConfirmed = !!receipt.id;
    } else {
      receipt = {
        name: `md-${randomBytes(8).toString('hex')}`,
        claim: randomBytes(32).toString('hex'),
        configHash,
      };
      await ops.persistReceipt(receipt, true);
      try {
        await verify();
      } catch {
        // This local preflight precedes create; no external allocation was dispatched.
        throw new DiscoveryNotDispatchedError('Custody preflight failed');
      }
      await ops.create(receipt, config);
    }
    if (!resumed) {
      let selected: Sandbox | undefined;
      for (let i = 0; i < 12; i++) {
        await verify();
        const rows = z.array(sandboxSchema).parse(await ops.list());
        const matches = rows.filter((row) => row.name === receipt!.name);
        if (matches.length > 1 || (matches[0] && !owned(matches[0], receipt)))
          throw new Error('Ownership changed');
        selected = matches[0];
        if (selected) {
          creationConfirmed = true;
          receipt.id = selected.id;
          await ops.persistReceipt(receipt, false);
        }
        if (selected?.phase === 'Ready') break;
        await ops.wait();
      }
      if (!selected || selected.phase !== 'Ready') throw new Error('Not ready');
      const attached = z
        .array(z.object({ name: identifier, type: z.literal('codex') }))
        .parse(await ops.attachedProviders(receipt));
      if (attached.length !== 1 || attached[0].name !== config.provider.name)
        throw new Error('Wrong attachment');
      await verify();
      const providers = z
        .array(
          z.object({ name: identifier, id: identifier, type: z.string(), workspace: identifier }),
        )
        .parse(await ops.providerInventory());
      const selectedProviders = providers.filter(
        (provider) => provider.name === config.provider.name,
      );
      if (
        selectedProviders.length !== 1 ||
        selectedProviders[0].id !== config.provider.id ||
        selectedProviders[0].type !== 'codex' ||
        selectedProviders[0].workspace !== config.workspace
      )
        throw new Error('Wrong provider');
      await verify();
      client = await ops.openClient(receipt);
      await client.initialize();
      const account = z
        .object({ account: z.object({ type: z.literal('chatgpt') }) })
        .parse(await client.request('account/read', { refreshToken: false }));
      void account;
      let pages = 0;
      let expired = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          expired = true;
          reject(new Error('Model discovery deadline exceeded'));
        }, 60_000);
      });
      let models;
      try {
        models = await Promise.race([
          readCodexModels({
            request: (method, params) => {
              if (method !== 'model/list' || expired || ++pages > 100)
                throw new Error('Bounded read-only discovery');
              return client!.request(method, params);
            },
          }),
          deadline,
        ]);
      } finally {
        expired = true;
        clearTimeout(timeout);
      }
      discovered = models;
      const lunaModels = models
        .map((model) => model.id)
        .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id) && /luna/i.test(id));
      await verify();
      result = { status: 'complete', inference: false, modelCount: models.length, lunaModels };
    } else result = { status: 'reconciled', inference: false };
  } catch (error) {
    if (error instanceof DiscoveryNotDispatchedError && !resumed) {
      try {
        await ops.clearReceipt();
        receipt = undefined;
      } catch {
        /* retain reconciliation if journal cleanup fails */
      }
    }
    // Deliberately never surface command output, provider errors, identity or credential data.
    result = { status: receipt ? 'reconciliation_required' : 'failed', inference: false };
  }
  try {
    client?.close();
  } catch {
    /* cleanup still required */
  }
  if (receipt) {
    try {
      let clean = false;
      for (let i = 0; i < 12; i++) {
        await verify();
        const rows = z.array(sandboxSchema).parse(await ops.list());
        const matches = rows.filter((row) => row.name === receipt!.name || row.id === receipt!.id);
        if (matches.some((row) => !owned(row, receipt!)) || matches.length > 1)
          throw new Error('Ambiguous owner');
        if (matches[0]) {
          receipt.id = matches[0].id;
          creationConfirmed = true;
          await ops.persistReceipt(receipt, false);
          try {
            await ops.cancel(receipt);
          } catch {
            /* deletion and host absence are still required */
          }
          try {
            await ops.delete(receipt);
          } catch {
            /* ambiguous delete: poll both inventories */
          }
        } else if (await ops.physicalAbsent(receipt)) {
          // A timed-out create with no observed identity can still arrive late.
          if (!creationConfirmed) break;
          clean = true;
          break;
        }
        await ops.wait();
      }
      if (!clean) result = { status: 'reconciliation_required', inference: false };
      else {
        await ops.clearReceipt();
        if (result.status === 'reconciliation_required')
          result = { status: resumed ? 'reconciled' : 'failed', inference: false };
      }
    } catch {
      result = { status: 'reconciliation_required', inference: false };
    }
  }
  if (result.status === 'complete' && discovered && onCatalog) {
    try {
      onCatalog(structuredClone(discovered));
    } catch {
      return { status: 'failed', inference: false };
    }
  }
  return result;
}
