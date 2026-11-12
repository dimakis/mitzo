import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { CredentialReference } from './credentials.js';
import type { CatalogModel } from './model-catalog.js';
import {
  OpenAIEnrollmentModelsSchema,
  REVIEWED_OPENAI_ENROLLMENT_MODELS,
} from './openai-enrollment-models.js';
const defaultEnrollmentModels = () =>
  REVIEWED_OPENAI_ENROLLMENT_MODELS.filter((model) => model.id === 'gpt-6-luna');
import { openAIEnrollmentCredentialReference } from './openai-account-enrollment-keychain.js';
import type { OpenAIEnrollmentProvider } from './openai-provider-enrollment-gateway.js';
import {
  ApiAccountModelsSchema,
  QualifiedApiConnectionSchema,
  discoverApiAccountModels,
  ApiAccountSetupError,
  type ApiModelDiscovery,
  type QualifiedApiConnection,
  type ApiDiscoveryOptions,
} from './api-account-setup.js';
import { createLogger } from './logger.js';
const log = createLogger('api-account-enrollment');

export type OpenAIEnrollmentPhase =
  'reserved' | 'keychain_created' | 'provider_creating' | 'ready' | 'failed' | 'needs_attention';
export interface OpenAIEnrollmentAccount {
  id: string;
  requestId: string;
  label: string;
  projectLabel: string;
  state: 'connecting' | 'ready' | 'failed' | 'needs_attention';
  endpoint?: string;
  errorCode?: string;
}
export interface OpenAIEnrollmentProfile {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic-api';
  credentialRef: CredentialReference;
  sandboxProvider?: string;
  sandboxProviderId?: string;
  connection?: QualifiedApiConnection;
  credentialVersion?: string;
  models: CatalogModel[];
}
export const OpenAIAccountEnrollmentInputSchema = z
  .object({
    requestId: z.uuid(),
    label: z.string().trim().min(1).max(120),
    projectLabel: z.string().trim().min(1).max(120),
    apiKey: z.string().min(1).max(16384),
    billingConfirmed: z.literal(true),
    connection: QualifiedApiConnectionSchema.optional(),
    models: ApiAccountModelsSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.models && !input.connection)
      ctx.addIssue({ code: 'custom', message: 'Explicit models require a custom API connection' });
    if (
      input.models?.some(
        (model) => model.id.includes(input.apiKey) || model.label.includes(input.apiKey),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Model metadata must not contain credentials' });
  });
const Input = OpenAIAccountEnrollmentInputSchema;
const Provider = z
  .object({
    name: z.string(),
    id: z.string().min(1).max(128),
    type: z.literal('mitzo-openai-keychain-spike'),
    workspace: z.string().min(1),
    version: z.literal('1'),
  })
  .strict();
const Record = z
  .object({
    operationId: z.uuid(),
    requestId: z.uuid(),
    accountId: z.string(),
    label: z.string().min(1).max(120),
    projectLabel: z.string().min(1).max(120),
    controllerBinding: z.string().regex(/^[a-f0-9]{64}$/),
    connection: QualifiedApiConnectionSchema.optional(),
    requestedModels: ApiAccountModelsSchema.optional(),
    phase: z.enum([
      'reserved',
      'keychain_created',
      'provider_creating',
      'ready',
      'failed',
      'needs_attention',
    ]),
    provider: Provider.nullable(),
    models: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            reasoningEfforts: z.array(z.string()).optional(),
            defaultReasoningEffort: z.string().optional(),
          })
          .strict(),
      )
      .nullable()
      .default(defaultEnrollmentModels),
    errorCode: z
      .enum(['VALIDATION_FAILED', 'KEYCHAIN_UNCONFIRMED', 'PROVIDER_UNCONFIRMED', 'RESOURCE_DRIFT'])
      .nullable(),
  })
  .strict();
type EnrollmentRecord = z.infer<typeof Record>;
/** A different browser request cannot bypass retained, uncertain side effects. */
export class OpenAIEnrollmentUnresolvedError extends Error {
  constructor() {
    super(
      'An earlier OpenAI enrollment is unresolved. Check its status and reconcile the saved operation before submitting another key.',
    );
    this.name = 'OpenAIEnrollmentUnresolvedError';
  }
}
const publicAccount = (row: EnrollmentRecord): OpenAIEnrollmentAccount => ({
  id: row.accountId,
  requestId: row.requestId,
  label: row.label,
  projectLabel: row.projectLabel,
  ...(row.connection ? { endpoint: row.connection.endpoint } : {}),
  ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  state:
    row.phase === 'ready'
      ? 'ready'
      : row.phase === 'needs_attention'
        ? 'needs_attention'
        : row.phase === 'failed'
          ? 'failed'
          : 'connecting',
});

