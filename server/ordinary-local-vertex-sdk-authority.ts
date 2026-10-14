import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';

/** Trusted backend owner only. A JSON request cannot construct this startup authority. */
export class OrdinaryLocalVertexSdkAuthority {
  readonly #custody: OrdinaryLocalVertexCustody;
  readonly #credential: VertexAdcCustody;
  constructor(
    private readonly owners: {
      store: EventStore;
      custody: OrdinaryLocalVertexCustody;
      commandId: string;
      /** Existing exact AccountProfiles.sdkEnv projection, re-resolved every effect. */
      environment(): Record<string, string | undefined>;
      /** Original operator, published profile, permission and workspace owners. */
      assertCurrent(signal: AbortSignal): Promise<void> | void;
      assertCurrentSync(signal: AbortSignal): void;
      sourceWriteRoots: readonly string[];
    },
  ) {
    this.#custody = structuredClone(owners.custody);
    this.#credential = VertexAdcCustody.reopen(
      this.#custody.credentialAuthority,
      owners.environment(),
    );
    this.assertStartup(this.#custody.sessionId, owners.commandId);
  }
  sdkSessionId(): string {
    return this.#custody.sdkSessionId;
  }
  writeRoots(): readonly string[] {
    return [dirname(this.#custody.credentialAuthority.adc.path), ...this.owners.sourceWriteRoots];
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
    this.assertCurrentSync(signal);
  }
}
