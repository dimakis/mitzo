import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import {
  captureClaudeSdkCredentials,
  reopenClaudeSdkCredentials,
} from './claude-sdk-credentials.js';
import { AnthropicApiCustody } from './anthropic-api-custody.js';
import { SharedAuthorityProof } from './shared-authority-proof.js';
import { observeSdkAuthorityCheck, type SdkAuthorityCaller } from './sdk-authority-observation.js';
import { annotateAuthorityFailure } from './runtime-failure-diagnostics.js';
import {
  assertSdkRepositoryCallback,
  type SdkRepositoryCallback,
} from './sdk-repository-callback.js';
import {
  assertSdkRepositoryReadProjection,
  type SdkRepositoryReadProjection,
} from './credential-sdk-boundary.js';
import { readOrdinarySdkTurnDiagnostic } from './ordinary-sdk-turn-evidence.js';
import { ordinaryContributorCommandExecution } from './ordinary-codex-command-execution.js';
import { captureLocalRepositoryReader } from './local-repository-native-reader.js';

export interface SdkRepositoryReadOwner {
  readonly conversationId: string;
  readonly commandId: string;
  readonly sdkSessionId: string;
  readonly inputUuid: string;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly callback: SdkRepositoryCallback;
  readonly projection: SdkRepositoryReadProjection;
  readonly signal: AbortSignal;
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
  captureReader(options: { deadline: number }): ReturnType<typeof captureLocalRepositoryReader>;
}
const sdkRepositoryReadOwners = new WeakSet<object>();
export function assertSdkRepositoryReadOwner(owner: SdkRepositoryReadOwner) {
  if (!sdkRepositoryReadOwners.has(owner))
    throw Error('Original SDK repository read owner required');
  owner.assertCurrentSync();
}