/** Private metadata and durable intent only; keys and key digests never enter this journal. */
export class OpenAIAccountEnrollmentStore {
  private db: Database.Database;
  constructor(path: string, options: { readonly?: boolean } = {}) {
    if (!isAbsolute(path)) throw new Error('Enrollment journal requires an absolute private path');
    if (!options.readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Error('Enrollment journal directory must be private');
    if (!options.readonly)
      try {
        closeSync(
          openSync(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          // eslint-disable-next-line preserve-caught-error -- Host filesystem paths stay out of enrollment errors.
          throw new Error('Enrollment journal unavailable');
      }
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      file.uid !== process.getuid?.() ||
      (file.mode & 0o777) !== 0o600
    )
      throw new Error('Enrollment journal must be private');
    this.db = new Database(path, {
      readonly: options.readonly ?? false,
      fileMustExist: options.readonly ?? false,
    });
    if (!options.readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS openai_account_enrollments (request_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL)',
      );
    }
  }
  private parse(metadata: string): EnrollmentRecord {
    try {
      const row = Record.parse(JSON.parse(metadata));
      if (
        row.accountId !== 'openai-' + row.operationId ||
        (row.provider && row.provider.name !== 'mitzo-openai-' + row.operationId) ||
        (row.phase === 'ready' && ((!row.connection && !row.provider) || !row.models)) ||
        (row.connection && row.provider)
      )
        throw new Error();
      if (row.models)
        (row.connection ? ApiAccountModelsSchema : OpenAIEnrollmentModelsSchema).parse(row.models);
      return row;
    } catch {
      throw new Error('Enrollment journal is invalid');
    }
  }
  rows(): EnrollmentRecord[] {
    return (
      this.db.prepare('SELECT metadata FROM openai_account_enrollments ORDER BY rowid').all() as {
        metadata: string;
      }[]
    ).map(({ metadata }) => this.parse(metadata));
  }
  account(id: string) {
    return this.rows().find((row) => row.accountId === id);
  }
  reserve(
    input: Pick<z.infer<typeof Input>, 'requestId' | 'label' | 'projectLabel'> & {
      controllerBinding: string;
      connection?: QualifiedApiConnection;
      requestedModels?: z.infer<typeof ApiAccountModelsSchema>;
    },
    existingIds: readonly string[],
  ) {
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare('SELECT metadata FROM openai_account_enrollments WHERE request_id=?')
          .get(input.requestId) as { metadata: string } | undefined;
        if (prior) {
          const row = this.parse(prior.metadata);
          if (
            row.label !== input.label ||
            row.projectLabel !== input.projectLabel ||
            !isDeepStrictEqual(row.connection, input.connection) ||
            !isDeepStrictEqual(row.requestedModels, input.requestedModels)
          )
            throw new Error('Enrollment request changed');
          return { row, created: false };
        }
        if (this.rows().some((row) => row.phase !== 'ready' && row.phase !== 'failed'))
          throw new OpenAIEnrollmentUnresolvedError();
        const operationId = randomUUID();
        const row: EnrollmentRecord = {
          ...input,
          operationId,
          accountId: 'openai-' + operationId,
          phase: 'reserved',
          provider: null,
          models: null,
          errorCode: null,
        };
        if (existingIds.includes(row.accountId))
          throw new Error('Enrollment account already exists');
        this.db
          .prepare('INSERT INTO openai_account_enrollments VALUES (?, ?, ?)')
          .run(row.requestId, row.accountId, JSON.stringify(row));
        return { row, created: true };
      })
      .immediate();
  }
  update(
    row: EnrollmentRecord,
    patch: Partial<Pick<EnrollmentRecord, 'phase' | 'provider' | 'errorCode' | 'models'>>,
  ) {
    const next = Record.parse({ ...row, ...patch });
    this.db
      .prepare('UPDATE openai_account_enrollments SET metadata=? WHERE request_id=?')
      .run(JSON.stringify(next), row.requestId);
    return next;
  }
  readyProfiles(): OpenAIEnrollmentProfile[] {
    return this.rows()
      .filter((row) => row.phase === 'ready')
      .map((row) => ({
        id: row.accountId,
        label: row.label,
        provider: row.connection?.protocol === 'messages' ? 'anthropic-api' : 'openai',
        credentialRef: openAIEnrollmentCredentialReference(row.operationId),
        ...(row.connection
          ? {
              connection: row.connection,
              ...(row.connection.protocol === 'messages'
                ? { credentialVersion: row.operationId }
                : {}),
            }
          : { sandboxProvider: row.provider!.name, sandboxProviderId: row.provider!.id }),
        models: row.models!,
      }));
  }
  /** Startup only: interrupted attempts remain status-only and never replay writes. */
  recoverInterrupted() {
    for (const row of this.rows()) {
      if (['reserved', 'keychain_created', 'provider_creating'].includes(row.phase))
        this.update(row, {
          phase: 'needs_attention',
          errorCode:
            row.phase === 'provider_creating' ? 'PROVIDER_UNCONFIRMED' : 'KEYCHAIN_UNCONFIRMED',
        });
    }
  }
  close() {
    this.db.close();
  }
}
function borrowsResources(profile: unknown, row: EnrollmentRecord) {
  if (!profile || typeof profile !== 'object') return false;
  const account = profile as {
    id?: unknown;
    credentialRef?: unknown;
    sandboxProvider?: unknown;
    sandboxProviderId?: unknown;
  };
  const ref =
    account.credentialRef && typeof account.credentialRef === 'object'
      ? (account.credentialRef as CredentialReference)
      : undefined;
  const expected = openAIEnrollmentCredentialReference(row.operationId);
  return (
    account.id === row.accountId ||
    account.sandboxProvider === 'mitzo-openai-' + row.operationId ||
    (!!row.provider && account.sandboxProviderId === row.provider.id) ||
    (!!ref &&
      ref.provider === expected.provider &&
      ref.service === expected.service &&
      ref.account === expected.account)
  );
}
/** Configured registry reads are readonly and cannot adopt static aliases of retained resources. */
export function readReadyOpenAIAccountProfiles(
  path: string,
  configuredProfiles: unknown[] = [],
): OpenAIEnrollmentProfile[] {
  let store: OpenAIAccountEnrollmentStore | undefined;
  try {
    store = new OpenAIAccountEnrollmentStore(path, { readonly: true });
    for (const row of store.rows()) {
      if (configuredProfiles.some((profile) => borrowsResources(profile, row))) throw new Error();
    }
    return store.readyProfiles();
  } catch {
    throw new Error('OpenAI enrollment registry unavailable or conflicting');
  } finally {
    store?.close();
  }
}

