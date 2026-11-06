import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import {
  captureClaudeSdkCredentials,
  reopenClaudeSdkCredentials,
} from './claude-sdk-credentials.js';

/** Trusted backend owner only. A JSON request cannot construct this startup authority. */
export class OrdinaryLocalVertexSdkAuthority {
  readonly #custody: OrdinaryLocalVertexCustody;
  readonly #credential: ReturnType<typeof captureClaudeSdkCredentials>;
  constructor(
    private readonly owners: {
      store: EventStore;
      custody: OrdinaryLocalVertexCustody;
      commandId: string;
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
  writeRoots(): readonly string[] {
    const credential = this.#custody.credentialAuthority;
    return [
      ...('kind' in credential
        ? [dirname(credential.executable.path)]
        : [dirname(credential.adc.path)]),
      ...this.owners.sourceWriteRoots,
    ];
  }
  executable(): string | undefined {
    const credential = this.#custody.credentialAuthority;
    return 'kind' in credential ? credential.executable.path : undefined;
  }
  configDirectory(): string | undefined {
    const credential = this.#custody.credentialAuthority;
    return 'kind' in credential ? credential.config.path : undefined;
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
  assertCurrentSync(signal: AbortSignal) {
    signal.throwIfAborted();
    this.owners.assertCurrentSync(signal);
    this.assertStartup(this.#custody.sessionId, this.owners.commandId);
    this.#credential.assertCurrent(this.owners.environment());
  }
  async assertCurrent(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.owners.assertCurrent(signal);
    // Admission verifies native sign-in; the running query checks accountInfo
    // before releasing each prompt. Tool callbacks retain the physical account,
    // operator and workspace fences without spawning another CLI status process.
    this.assertCurrentSync(signal);
  }
}
