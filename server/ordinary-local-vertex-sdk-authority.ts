import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import {
  captureClaudeSdkCredentials,
  reopenClaudeSdkCredentials,
} from './claude-sdk-credentials.js';
import { AnthropicApiCustody } from './anthropic-api-custody.js';
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
    const full = async () => {
      current();
      await this.assertCurrent(signal);
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
  async assertCurrent(signal: AbortSignal) {
    let check = 'authority.signal';
    try {
      signal.throwIfAborted();
      check = 'authority.owner';
      await this.owners.assertCurrent(signal);
      check = 'authority.api_credentials';
      if (this.#credential instanceof AnthropicApiCustody)
        await this.#credential.verify(this.owners.environment(), signal);
      // Admission verifies native sign-in; the running query checks accountInfo
      // before releasing each prompt. Tool callbacks retain the physical account,
      // operator and workspace fences without spawning another CLI status process.
      this.assertCurrentSync(signal);
    } catch (error) {
      throw annotateAuthorityFailure(error, check);
    }
  }
}
