import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  HOST_CODEX_CONTINUITY_CONTRACT,
  hostCodexContinuityTargetRevision,
  reviewedLegacyHostTargetRevisions,
} from './host-codex-continuity.js';
import { SessionRuntimeBindingV1Schema } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import { readBoundedFile } from './bounded-file-read.js';
import {
  resolveOrdinarySessionRuntime,
  type OrdinarySessionRuntimeCatalog,
} from './ordinary-session-runtime.js';

const reference = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
const label = z
  .string()
  .max(256)
  .refine((value) => value.trim().length > 0);
const LegacyTargetConfiguration = z.strictObject({
  version: z.literal(1),
  targetId: reference,
  label,
  hostId: reference,
  runtimeContractRevision: reference,
});
const TargetConfiguration = z.discriminatedUnion('version', [
  LegacyTargetConfiguration,
  LegacyTargetConfiguration.extend({
    version: z.literal(2),
    continuityContract: z.literal(HOST_CODEX_CONTINUITY_CONTRACT),
  }).strict(),
]);
const targetError = 'Invalid ordinary local Codex target configuration';
const inventoryError = 'Invalid ordinary local Codex capability inventory';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Operator-declared routing configuration only. hostId identifies this host and
 * runtimeContractRevision declares its reviewed local Codex contract. Neither is
 * evidence that the running host matches that declaration: admission must verify
 * both before any provider/resource effect. Credentials belong to AccountProfiles.
 */
export class OrdinaryLocalCodexTarget {
  #descriptor;
  #declaration;
  readonly #configuration: z.infer<typeof TargetConfiguration>;

  constructor(configuration: unknown) {
    const parsed = TargetConfiguration.safeParse(configuration);
    if (!parsed.success) throw new Error(targetError);
    const config = parsed.data;
    this.#configuration = config;
    this.#descriptor = {
      targetId: config.targetId,
      label: config.label,
      location: 'local' as const,
      harness: 'codex' as const,
      targetRevision:
        config.version === 2
          ? hostCodexContinuityTargetRevision(config.targetId, config.hostId)
          : digest([
              'ordinary-local-codex-target-v1',
              config.targetId,
              config.hostId,
              config.runtimeContractRevision,
            ]),
    };
    this.#declaration = {
      targetId: this.#descriptor.targetId,
      targetRevision: this.#descriptor.targetRevision,
      location: this.#descriptor.location,
      harness: this.#descriptor.harness,
      hostId: config.hostId,
      runtimeContractRevision: config.runtimeContractRevision,
    };
  }

  descriptor() {
    return { ...this.#descriptor };
  }

  compatibleTargetRevisions(executableSha256: string): string[] {
    const config = this.#configuration;
    return [
      this.#descriptor.targetRevision,
      ...(config.version === 2
        ? reviewedLegacyHostTargetRevisions(config.targetId, config.hostId, executableSha256)
        : []),
    ];
  }

  /** Server-internal expectations for the owning admission authority. These
   * remain declarations, never observed evidence, and are not picker inventory.
   */
  admissionDeclaration() {
    return { ...this.#declaration };
  }
}

/** Dormant loader, called only with operator-owned server environment. No API/WS
 * caller supplies this path. Absence is disabled, never inferred from profiles,
 * Symposium, OpenShell or a default host. Regular files only; allocation/read is
 * bounded even if the file grows. Errors never expose file names or contents.
 */
export function loadOrdinaryLocalCodexTarget(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): OrdinaryLocalCodexTarget | undefined {
  const path = env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE;
  if (path === undefined) return undefined;
  let fd: number | undefined;
  let result: OrdinaryLocalCodexTarget | undefined;
  let invalid = false;
  try {
    if (!isAbsolute(path)) throw new Error(targetError);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error(targetError);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(fd, 65536));
    result = new OrdinaryLocalCodexTarget(JSON.parse(content));
  } catch {
    invalid = true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        invalid = true;
      }
    }
  }
  if (invalid) throw new Error(targetError);
  return result;
}

