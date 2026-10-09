import { createHash } from 'node:crypto';
import type { CredentialReference } from './credentials.js';
import {
  OpenAIKeyOperationStore,
  openAIKeyResourceBindings,
  type KeyOperation,
} from './openai-key-operation-store.js';

export interface ManagedOpenAIAccount {
  id: string;
  label: string;
  credentialRef: CredentialReference;
  providerName: string;
  providerId: string;
}
export interface VersionedKeychain {
  authorize?(reference: CredentialReference, signal: AbortSignal): Promise<void>;
  read(
    reference: CredentialReference,
    signal: AbortSignal,
  ): Promise<{ value: string; version: string | null; managed?: boolean }>;
  write(
    reference: CredentialReference,
    value: string,
    version: string,
    signal: AbortSignal,
    expectedVersion?: string | null,
  ): Promise<void>;
}
export class OpenAIKeychainAuthorizationRequired extends Error {
  constructor() {
    super('Authorize Apple Keychain access on the Mac');
  }
}
export class OpenAIKeyRequestError extends Error {
  constructor(readonly code: 'KEY_VALIDATION_FAILED' | 'ACCOUNT_CHANGED') {
    super(code);
  }
}
export interface OpenAIKeyGateway {
  inspect(account: ManagedOpenAIAccount, signal: AbortSignal): Promise<{ version: string }>;
  pause(account: ManagedOpenAIAccount, signal: AbortSignal): Promise<void>;
  replace(
    account: ManagedOpenAIAccount,
    value: string,
    expectedVersion: string,
    signal: AbortSignal,
  ): Promise<{ version: string }>;
}
export interface OpenAIKeyHealth {
  accountId: string;
  label: string;
  health: 'not_verified' | 'ready' | 'needs_attention' | 'unavailable';
  revision: string;
  canSynchronize: boolean;
  errorCode: string | null;
  verifiedAt: number | null;
}
type Selection = { accountId: string; revision: string; sameProject: boolean };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Keychain is canonical for the existing host consumer; the gateway is its managed replica.
 * Its atomic key+operation marker lets restart distinguish committed writes without saving secrets. */
