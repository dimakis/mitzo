import {
  classifyDiscoveryFailure,
  DiscoveryCommandFailure,
  DiscoveryNativeMetadataFailure,
  DiscoveryDiagnosticSchema,
  RoutingDiagnosticResultSchema,
  RoutingNetworkObservationSchema,
  type RoutingNetworkObservation,
  type DiscoveryDiagnostic,
} from './symposium-discovery-diagnostics.js';
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
    routingDiagnostic: z
      .strictObject({
        format: z.literal('owned-supervisor-console-v1'),
        logLevel: z.literal('off,openshell.routing_http=debug'),
        supervisorImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .optional(),
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
/** Preserve all 256 claim bits within upstream Kubernetes label limits (63 chars).
 * Fixed alphanumeric ends also cover base64url values ending in '-' or '_'.
 * Journals and native controller claims keep their original 64-character hex form.
 */
export function discoveryClaimLabel(claim: string): string {
  if (!/^[a-f0-9]{64}$/.test(claim)) throw new Error('Invalid discovery claim');
  return `v1.${Buffer.from(claim, 'hex').toString('base64url')}.c`;
}

const sandboxSchema = z.object({
  id: identifier,
  name: identifier,
  workspace: identifier,
  phase: z.string(),
  labels: z.record(z.string(), z.string()),
});
type Sandbox = z.infer<typeof sandboxSchema>;
/** Opaque same-process proof of one exact Ready observation, never reconstructed from a journal. */
export interface DiscoveryOwnedReadyEvidence {
  readonly receipt: Readonly<DiscoveryReceipt>;
}
const ownedReadyEvidence = new WeakSet<DiscoveryOwnedReadyEvidence>();
/** Private clean disposition for one positively undispatched invocation. */
export interface DiscoveryNotDispatchedEvidence {
  /** not-entered grants lease-only release; it says nothing about prior native state. */
  readonly kind: 'not-dispatched' | 'not-entered';
}
const notDispatchedEvidence = new WeakMap<
  DiscoveryNotDispatchedEvidence,
  { origin: object; configHash: string }
>();
const notDispatchedOrigins = new WeakSet<object>();
export function assertDiscoveryNotDispatchedEvidence(
  input: DiscoveryConfig,
  evidence: DiscoveryNotDispatchedEvidence,
  origin: object,
): void {
  try {
    const retained = notDispatchedEvidence.get(evidence);
    const config = configSchema.parse(input);
    if (
      !retained ||
      retained.origin !== origin ||
      retained.configHash !== createHash('sha256').update(JSON.stringify(config)).digest('hex')
    )
      throw Error('changed');
  } catch {
    throw Error('Not-dispatched evidence changed');
  }
}

export interface DiscoveryPhysicalCleanupEvidence {
  readonly receipt: Readonly<DiscoveryReceipt>;
}
const physicalCleanupEvidence = new WeakSet<DiscoveryPhysicalCleanupEvidence>();
export function assertDiscoveryOwnedReadyEvidence(evidence: DiscoveryOwnedReadyEvidence): void {
  if (!ownedReadyEvidence.has(evidence)) throw Error('Owned Ready evidence unavailable');
}
export function assertDiscoveryPhysicalCleanupEvidence(
  ready: DiscoveryOwnedReadyEvidence,
  cleanup: DiscoveryPhysicalCleanupEvidence,
): void {
  assertDiscoveryOwnedReadyEvidence(ready);
  if (
    !physicalCleanupEvidence.has(cleanup) ||
    JSON.stringify(ready.receipt) !== JSON.stringify(cleanup.receipt)
  )
    throw Error('Physical cleanup evidence changed');
}
function physicalCleanupProof(retained: DiscoveryReceipt): DiscoveryPhysicalCleanupEvidence {
  const receipt = receiptSchema.parse(retained);
  if (!receipt.id) throw Error('Physical cleanup identity unavailable');
  const evidence = Object.freeze({ receipt: Object.freeze(structuredClone(receipt)) });
  physicalCleanupEvidence.add(evidence);
  return evidence;
}

export function createDiscoveryOwnedReadyEvidence(
  input: DiscoveryConfig,
  retained: DiscoveryReceipt,
  observed: unknown,
): DiscoveryOwnedReadyEvidence {
  const config = configSchema.parse(input);
  const expected = receiptSchema.parse(retained);
  const row = sandboxSchema.parse(observed);
  if (
    !expected.id ||
    expected.configHash !== createHash('sha256').update(JSON.stringify(config)).digest('hex') ||
    row.phase !== 'Ready' ||
    row.id !== expected.id ||
    row.name !== expected.name ||
    row.workspace !== config.workspace ||
    row.labels['mitzo.discovery'] !== 'models' ||
    row.labels['mitzo.discovery.claim'] !== discoveryClaimLabel(expected.claim)
  )
    throw Error('Owned Ready evidence changed');
  const evidence = Object.freeze({ receipt: Object.freeze(structuredClone(expected)) });
  ownedReadyEvidence.add(evidence);
  return evidence;
}
export interface DiscoveryReadClient {
  initialize(): Promise<unknown>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
/** Trusted host adapters only; never supplied by an HTTP caller or sandbox. */
/** Internal proof from the host adapter that no external create was dispatched. */
export class DiscoveryNotDispatchedError extends Error {}
export interface DiscoveryOperations {
  recordDiagnostic?(diagnostic: DiscoveryDiagnostic): Promise<void>;
  observeRouting?(receipt: DiscoveryReceipt): Promise<unknown>;
  withExclusiveAttempt<T>(operation: () => Promise<T>): Promise<T>;
  verifyCustody(config: DiscoveryConfig): Promise<void>;
  readReceipt(): Promise<unknown>;
  persistReceipt(receipt: DiscoveryReceipt, exclusive: boolean): Promise<void>;
  clearReceipt(receipt: DiscoveryReceipt): Promise<void>;
  /** Local exact-journal cleanup, only after proven absence of external dispatch. */
  clearUndispatchedReceipt?(receipt: DiscoveryReceipt): Promise<void>;
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
export type DiscoveryResult = (
  | { status: 'complete'; inference: false; modelCount: number; lunaModels: string[] }
  | {
      status: 'failed' | 'reconciliation_required' | 'reconciled';
      inference: false;
      diagnostic?: DiscoveryDiagnostic;
      diagnosticPersisted?: boolean;
    }
) & { networkObservation?: RoutingNetworkObservation };
/** Routing metadata only; completion never publishes a model catalog. */
export { RoutingDiagnosticResultSchema } from './symposium-discovery-diagnostics.js';
export type RoutingDiagnosticResult = z.infer<typeof RoutingDiagnosticResultSchema>;

/** Account and model metadata only. No thread/turn API, inference, or automatic retry. */
export async function runSymposiumModelDiscovery(
  input: DiscoveryConfig,
  ops: DiscoveryOperations,
  onCatalog?: (models: CatalogModel[]) => void,
): Promise<DiscoveryResult> {
  let attempt: DiscoveryResult | undefined;
  try {
    return await ops.withExclusiveAttempt(async () => {
      attempt = await runExclusiveDiscovery(input, ops, onCatalog);
      return attempt;
    });
  } catch {
    return {
      status: 'reconciliation_required',
      inference: false,
      ...(attempt && 'diagnostic' in attempt && attempt.diagnostic
        ? { diagnostic: attempt.diagnostic, diagnosticPersisted: attempt.diagnosticPersisted }
        : {}),
    };
  }
}
/** Explicit operator-only routing read. Uses the original allocation and cleanup fences;
 * no model list or catalog callback can be supplied to this entry point. */
export async function runSymposiumRoutingDiagnostic(
  input: DiscoveryConfig,
  ops: DiscoveryOperations,
  hooks?: {
    onPhysicalCleanup?(receipt: DiscoveryReceipt, evidence: DiscoveryPhysicalCleanupEvidence): void;
    onOwnedReady?(receipt: DiscoveryReceipt, evidence: DiscoveryOwnedReadyEvidence): void;
    notDispatchedOrigin?: object;
    onNotDispatched?(evidence: DiscoveryNotDispatchedEvidence): void;
  },
): Promise<RoutingDiagnosticResult> {
  const origin = hooks?.notDispatchedOrigin;
  const freshOrigin = !!origin && !notDispatchedOrigins.has(origin);
  if (origin) notDispatchedOrigins.add(origin);
  let cleanConfigHash: string | undefined;
  let noDispatchKind: DiscoveryNotDispatchedEvidence['kind'] = 'not-dispatched';
  let attempt: DiscoveryResult | undefined;
  try {
    const result = await ops.withExclusiveAttempt(async () => {
      attempt = await runExclusiveDiscovery(
        input,
        ops,
        undefined,
        hooks?.onPhysicalCleanup,
        true,
        hooks?.onOwnedReady,
        (hash, kind) => {
          cleanConfigHash = hash;
          noDispatchKind = kind;
        },
      );
      return attempt;
    });
    if (
      result.status === 'failed' &&
      freshOrigin &&
      origin &&
      cleanConfigHash &&
      hooks?.onNotDispatched
    ) {
      const evidence = Object.freeze({ kind: noDispatchKind });
      notDispatchedEvidence.set(evidence, { origin, configHash: cleanConfigHash });
      hooks.onNotDispatched(evidence);
    }
    return RoutingDiagnosticResultSchema.parse({
      status: result.status === 'reconciled' ? 'failed' : result.status,
      inference: false,
      catalogPublication: false,
      ...('diagnostic' in result && result.diagnostic
        ? {
            diagnostic: result.diagnostic,
            diagnosticPersisted: result.diagnosticPersisted,
          }
        : {}),
      ...(result.networkObservation ? { networkObservation: result.networkObservation } : {}),
    });
  } catch {
    return RoutingDiagnosticResultSchema.parse({
      status: 'reconciliation_required',
      inference: false,
      catalogPublication: false,
      ...(attempt?.networkObservation ? { networkObservation: attempt.networkObservation } : {}),
      ...(attempt && 'diagnostic' in attempt && attempt.diagnostic
        ? {
            diagnostic: attempt.diagnostic,
            diagnosticPersisted: attempt.diagnosticPersisted,
          }
        : {}),
    });
  }
}
/** Same-process cleanup capability, pinned to one exact known sandbox and config.
 * Physical cleanup proof survives a later journal-clear/postcheck/lock-release failure.
 * Every retry still requires fresh custody checks and acquisition of the attempt lock. */
export interface DiscoveryRecoveryCapability {
  (ops: DiscoveryOperations): Promise<DiscoveryResult>;
  /** Only the original runner's positive physical-absence callback may call this. */
  confirmPhysicalCleanup(
    receipt: DiscoveryReceipt,
    evidence?: DiscoveryPhysicalCleanupEvidence,
  ): void;
  physicalCleanupEvidence(): DiscoveryPhysicalCleanupEvidence | undefined;
}
export function createSymposiumModelDiscoveryRecovery(
  input: DiscoveryConfig,
  retained: DiscoveryReceipt,
  evidence?: DiscoveryOwnedReadyEvidence,
): DiscoveryRecoveryCapability {
  const pinnedConfig = structuredClone(input);
  const pinnedReceipt = structuredClone(retained);
  let physicalCleanupProven = false;
  let retainedPhysicalCleanup: DiscoveryPhysicalCleanupEvidence | undefined;
  const pendingAuthorized =
    !!evidence &&
    ownedReadyEvidence.has(evidence) &&
    JSON.stringify(evidence.receipt) === JSON.stringify(receiptSchema.parse(pinnedReceipt));
  const recovery = async (ops: DiscoveryOperations): Promise<DiscoveryResult> => {
    try {
      const expected = receiptSchema.parse(pinnedReceipt);
      const config = configSchema.parse(pinnedConfig);
      if (
        !expected.id ||
        expected.configHash !== createHash('sha256').update(JSON.stringify(config)).digest('hex')
      )
        throw new Error('Creation completion or config is unproven');
      return await ops.withExclusiveAttempt(async () => {
        await ops.verifyCustody(config);
        const journal = await ops.readReceipt();
        // This is retained positive evidence, never an inference from bare absence.
        if (journal === undefined && physicalCleanupProven)
          return { status: 'reconciled', inference: false };
        let current = receiptSchema.parse(journal);
        if (JSON.stringify(current) !== JSON.stringify(expected)) {
          const pending = {
            name: expected.name,
            claim: expected.claim,
            configHash: expected.configHash,
          };
          if (!pendingAuthorized || JSON.stringify(current) !== JSON.stringify(pending))
            throw new Error('Discovery journal changed');
          const rows = z.array(sandboxSchema).parse(await ops.list());
          const matches = rows.filter(
            (row) => row.name === expected.name || row.id === expected.id,
          );
          if (
            matches.length !== 1 ||
            matches[0].id !== expected.id ||
            matches[0].name !== expected.name ||
            matches[0].workspace !== config.workspace ||
            matches[0].labels['mitzo.discovery'] !== 'models' ||
            matches[0].labels['mitzo.discovery.claim'] !== discoveryClaimLabel(expected.claim)
          )
            throw new Error('Discovery pending identity changed');
          await ops.verifyCustody(config);
          await ops.persistReceipt(expected, false);
          await ops.verifyCustody(config);
          current = receiptSchema.parse(await ops.readReceipt());
          if (JSON.stringify(current) !== JSON.stringify(expected))
            throw new Error('Discovery journal changed');
        }
        return runExclusiveDiscovery(
          config,
          {
            ...ops,
            readReceipt: async () => current,
            create: async () => {
              throw new Error('Cleanup cannot create');
            },
            openClient: async () => {
              throw new Error('Cleanup cannot open native client');
            },
          },
          undefined,
          (cleaned, cleanupEvidence) => {
            if (JSON.stringify(cleaned) !== JSON.stringify(expected))
              throw new Error('Discovery cleanup identity changed');
            retainedPhysicalCleanup = cleanupEvidence;
            physicalCleanupProven = true;
          },
          !!config.routingDiagnostic,
        );
      });
    } catch {
      return { status: 'reconciliation_required', inference: false };
    }
  };
  return Object.assign(recovery, {
    physicalCleanupEvidence: () => retainedPhysicalCleanup,
    confirmPhysicalCleanup(receipt: DiscoveryReceipt, evidence?: DiscoveryPhysicalCleanupEvidence) {
      const expected = receiptSchema.parse(pinnedReceipt);
      const observed = receiptSchema.parse(receipt);
      const config = configSchema.parse(pinnedConfig);
      if (
        !expected.id ||
        JSON.stringify(expected) !== JSON.stringify(observed) ||
        expected.configHash !== createHash('sha256').update(JSON.stringify(config)).digest('hex')
      )
        throw new Error('Discovery cleanup identity changed');
      if (evidence) {
        if (
          !physicalCleanupEvidence.has(evidence) ||
          JSON.stringify(evidence.receipt) !== JSON.stringify(expected)
        )
          throw Error('Physical cleanup evidence changed');
        retainedPhysicalCleanup = evidence;
      }
      physicalCleanupProven = true;
    },
  });
}
/** Stateless cleanup rejects missing journals. Retain the factory capability for retries. */
export async function recoverSymposiumModelDiscovery(
  input: DiscoveryConfig,
  ops: DiscoveryOperations,
  retained: DiscoveryReceipt,
): Promise<DiscoveryResult> {
  return createSymposiumModelDiscoveryRecovery(input, retained)(ops);
}
async function runExclusiveDiscovery(
  input: DiscoveryConfig,
  ops: DiscoveryOperations,
  onCatalog?: (models: CatalogModel[]) => void,
  onPhysicalCleanup?: (
    receipt: DiscoveryReceipt,
    evidence: DiscoveryPhysicalCleanupEvidence,
  ) => void,
  routingOnly = false,
  onOwnedReady?: (receipt: DiscoveryReceipt, evidence: DiscoveryOwnedReadyEvidence) => void,
  onNotDispatched?: (configHash: string, kind: DiscoveryNotDispatchedEvidence['kind']) => void,
): Promise<DiscoveryResult> {
  let receipt: DiscoveryReceipt | undefined;
  let journalAbsenceConfirmed = false;
  let notDispatchedClean = false;
  let initialCustodyRejected = false;
  let attemptConfigHash: string | undefined;
  let config: DiscoveryConfig;
  let client: DiscoveryReadClient | undefined;
  let result: DiscoveryResult;
  let discovered: CatalogModel[] | undefined;
  let resumed = false;
  let networkObservation: RoutingNetworkObservation | undefined;
  let creationConfirmed = false;
  let stage: DiscoveryDiagnostic['stage'] = 'preflight';
  let createDispatch: DiscoveryDiagnostic['createDispatch'] = 'not-entered';
  let failureDetails: { diagnostic: DiscoveryDiagnostic; diagnosticPersisted: boolean } | undefined;
  const diagnose = async (error: unknown) => {
    const diagnostic = DiscoveryDiagnosticSchema.parse({
      stage,
      createDispatch,
      ...classifyDiscoveryFailure(error),
      recordedAt: new Date().toISOString(),
    });
    let diagnosticPersisted = false;
    try {
      if (ops.recordDiagnostic) {
        await ops.recordDiagnostic(diagnostic);
        diagnosticPersisted = true;
      }
    } catch {
      /* Never turn failed persistence into cleanup evidence. */
    }
    failureDetails = { diagnostic, diagnosticPersisted };
    return failureDetails;
  };
  const verify = async () => ops.verifyCustody(config);
  const owned = (row: Sandbox, expected: DiscoveryReceipt) =>
    row.name === expected.name &&
    row.workspace === config.workspace &&
    row.labels['mitzo.discovery'] === 'models' &&
    row.labels['mitzo.discovery.claim'] === discoveryClaimLabel(expected.claim) &&
    (!expected.id || row.id === expected.id);
  try {
    config = configSchema.parse(input);
    if (routingOnly !== !!config.routingDiagnostic)
      throw new DiscoveryNotDispatchedError('Diagnostic capability required');
    try {
      await verify();
    } catch (error) {
      // This trusted read-only boundary precedes ANY journal read or native dispatch.
      // Release this invocation's lease only; prior native state remains unknown.
      if (routingOnly) {
        initialCustodyRejected = true;
        attemptConfigHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      }
      throw error;
    }
    const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    attemptConfigHash = configHash;
    const previous = await ops.readReceipt();
    if (previous !== undefined) {
      const parsed = receiptSchema.parse(previous);
      if (parsed.configHash !== configHash)
        return { status: 'reconciliation_required', inference: false };
      receipt = parsed;
      resumed = true;
      createDispatch = 'possibly-dispatched';
      creationConfirmed = !!receipt.id;
    } else {
      journalAbsenceConfirmed = true;
      if (routingOnly && !ops.observeRouting)
        throw new DiscoveryNotDispatchedError('Diagnostic observer required');
      receipt = {
        name: `md-${randomBytes(8).toString('hex')}`,
        claim: randomBytes(32).toString('hex'),
        configHash,
      };
      try {
        await ops.persistReceipt(receipt, true);
        await verify();
      } catch {
        // This local preflight precedes create; no external allocation was dispatched.
        throw new DiscoveryNotDispatchedError('Custody preflight failed');
      }
      stage = 'create';
      createDispatch = 'possibly-dispatched';
      await ops.create(receipt, config);
    }
    if (!resumed) {
      stage = 'readiness';
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
          if (selected.phase === 'Ready' && onOwnedReady)
            onOwnedReady(receipt, createDiscoveryOwnedReadyEvidence(config, receipt, selected));
          await ops.persistReceipt(receipt, false);
        }
        if (selected?.phase === 'Ready') break;
        await ops.wait();
      }
      if (!selected || selected.phase !== 'Ready') throw new Error('Not ready');
      stage = 'provider-verification';
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
      stage = 'native-initialize';
      client = await ops.openClient(receipt);
      await client.initialize();
      stage = 'account-read';
      const account = z
        .object({ account: z.object({ type: z.literal('chatgpt') }) })
        .safeParse(await client.request('account/read', { refreshToken: false }));
      if (!account.success) throw new DiscoveryNativeMetadataFailure('account_schema');
      if (!routingOnly) {
        stage = 'model-list';
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
      } else {
        await verify();
        result = { status: 'complete', inference: false, modelCount: 0, lunaModels: [] };
      }
    } else result = { status: 'reconciled', inference: false };
  } catch (error) {
    if (
      error instanceof DiscoveryNotDispatchedError &&
      !resumed &&
      !creationConfirmed &&
      !receipt?.id &&
      !client &&
      (stage === 'preflight' || stage === 'create')
    ) {
      try {
        if (receipt && ops.clearUndispatchedReceipt) await ops.clearUndispatchedReceipt(receipt);
        else if (receipt) await ops.clearReceipt(receipt);
        else if (!journalAbsenceConfirmed)
          throw new Error('Missing journal identity', { cause: error });
        receipt = undefined;
        notDispatchedClean = journalAbsenceConfirmed;
      } catch {
        /* retain reconciliation if journal cleanup fails */
      }
    }
    // Deliberately never surface command output, provider errors, identity or credential data.
    result = {
      status: initialCustodyRejected
        ? 'failed'
        : receipt || !journalAbsenceConfirmed
          ? 'reconciliation_required'
          : 'failed',
      inference: false,
      ...(await diagnose(error)),
    };
  }
  // Read the exact owned console while the sandbox still exists. Never let observation
  // failures bypass the original cancellation/deletion/physical-absence protocol.
  if (routingOnly && receipt?.id && !resumed) {
    try {
      await verify();
      const rows = z.array(sandboxSchema).parse(await ops.list());
      const matches = rows.filter((row) => row.name === receipt!.name || row.id === receipt!.id);
      if (matches.length !== 1 || !owned(matches[0], receipt))
        throw new Error('Diagnostic owner changed');
      networkObservation = RoutingNetworkObservationSchema.parse(
        await ops.observeRouting!(receipt),
      );
      await verify();
    } catch (error) {
      result = { status: 'reconciliation_required', inference: false };
      if (!failureDetails) await diagnose(error);
    }
  }
  stage = 'cleanup';
  try {
    client?.close();
  } catch {
    /* cleanup still required */
  }
  if (receipt) {
    try {
      let clean = false;
      let cleanupFailure: DiscoveryCommandFailure | undefined;
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
          } catch (error) {
            if (error instanceof DiscoveryCommandFailure) cleanupFailure ??= error;
            /* deletion and host absence are still required */
          }
          try {
            await ops.delete(receipt);
          } catch (error) {
            if (error instanceof DiscoveryCommandFailure) cleanupFailure = error;
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
      if (!clean) {
        result = { status: 'reconciliation_required', inference: false };
        if (!failureDetails) await diagnose(cleanupFailure ?? new Error('Cleanup unconfirmed'));
      } else {
        // Capture positive cleanup proof before a guarded clear can delete the journal
        // and then fail its postcheck. This never authorizes credential cleanup itself.
        onPhysicalCleanup?.(receipt, physicalCleanupProof(receipt));
        await ops.clearReceipt(receipt);
        if (result.status === 'reconciliation_required')
          result = { status: resumed ? 'reconciled' : 'failed', inference: false };
      }
    } catch (error) {
      result = {
        status: 'reconciliation_required',
        inference: false,
        ...('diagnostic' in result && result.diagnostic
          ? { diagnostic: result.diagnostic, diagnosticPersisted: result.diagnosticPersisted }
          : await diagnose(error)),
      };
    }
  }
  if (result.status === 'complete' && discovered && onCatalog) {
    try {
      onCatalog(structuredClone(discovered));
    } catch (error) {
      stage = 'catalog-publication';
      return { status: 'failed', inference: false, ...(await diagnose(error)) };
    }
  }
  if (
    result.status === 'failed' &&
    (notDispatchedClean || initialCustodyRejected) &&
    !receipt &&
    attemptConfigHash
  )
    onNotDispatched?.(attemptConfigHash, initialCustodyRejected ? 'not-entered' : 'not-dispatched');
  return { ...result, ...failureDetails, ...(networkObservation ? { networkObservation } : {}) };
}