const effort = z.string().min(1).max(64).regex(/^\S+$/);
const Model = z
  .strictObject({
    id: reference,
    label,
    reasoningEfforts: z.array(effort).max(16).optional(),
    defaultReasoningEffort: effort.optional(),
  })
  .superRefine((model, ctx) => {
    const efforts = model.reasoningEfforts ?? [];
    if (
      new Set(efforts).size !== efforts.length ||
      (model.defaultReasoningEffort !== undefined &&
        !efforts.includes(model.defaultReasoningEffort))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid thinking metadata' });
  });
const InventoryAccounts = z
  .array(
    z
      .strictObject({
        account: SessionRuntimeBindingV1Schema.shape.account
          .extend({ provider: z.enum(['openai-codex', 'openai']) })
          .strict(),
        planType: z
          .string()
          .max(200)
          .refine((plan) => plan.trim().length > 0),
        label,
        models: z
          .array(Model)
          .min(1)
          .max(256)
          .refine((models) => new Set(models.map((model) => model.id)).size === models.length),
        modelDiscovery: z.strictObject({
          source: z.enum(['cached', 'configured']),
          stale: z.boolean(),
          updatedAt: z.number().finite().nonnegative().optional(),
        }),
      })
      .superRefine((entry, context) => {
        if (
          (entry.planType.trim().toLowerCase() === 'api') !==
          (entry.account.provider === 'openai')
        )
          context.addIssue({ code: 'custom', message: 'Account billing class mismatch' });
      }),
  )
  .max(64)
  .refine(
    (accounts) =>
      new Set(accounts.map((account) => account.account.accountId)).size === accounts.length,
  );

/** Bounded, credential-free metadata snapshot for the first projected route.
 * No authenticated endpoint or dispatch consumer yet. Reuse existing account and
 * cached model authority; compatible/configured does not mean signed in, owned,
 * enrolled or ready. Future admission must revalidate the exact selected tuple.
 */
export class OrdinaryLocalCodexCapabilityCatalog {
  #catalog: OrdinarySessionRuntimeCatalog;
  #inventory;

  constructor(
    profiles: AccountProfiles,
    target: OrdinaryLocalCodexTarget | undefined,
    deployment: OrdinarySessionRuntimeCatalog['deployment'],
  ) {
    if (!['ordinary', 'custodian'].includes(deployment)) throw new Error(inventoryError);
    let metadata;
    try {
      metadata = profiles.ordinaryLocalCodexInventory();
    } catch {
      throw new Error(inventoryError);
    }
    const parsed = InventoryAccounts.safeParse(metadata);
    if (!parsed.success) throw new Error(inventoryError);
    const source = parsed.data;
    const targets = target ? [target.descriptor()] : [];
    this.#catalog = {
      deployment,
      enabledHarnesses: source.length ? ['codex'] : [],
      accounts: source.map(({ account, planType }) =>
        account.provider === 'openai'
          ? {
              ...account,
              provider: 'openai' as const,
              auth: { kind: 'api-credential', openshellTargetIds: [] },
            }
          : {
              ...account,
              provider: 'openai-codex' as const,
              planType,
              auth: { kind: 'host-login' },
            },
      ),
      targets: targets.map(({ targetId, targetRevision, location }) => ({
        targetId,
        targetRevision,
        location,
      })),
    };
    const accounts = source.map(({ account, label, models, modelDiscovery }) => ({
      account,
      label,
      models,
      modelDiscovery,
    }));
    const routes = source.flatMap(({ account }) =>
      targets.flatMap(({ targetId }) => {
        const modes = (['ask', 'agent', 'auto'] as const).filter(
          (mode) =>
            resolveOrdinarySessionRuntime(
              { account, targetId, harness: 'codex', mode },
              this.#catalog,
            ).status === 'compatible',
        );
        return modes.length
          ? [
              {
                account,
                targetId,
                harness: 'codex' as const,
                modes,
                skillCeiling: 'unsupported' as const,
              },
            ]
          : [];
      }),
    );
    const unavailable =
      deployment === 'custodian'
        ? 'custodian_requires_openshell'
        : !target
          ? 'target_unconfigured'
          : !source.length
            ? 'accounts_unavailable'
            : undefined;
    this.#inventory = {
      version: 1 as const,
      authority: 'configuration-only' as const,
      defaultLocation: 'openshell' as const,
      capabilityRevision: digest([
        'ordinary-local-codex-capabilities-v1',
        this.#catalog,
        accounts.map(({ account, models, modelDiscovery }) => [
          account,
          models.map(({ id, reasoningEfforts, defaultReasoningEffort }) => [
            id,
            reasoningEfforts,
            defaultReasoningEffort,
          ]),
          modelDiscovery.source,
          modelDiscovery.stale,
        ]),
      ]),
      accounts,
      targets,
      routes,
      locations: [
        {
          location: 'openshell' as const,
          status: 'unavailable' as const,
          reason: 'openshell_projection_pending' as const,
        },
        unavailable
          ? { location: 'local' as const, status: 'unavailable' as const, reason: unavailable }
          : { location: 'local' as const, status: 'configured' as const },
      ],
    };
    if (Buffer.byteLength(JSON.stringify(this.#inventory), 'utf8') > 1048576)
      throw new Error(inventoryError);
  }

  inventory() {
    return structuredClone(this.#inventory);
  }

  resolve(request: unknown) {
    return resolveOrdinarySessionRuntime(request, this.#catalog);
  }
}