/** Trusted backend owner only. A JSON request cannot construct this startup authority. */
export class OrdinaryLocalVertexSdkAuthority {
  readonly #custody: OrdinaryLocalVertexCustody;
  readonly #credential: ReturnType<typeof captureClaudeSdkCredentials>;
  readonly #apiCredentialProof = new SharedAuthorityProof();
  constructor(
    private readonly owners: {
      store: EventStore;
      custody: OrdinaryLocalVertexCustody;
      commandId: string;
      /** Login that owns the live driver; retained from its first registration. */
      ownerAuthSessionId: string;
      signal?: AbortSignal;
      /** Existing exact AccountProfiles.sdkEnv projection, re-resolved every effect. */
      environment(): Record<string, string | undefined>;
      /** Original operator, published profile, permission and workspace owners. */
      assertCurrent(signal: AbortSignal): Promise<void> | void;
      /** The same owners' per-tool check: synchronous fences plus claimed
       * checkout validation, without workspace reservation. */
      assertToolCurrent(signal: AbortSignal): Promise<void> | void;
      assertCurrentSync(signal: AbortSignal): void;
      sourceWriteRoots: readonly string[];
    },
  ) {
    this.#custody = structuredClone(owners.custody);
    this.#credential = reopenClaudeSdkCredentials(
      this.#custody.credentialAuthority,
      owners.environment(),
    );
    this.assertStartup(this.#custody.sessionId, owners.commandId);
  }
  /** Connect native setup and context waits to the original owner's lifetime. */
  bindAbortController(controller: AbortController) {
    const signal = this.owners.signal;
    if (!signal) return;
    signal.throwIfAborted();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', () => signal.removeEventListener('abort', abort), {
      once: true,
    });
  }
  sdkSessionId(): string {
    return this.#custody.sdkSessionId;
  }
  ownerAuthSessionId(): string {
    return this.owners.ownerAuthSessionId;
  }
  writeRoots(): readonly string[] {
    const credential = this.#custody.credentialAuthority;
    return [
      ...(!('kind' in credential)
        ? [dirname(credential.adc.path)]
        : credential.kind === 'claude-host-login'
          ? [credential.executable.path]
          : []),
      ...this.owners.sourceWriteRoots,
    ];
  }
  executable(): string | undefined {
    const credential = this.#custody.credentialAuthority;
    return 'kind' in credential && credential.kind === 'claude-host-login'
      ? credential.executable.path
      : undefined;
  }
  configDirectory(): string | undefined {
    const credential = this.#custody.credentialAuthority;
    return 'kind' in credential && credential.kind === 'claude-host-login'
      ? credential.config.path
      : undefined;
  }
  assertStartup(sessionId: string, commandId: string) {
    const admission = this.owners.store.getOrdinaryLocalVertexCommandAdmission(commandId);
    const receipt = this.owners.store.getSendCommand(commandId);
    const custody = this.owners.store.getOrdinaryLocalVertexCustody(sessionId);
    if (
      sessionId !== this.#custody.sessionId ||
      commandId !== this.owners.commandId ||
      receipt?.sessionId !== sessionId ||
      !admission ||
      !custody ||
      !isDeepStrictEqual(custody, this.#custody) ||
      !isDeepStrictEqual(admission.binding, custody.binding) ||
      admission.workspace.cwd !== custody.cwd ||
      admission.workspace.workspaceId !== custody.repositoryWorkspaceId
    )
      throw Error('Original SDK authority unavailable');
  }
  assertEnvironment(env: Record<string, string | undefined>) {
    this.#credential.assertCurrent(env);
  }
  /** Private SDK callback composition. Actual ACK and original query identity
   * are required in addition to the complete launched OS read ceiling. No
   * Codex context, native turn ID or filesystem grant is manufactured here. */
  captureRepositoryReadOwner(
    callback: SdkRepositoryCallback,
    projection: SdkRepositoryReadProjection,
  ): Readonly<SdkRepositoryReadOwner> {
    const signal = AbortSignal.any([
      callback.signal,
      ...(this.owners.signal ? [this.owners.signal] : []),
    ]);
    const custody = this.#custody;
    let inputUuid: string | undefined;
    const current = () => {
      signal.throwIfAborted();
      this.assertCurrentSync(signal);
      assertSdkRepositoryCallback(callback);
      assertSdkRepositoryReadProjection(projection, this);
      if (callback.sdkSessionId !== custody.sdkSessionId || callback.cwd !== custody.cwd)
        throw Error('Original SDK repository workspace changed');
      const admission = ordinaryContributorCommandExecution(
        this.owners.store,
        custody.sessionId,
        callback.commandId,
        { requireClaimed: true },
      );
      const evidence = readOrdinarySdkTurnDiagnostic(
        this.owners.store,
        custody.sessionId,
        callback.commandId,
      );
      if (
        !isDeepStrictEqual(admission.binding, custody.binding) ||
        admission.workspace.workspaceId !== custody.repositoryWorkspaceId ||
        admission.workspace.cwd !== custody.cwd ||
        !evidence.inputAcknowledged ||
        evidence.providerThreadId !== custody.sdkSessionId ||
        !evidence.providerTurnId ||
        (inputUuid !== undefined && evidence.providerTurnId !== inputUuid) ||
        this.owners.store
          .getOrdinarySdkTurnEvents(custody.sessionId, callback.commandId)
          .some((event) => event.type === 'ordinary_sdk_turn_settled') ||
        this.owners.store.getOrdinaryProviderTurnTerminal(custody.sessionId, callback.commandId) !==
          undefined
      )
        throw Error('Original active SDK input acknowledgment required');
      inputUuid = evidence.providerTurnId;
    };
    current();
    // Repository reads are per-tool callbacks: the Codex tool check, not the
    // deep proof. Prompt release still runs the deep proof for this turn.
    const full = async () => {
      current();
      await this.assertToolCurrent(signal, 'repository_read');
      current();
    };
    const owner = Object.freeze({
      conversationId: custody.sessionId,
      commandId: callback.commandId,
      sdkSessionId: custody.sdkSessionId,
      inputUuid: inputUuid!,
      cwd: custody.cwd,
      workspaceId: custody.repositoryWorkspaceId,
      callback,
      projection,
      signal,
      assertCurrentSync: current,
      assertCurrent: full,
      captureReader: (options: { deadline: number }) =>
        captureLocalRepositoryReader(projection, signal, current, full, options),
    });
    sdkRepositoryReadOwners.add(owner);
    return owner;
  }
  assertCurrentSync(signal: AbortSignal) {
    let check = 'authority.signal';
    try {
      signal.throwIfAborted();
      check = 'authority.owner';
      this.owners.assertCurrentSync(signal);
      check = 'authority.startup_receipt';
      this.assertStartup(this.#custody.sessionId, this.owners.commandId);
      check = 'authority.credentials';
      this.#credential.assertCurrent(this.owners.environment());
    } catch (error) {
      throw annotateAuthorityFailure(error, check);
    }
  }
  /**
   * Deep proof, for admission, chat startup, prompt release and turn results:
   * owner selection revalidation (workspace reservation, the repository
   * credential digest, which for personal sign-in runs `claude auth status`,
   * and checkout validation), the API keychain proof, then every synchronous
   * fence. Per-tool callbacks use `assertToolCurrent`.
   */
  async assertCurrent(signal: AbortSignal, caller: SdkAuthorityCaller) {
    observeSdkAuthorityCheck('deep', caller);
    let check = 'authority.signal';
    try {
      signal.throwIfAborted();
      check = 'authority.owner';
      await this.owners.assertCurrent(signal);
      check = 'authority.api_credentials';
      await this.#verifyApiCredential(signal);
      // Concurrent callers share the owner's in-flight deep proof and the API
      // keychain proof. A settled proof is never reused. The physical account,
      // operator, receipt and workspace fences below still run on every callback.
      this.assertCurrentSync(signal);
    } catch (error) {
      throw annotateAuthorityFailure(error, check);
    }
  }
  /**
   * Per-tool authority for SDK hooks, permission decisions and in-process MCP
   * handlers. It mirrors the reviewed Codex tool lease
   * (`FrozenHostCodexBootstrapAuthority` `assertToolCurrent`):
   * - synchronous fences first, so Stop, logout, ownership, receipt, custody
   *   and credential-identity changes refuse before any wait;
   * - the owner's selection tool check: operator, published profile,
   *   permission revision, admission receipt and claimed checkout validation
   *   (`workspace.validate`), without workspace reservation or the repository
   *   credential digest;
   * - for API keys, the keychain read, as Codex API logins also verify the key
   *   per tool;
   * - synchronous fences again after every wait.
   * The deep proof still runs at every prompt release and turn result.
   */
  async assertToolCurrent(signal: AbortSignal, caller: SdkAuthorityCaller) {
    observeSdkAuthorityCheck('tool', caller);
    let check = 'authority.signal';
    try {
      signal.throwIfAborted();
      this.assertCurrentSync(signal);
      check = 'authority.owner_tool';
      await this.owners.assertToolCurrent(signal);
      check = 'authority.api_credentials';
      await this.#verifyApiCredential(signal);
      this.assertCurrentSync(signal);
    } catch (error) {
      throw annotateAuthorityFailure(error, check);
    }
  }
  async #verifyApiCredential(signal: AbortSignal) {
    if (!(this.#credential instanceof AnthropicApiCustody)) return;
    const credential = this.#credential;
    const ownerSignal = this.owners.signal;
    // Concurrent callers join one in-flight keychain proof. It runs under the
    // owner's lifetime, while each caller can still abandon its own wait
    // promptly through its signal. Without an owner signal, each caller
    // proves on its own.
    if (ownerSignal)
      await this.#apiCredentialProof.run(
        'api_credentials',
        () => credential.verify(this.owners.environment(), ownerSignal),
        signal,
      );
    else await credential.verify(this.owners.environment(), signal);
  }
}