export interface OpenAIEnrollmentKeychain {
  create(operationId: string, value: string, signal: AbortSignal): Promise<CredentialReference>;
  read(
    reference: CredentialReference,
    signal: AbortSignal,
  ): Promise<{ value: string; version: string | null; managed?: boolean }>;
}
export interface OpenAIEnrollmentGateway {
  create(
    operationId: string,
    value: string,
    signal: AbortSignal,
  ): Promise<OpenAIEnrollmentProvider>;
  inspect(operationId: string, signal: AbortSignal): Promise<OpenAIEnrollmentProvider | undefined>;
}
/** Server-private custody evidence only. Never persist in public replay or return
 * through an API. This observation contains no key, model limits or dispatch grant.
 */
export type OpenAIEnrollmentCredentialObservation = Readonly<{
  version: 1;
  accountId: string;
  enrollmentOperationId: string;
  controllerBinding: string;
  credentialVersion: string;
  provider: Readonly<OpenAIEnrollmentProvider>;
  credentialFingerprint: string;
}>;
export class OpenAIAccountEnrollment {
  constructor(
    private readonly options: {
      store: OpenAIAccountEnrollmentStore;
      gateway: OpenAIEnrollmentGateway;
      keychain: OpenAIEnrollmentKeychain;
      validateKey: (value: string, signal: AbortSignal) => Promise<void>;
      discoverModels?: (value: string, signal: AbortSignal) => Promise<CatalogModel[]>;
      discoverApiModels?: (
        endpoint: string,
        value: string,
        signal: AbortSignal,
        options?: ApiDiscoveryOptions,
      ) => Promise<ApiModelDiscovery>;
      gate: <T>(work: () => Promise<T>) => Promise<T>;
      readGate?: <T>(work: () => Promise<T>, signal: AbortSignal) => Promise<T>;
      existingAccountIds: () => readonly string[];
      gatewayBinding: string;
      workspace: string;
    },
  ) {}
  private controllerBinding() {
    return createHash('sha256')
      .update(JSON.stringify([this.options.gatewayBinding, this.options.workspace]))
      .digest('hex');
  }
  assertResourceOwnership(profile: OpenAIEnrollmentProfile) {
    for (const row of this.options.store.rows()) {
      if (profile.id !== row.accountId && borrowsResources(profile, row))
        throw new Error('OpenAI enrollment resource belongs to another account');
    }
  }
  list() {
    return this.options.store.rows().map(publicAccount);
  }
  manages(id: string) {
    return !!this.options.store.account(id);
  }
  async discoverModels(
    endpoint: string,
    apiKey: string,
    signal: AbortSignal,
    options?: ApiDiscoveryOptions,
  ): Promise<ApiModelDiscovery> {
    try {
      return this.options.discoverApiModels
        ? await this.options.discoverApiModels(
            endpoint,
            apiKey,
            signal,
            ...(options ? [options] : []),
          )
        : await discoverApiAccountModels(endpoint, apiKey, signal, undefined, options);
    } catch (cause) {
      log.warn('API model discovery failed', {
        stage: 'catalog',
        code:
          cause instanceof ApiAccountSetupError
            ? cause.code
            : signal.aborted
              ? 'CANCELLED'
              : 'CATALOG_UNAVAILABLE',
      });
      throw cause;
    }
  }
  async enroll(
    input: z.infer<typeof Input>,
    signal: AbortSignal,
  ): Promise<OpenAIEnrollmentAccount> {
    const parsed = Input.safeParse(input);
    if (!parsed.success) throw new Error('Invalid OpenAI enrollment request');
    return this.options.gate(async () => {
      const {
        requestId,
        label,
        projectLabel,
        apiKey,
        connection,
        models: requestedModels,
      } = parsed.data;
      const reservation = this.options.store.reserve(
        {
          requestId,
          label,
          projectLabel,
          controllerBinding: this.controllerBinding(),
          ...(connection ? { connection } : {}),
          ...(requestedModels ? { requestedModels } : {}),
        },
        this.options.existingAccountIds(),
      );
      let row = reservation.row;
      if (!reservation.created) return publicAccount(row);
      let errorCode: EnrollmentRecord['errorCode'] = 'VALIDATION_FAILED';
      try {
        signal.throwIfAborted();
        let models: CatalogModel[];
        if (connection) {
          if (requestedModels) models = ApiAccountModelsSchema.parse(requestedModels);
          else {
            const catalog = await this.discoverModels(
              connection.endpoint,
              apiKey,
              signal,
              connection.protocol === 'messages' ? connection : undefined,
            );
            if (catalog.partial)
              throw new ApiAccountSetupError(
                'CATALOG_PARTIAL',
                'Select an explicit model list from the partial provider catalog.',
              );
            models = ApiAccountModelsSchema.parse(catalog.models);
          }
        } else {
          await this.options.validateKey(apiKey, signal);
          models = OpenAIEnrollmentModelsSchema.parse(
            this.options.discoverModels
              ? await this.options.discoverModels(apiKey, signal)
              : defaultEnrollmentModels(),
          );
        }
        signal.throwIfAborted();
        row = this.options.store.update(row, { models });
        errorCode = 'KEYCHAIN_UNCONFIRMED';
        const reference = await this.options.keychain.create(row.operationId, apiKey, signal);
        if (
          JSON.stringify(reference) !==
          JSON.stringify(openAIEnrollmentCredentialReference(row.operationId))
        )
          throw new Error();
        const saved = await this.options.keychain.read(reference, signal);
        if (saved.version !== row.operationId || saved.managed !== true || saved.value !== apiKey)
          throw new Error();
        row = this.options.store.update(row, { phase: 'keychain_created' });
        if (connection) {
          signal.throwIfAborted();
          row = this.options.store.update(row, { phase: 'ready', errorCode: null });
          return publicAccount(row);
        }
        errorCode = 'PROVIDER_UNCONFIRMED';
        signal.throwIfAborted();
        row = this.options.store.update(row, { phase: 'provider_creating' });
        const provider = Provider.parse(
          await this.options.gateway.create(row.operationId, apiKey, signal),
        );
        if (
          provider.name !== 'mitzo-openai-' + row.operationId ||
          provider.workspace !== this.options.workspace
        )
          throw new Error();
        const inspected = await this.options.gateway.inspect(row.operationId, signal);
        const confirmed = await this.options.keychain.read(reference, signal);
        if (
          JSON.stringify(inspected) !== JSON.stringify(provider) ||
          confirmed.version !== row.operationId ||
          confirmed.managed !== true ||
          confirmed.value !== apiKey
        )
          throw new Error();
        signal.throwIfAborted();
        row = this.options.store.update(row, { phase: 'ready', provider, errorCode: null });
      } catch (cause) {
        log.warn('API account enrollment did not complete', {
          stage: errorCode,
          code:
            cause instanceof ApiAccountSetupError
              ? cause.code
              : signal.aborted
                ? 'CANCELLED'
                : errorCode,
          operationId: row.operationId,
          requestId: row.requestId,
        });
        row = this.options.store.update(row, {
          phase: errorCode === 'VALIDATION_FAILED' ? 'failed' : 'needs_attention',
          errorCode,
        });
      }
      return publicAccount(row);
    });
  }
  private async verifiedCredential(id: string, signal: AbortSignal) {
    const row = this.options.store.account(id);
    if (
      !row ||
      row.phase !== 'ready' ||
      !row.provider ||
      row.controllerBinding !== this.controllerBinding() ||
      row.provider.workspace !== this.options.workspace
    )
      throw new Error('OpenAI enrolled account needs attention');
    try {
      signal.throwIfAborted();
      const [keychain, provider] = await Promise.all([
        this.options.keychain.read(openAIEnrollmentCredentialReference(row.operationId), signal),
        this.options.gateway.inspect(row.operationId, signal),
      ]);
      if (
        keychain.version !== row.operationId ||
        keychain.managed !== true ||
        !keychain.value ||
        !isDeepStrictEqual(provider, row.provider) ||
        !isDeepStrictEqual(this.options.store.account(id), row)
      )
        throw new Error();
      signal.throwIfAborted();
      const observation: OpenAIEnrollmentCredentialObservation = Object.freeze({
        version: 1,
        accountId: row.accountId,
        enrollmentOperationId: row.operationId,
        controllerBinding: row.controllerBinding,
        credentialVersion: keychain.version,
        provider: Object.freeze({ ...row.provider }),
        credentialFingerprint: createHash('sha256')
          .update('openai-enrollment-credential-v1\0')
          .update(keychain.value)
          .digest('hex'),
      });
      return { key: keychain.value, observation };
    } catch {
      throw new Error('OpenAI enrolled account needs attention');
    }
  }
  async assertReady(id: string, signal: AbortSignal) {
    // The runtime caller already holds the Connections admission gate.
    await this.verifiedCredential(id, signal);
  }
  private withVerifiedCredential<T>(
    id: string,
    signal: AbortSignal,
    work: (key: string, observation: OpenAIEnrollmentCredentialObservation) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const gate =
      readOnly && this.options.readGate
        ? <R>(read: () => Promise<R>) => this.options.readGate!(read, signal)
        : this.options.gate;
    return gate(async () => {
      signal.throwIfAborted();
      const captured = await this.verifiedCredential(id, signal);
      // Callback failures belong to their caller and must retain their identity.
      const result = await work(captured.key, captured.observation);
      const renewed = await this.verifiedCredential(id, signal);
      if (!isDeepStrictEqual(captured.observation, renewed.observation))
        throw new Error('OpenAI enrolled account needs attention');
      return result;
    });
  }
  /** Hold the existing enrollment/Connections gate for a private custody read.
   * The callback must not reacquire that non-reentrant gate. Renewal checks drift
   * after the callback; it cannot undo callback effects or order native dispatch.
   */
  withCredentialCustody<T>(
    id: string,
    signal: AbortSignal,
    work: (observation: OpenAIEnrollmentCredentialObservation) => Promise<T>,
  ): Promise<T> {
    return this.withVerifiedCredential(id, signal, (_key, observation) => work(observation));
  }
  close() {
    this.options.store.close();
  }
  resolveKey(id: string, signal: AbortSignal) {
    return this.withVerifiedCredential(id, signal, async (key) => key, true);
  }
  /** Canonical host custody, independent of live sandbox replica availability. */
  resolveHostKey(id: string, signal: AbortSignal): Promise<string> {
    const gate = this.options.readGate
      ? <R>(read: () => Promise<R>) => this.options.readGate!(read, signal)
      : this.options.gate;
    return gate(async () => {
      signal.throwIfAborted();
      const row = this.options.store.account(id);
      if (
        !row ||
        row.phase !== 'ready' ||
        (!row.connection && !row.provider) ||
        row.controllerBinding !== this.controllerBinding() ||
        (row.provider && row.provider.workspace !== this.options.workspace)
      )
        throw new Error('OpenAI enrolled account needs attention');
      const key = await this.options.keychain.read(
        openAIEnrollmentCredentialReference(row.operationId),
        signal,
      );
      signal.throwIfAborted();
      if (
        key.version !== row.operationId ||
        key.managed !== true ||
        !key.value.trim() ||
        !isDeepStrictEqual(this.options.store.account(id), row) ||
        row.controllerBinding !== this.controllerBinding()
      )
        throw new Error('OpenAI enrolled account needs attention');
      return key.value;
    });
  }
}