export class OpenAIKeyManagement {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      accounts: () => ManagedOpenAIAccount[];
      store: OpenAIKeyOperationStore;
      keychain: VersionedKeychain;
      gateway: OpenAIKeyGateway;
      validateKey: (value: string, signal: AbortSignal) => Promise<void>;
      gatewayBinding: string;
      workspace: string;
      gate?: <T>(work: () => Promise<T>) => Promise<T>;
      managedAccountIds?: readonly string[];
    },
  ) {}
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.options.gate) return this.options.gate(work);
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      release();
    }
  }
  private binding(account: ManagedOpenAIAccount) {
    return digest({
      ...account,
      label: undefined,
      gateway: this.options.gatewayBinding,
      workspace: this.options.workspace,
    });
  }
  private account(id: string) {
    const accounts = this.options.accounts();
    const account = accounts.find((item) => item.id === id);
    if (
      !account ||
      account.credentialRef.provider !== 'keychain' ||
      !account.providerName ||
      !account.providerId ||
      (this.options.managedAccountIds && !this.options.managedAccountIds.includes(id))
    )
      throw new Error('OpenAI account is not configured for key replacement');
    this.assertResourceOwnership(account);
    if (
      accounts.some(
        (item) =>
          item.id !== id &&
          (digest(item.credentialRef) === digest(account.credentialRef) ||
            item.providerId === account.providerId ||
            item.providerName === account.providerName),
      )
    )
      throw new Error('Shared credentials require separate configuration');
    return account;
  }
  private assertResourceOwnership(account: ManagedOpenAIAccount) {
    if (this.options.store.hasOtherResourceOwner(account.id, openAIKeyResourceBindings(account)))
      throw new Error(
        'OpenAI credentials or provider are recorded under another account; operator reconciliation is required',
      );
  }
  private async state(account: ManagedOpenAIAccount, signal: AbortSignal) {
    const binding = this.binding(account);
    const latest = this.options.store.latest(account.id);
    const pending = this.options.store.pending().find((item) => item.accountId === account.id);
    const completed = this.options.store.completed(account.id);
    const [keychain, gateway] = await Promise.all([
      this.options.keychain.read(account.credentialRef, signal),
      this.options.gateway.inspect(account, signal),
    ]);
    const revision = digest({
      binding,
      latest: latest?.revision ?? 0,
      phase: latest?.phase,
      keychain: keychain.version,
      gateway: gateway.version,
    });
    const ready =
      !pending &&
      completed?.binding === binding &&
      keychain.version === completed.id &&
      gateway.version === completed.gatewayVersion;
    const knownUnpairedKey =
      !completed &&
      (keychain.version !== null ||
        keychain.managed === true ||
        (latest?.phase === 'aborted' && latest.keychainBeforeVersion !== null));
    const needsAttention = !!pending || (!!completed && !ready) || knownUnpairedKey;
    const status: OpenAIKeyHealth = {
      accountId: account.id,
      label: account.label,
      revision,
      health: ready ? 'ready' : needsAttention ? 'needs_attention' : 'not_verified',
      canSynchronize: pending
        ? pending.binding === binding && keychain.version === pending.id
        : completed
          ? completed.binding === binding && keychain.version === completed.id
          : keychain.version === null && keychain.managed !== true,
      errorCode: needsAttention
        ? (pending?.errorCode ?? 'CREDENTIAL_DRIFT')
        : latest?.phase === 'aborted'
          ? latest.errorCode
          : null,
      verifiedAt: ready ? completed!.verifiedAt : null,
    };
    return { status, keychain, gateway, pending, binding, latest, completed };
  }
  async list(signal: AbortSignal): Promise<OpenAIKeyHealth[]> {
    return this.serial(async () => {
      const results: OpenAIKeyHealth[] = [];
      for (const configured of this.options.accounts()) {
        if (
          this.options.managedAccountIds &&
          !this.options.managedAccountIds.includes(configured.id)
        )
          continue;
        try {
          results.push((await this.state(this.account(configured.id), signal)).status);
        } catch (error) {
          if (
            error instanceof OpenAIKeychainAuthorizationRequired &&
            this.options.keychain.authorize
          ) {
            try {
              const account = this.account(configured.id);
              results.push({
                accountId: account.id,
                label: account.label,
                health: 'unavailable',
                revision: await this.authorizationRevision(account, signal),
                canSynchronize: false,
                errorCode: 'KEYCHAIN_AUTHORIZATION_REQUIRED',
                verifiedAt: null,
              });
              continue;
            } catch {
              /* Other binding failures remain unavailable. */
            }
          }
          results.push({
            accountId: configured.id,
            label: configured.label,
            health: 'unavailable',
            revision: '',
            canSynchronize: false,
            errorCode: 'CONNECTION_UNAVAILABLE',
            verifiedAt: null,
          });
        }
      }
      return results;
    });
  }
  private async authorizationRevision(account: ManagedOpenAIAccount, signal: AbortSignal) {
    return digest({
      binding: this.binding(account),
      latest: this.options.store.latest(account.id)?.revision ?? 0,
      gateway: (await this.options.gateway.inspect(account, signal)).version,
      purpose: 'keychain-authorization',
    });
  }
  /** The router requires recent browser reauthorization; listing, recovery and consumers never call this. */
  async authorize(input: { accountId: string; revision: string }, signal: AbortSignal) {
    return this.serial(async () => {
      const account = this.account(input.accountId);
      if (
        !this.options.keychain.authorize ||
        !input.revision ||
        input.revision !== (await this.authorizationRevision(account, signal))
      )
        throw new OpenAIKeyRequestError('ACCOUNT_CHANGED');
      await this.options.keychain.authorize(account.credentialRef, signal);
      return (await this.state(this.account(input.accountId), signal)).status;
    });
  }
  /** Called while ConnectionsService holds its admission gate. Legacy unadopted keys are unchanged. */
  async assertReady(accountId: string, signal: AbortSignal) {
    const configured = this.options.accounts().find((account) => account.id === accountId);
    if (configured) this.assertResourceOwnership(configured);
    if (!this.options.store.latest(accountId)) return;
    const account = this.account(accountId);
    const state = await this.state(account, signal);
    this.checkReady(state);
  }
  private checkReady(state: Awaited<ReturnType<OpenAIKeyManagement['state']>>) {
    const latest = state.latest;
    if (!latest) {
      if (state.status.health !== 'not_verified')
        throw new Error('OpenAI credentials need attention');
      return;
    }
    const unchangedLegacy =
      latest.phase === 'aborted' &&
      !state.completed &&
      state.status.health === 'not_verified' &&
      state.keychain.version === null &&
      state.keychain.managed !== true &&
      latest.keychainBeforeVersion === null &&
      state.gateway.version === latest.gatewayVersion;
    if (state.status.health !== 'ready' && !unchangedLegacy)
      throw new Error('OpenAI credentials need attention');
  }
  manages(accountId: string) {
    return (
      (!this.options.managedAccountIds || this.options.managedAccountIds.includes(accountId)) &&
      this.options.accounts().some((account) => account.id === accountId)
    );
  }
  get enabled() {
    return !this.options.managedAccountIds || this.options.managedAccountIds.length > 0;
  }
  close() {
    this.options.store.close();
  }
  /** Host consumers participate in the same mutation fence and read the canonical item per request. */
  resolveKey(accountId: string, signal = AbortSignal.timeout(30000)): Promise<string> {
    return this.serial(async () => {
      const account = this.account(accountId);
      const state = await this.state(account, signal);
      this.checkReady(state);
      return state.keychain.value;
    });
  }
  private async selected(input: Selection, signal: AbortSignal) {
    if (!input.sameProject) throw new Error('Confirm the same work project');
    const account = this.account(input.accountId);
    const state = await this.state(account, signal);
    if (!input.revision || state.status.revision !== input.revision)
      throw new OpenAIKeyRequestError('ACCOUNT_CHANGED');
    return { account, ...state };
  }
  private async validate(value: string, signal: AbortSignal) {
    if (!value.trim() || value.length > 16384)
      throw new OpenAIKeyRequestError('KEY_VALIDATION_FAILED');
    try {
      await this.options.validateKey(value, signal);
    } catch {
      throw new OpenAIKeyRequestError('KEY_VALIDATION_FAILED');
    }
  }
  private async finish(
    operation: KeyOperation,
    account: ManagedOpenAIAccount,
    value: string,
    signal: AbortSignal,
  ) {
    if (this.binding(this.account(account.id)) !== operation.binding)
      throw new Error('Account binding changed');
    const keychain = await this.options.keychain.read(account.credentialRef, signal);
    if (keychain.version !== operation.id || keychain.value !== value)
      throw new Error('Keychain changed');
    const before = await this.options.gateway.inspect(account, signal);
    if (before.version !== operation.gatewayVersion) throw new Error('Gateway changed');
    this.options.store.update(operation.id, { phase: 'gateway_started' });
    const after = await this.options.gateway.replace(
      account,
      value,
      operation.gatewayVersion,
      signal,
    );
    if (after.version === before.version) throw new Error('Gateway replacement not acknowledged');
    const confirmed = await this.options.gateway.inspect(account, signal);
    const saved = await this.options.keychain.read(account.credentialRef, signal);
    if (
      confirmed.version !== after.version ||
      saved.version !== operation.id ||
      saved.value !== value ||
      this.binding(this.account(account.id)) !== operation.binding
    )
      throw new Error('Replacement verification failed');
    this.options.store.update(operation.id, {
      phase: 'complete',
      gatewayVersion: after.version,
      errorCode: null,
      verifiedAt: Date.now(),
    });
  }
  async replace(
    input: Selection & { apiKey: string },
    signal: AbortSignal,
  ): Promise<OpenAIKeyHealth> {
    return this.serial(async () => {
      const selected = await this.selected(input, signal);
      if (selected.pending && selected.pending.binding !== selected.binding)
        throw new Error('Account binding changed; operator reconciliation is required');
      await this.validate(input.apiKey, signal);
      return this.install(selected, input.apiKey, signal);
    });
  }
  private async install(
    selected: Awaited<ReturnType<OpenAIKeyManagement['selected']>>,
    value: string,
    signal: AbortSignal,
  ) {
    const { account, binding, gateway, keychain } = selected;
    if (
      this.binding(this.account(account.id)) !== binding ||
      (await this.options.gateway.inspect(account, signal)).version !== gateway.version
    )
      throw new OpenAIKeyRequestError('ACCOUNT_CHANGED');
    const operation = this.options.store.begin(
      {
        accountId: account.id,
        binding,
        gatewayVersion: gateway.version,
        keychainBeforeVersion: keychain.version,
        ...openAIKeyResourceBindings(account),
      },
      selected.pending?.id,
    );
    let failure = 'CHAT_PAUSE_FAILED';
    let writeStarted = false;
    try {
      await this.options.gateway.pause(account, signal);
      failure = 'ACCOUNT_CHANGED';
      const current = await this.options.keychain.read(account.credentialRef, signal);
      if (
        current.version !== keychain.version ||
        current.value !== keychain.value ||
        this.binding(this.account(account.id)) !== binding
      )
        throw new Error('Keychain changed');
      failure = 'KEYCHAIN_WRITE_UNCONFIRMED';
      writeStarted = true;
      await this.options.keychain.write(
        account.credentialRef,
        value,
        operation.id,
        signal,
        keychain.version,
      );
      this.options.store.update(operation.id, { phase: 'keychain_written' });
      failure = 'CHAT_UPDATE_UNCONFIRMED';
      await this.finish(operation, account, value, signal);
    } catch {
      this.options.store.update(operation.id, {
        ...(!writeStarted && failure === 'CHAT_PAUSE_FAILED' && !selected.pending
          ? { phase: 'aborted' as const }
          : {}),
        errorCode: failure,
      });
    }
    return (await this.state(this.account(account.id), signal)).status;
  }
  async synchronize(input: Selection, signal: AbortSignal): Promise<OpenAIKeyHealth> {
    return this.serial(async () => {
      const selected = await this.selected(input, signal);
      if (!selected.status.canSynchronize) throw new Error('Replacement key must be entered again');
      await this.validate(selected.keychain.value, signal);
      if (!selected.pending) return this.install(selected, selected.keychain.value, signal);
      const operation = selected.pending;
      try {
        await this.options.gateway.pause(selected.account, signal);
        this.options.store.update(operation.id, {
          gatewayVersion: selected.gateway.version,
          phase: 'keychain_written',
        });
        await this.finish(
          { ...operation, gatewayVersion: selected.gateway.version },
          selected.account,
          selected.keychain.value,
          signal,
        );
      } catch {
        this.options.store.update(operation.id, { errorCode: 'SYNC_PENDING' });
      }
      return (await this.state(this.account(selected.account.id), signal)).status;
    });
  }
  async recover(signal: AbortSignal) {
    return this.serial(async () => {
      for (const operation of this.options.store.pending()) {
        try {
          const account = this.account(operation.accountId);
          if (this.binding(account) !== operation.binding) continue;
          const state = await this.state(account, signal);
          if (state.gateway.version !== operation.gatewayVersion) continue;
          if (
            operation.phase === 'prepared' &&
            state.keychain.version === operation.keychainBeforeVersion &&
            (operation.keychainBeforeVersion !== null || state.keychain.managed !== true)
          ) {
            this.options.store.update(operation.id, { phase: 'aborted', errorCode: 'NOT_APPLIED' });
          } else if (
            state.keychain.version === operation.id &&
            (operation.phase === 'prepared' || operation.phase === 'keychain_written')
          ) {
            await this.options.gateway.pause(account, signal);
            await this.finish(operation, account, state.keychain.value, signal);
          }
          // A started gateway write is ambiguous after interruption; attended sync is required.
        } catch {
          this.options.store.update(operation.id, { errorCode: 'SYNC_PENDING' });
        }
      }
    });
  }
}
