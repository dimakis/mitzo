import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  lstatSync,
  writeFileSync,
  renameSync,
  fsyncSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  assertDiscoveryOwnedReadyEvidence,
  assertDiscoveryPhysicalCleanupEvidence,
  assertDiscoveryOriginalPhysicalCleanupEvidence,
  type DiscoveryOwnedReadyEvidence,
  type DiscoveryPhysicalCleanupEvidence,
  type DiscoveryReceipt,
} from './symposium-model-discovery.js';
export type SandboxCreationFence = <T>(
  verify: () => void,
  operation: (markDispatched: () => void, markSettled?: () => void) => Promise<T>,
) => Promise<T>;
/** Produced only by the retained fence before it attempts the durable dispatch write. */
export class SandboxCreationPreflightError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Sandbox creation preflight rejected', {
      cause,
    });
  }
}
/** Retained by the sole owned host. An uncertain external create is never
 * converted into proof of absence by inventory polling or a process restart. */
export class SymposiumWorkspaceLifecycle {
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  private pendingCreation: symbol | undefined;
  private draining = false;
  private controllerPaused = false;
  pauseController() {
    this.controllerPaused = true;
  }
  async quiesceController(signal: AbortSignal) {
    this.pauseController();
    await this.tail;
    signal.throwIfAborted();
    if (this.uncertain) throw new Error('Workspace creation outcome requires host recovery');
  }
  resumeController() {
    this.custody();
    if (this.draining) throw new Error('Workspace is shutting down');
    if (this.uncertain) throw new Error('Workspace creation outcome requires host recovery');
    this.controllerPaused = false;
  }
  beginDrain() {
    this.draining = true;
  }
  async drain(signal: AbortSignal) {
    this.beginDrain();
    await this.tail;
    signal.throwIfAborted();
    if (this.uncertain) throw new Error('Workspace creation outcome requires host recovery');
  }
  constructor(
    private readonly path: string,
    private readonly custody: () => void,
  ) {
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.mode & 0o077 ||
      parent.uid !== process.getuid?.()
    )
      throw new Error('Private workspace fence directory required');
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.mode & 0o077 ||
          stat.uid !== process.getuid?.() ||
          stat.size > 1000
        )
          throw new Error('Invalid workspace fence');
        const value = JSON.parse(readFileSync(fd, 'utf8'));
        if (value.version !== 1 || typeof value.uncertain !== 'boolean')
          throw new Error('Invalid workspace fence');
        this.uncertain = value.uncertain;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private save(uncertain: boolean) {
    this.uncertain = true;
    const temp = `${this.path}.${randomUUID()}`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, uncertain }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    const parent = openSync(dirname(this.path), constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    this.uncertain = uncertain;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.custody();
      if (this.uncertain) throw new Error('Workspace creation outcome requires host recovery');
      return operation();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private createForToken<T>(
    token: symbol,
    verify: () => void,
    operation: (markDispatched: () => void, markSettled?: () => void) => Promise<T>,
  ): Promise<T> {
    return this.run(async () => {
      if (this.draining) throw new Error('Workspace is shutting down');
      if (this.controllerPaused) throw new Error('Workspace controller unavailable');
      verify();
      let dispatched = false;
      let settled = false;
      const result = await operation(
        () => {
          if (this.draining) throw new Error('Workspace is shutting down');
          if (this.controllerPaused) throw new Error('Workspace controller unavailable');
          if (dispatched) throw new Error('Sandbox creation dispatch already recorded');
          try {
            verify();
            this.custody();
          } catch (error) {
            throw new SandboxCreationPreflightError(error);
          }
          this.pendingCreation = token;
          this.save(true);
          dispatched = true;
        },
        () => {
          if (!dispatched || settled || this.pendingCreation !== token)
            throw new Error('Sandbox terminal receipt changed');
          this.custody();
          this.save(false);
          this.pendingCreation = undefined;
          settled = true;
        },
      );
      if (!dispatched) throw new Error('Sandbox creation dispatch was not recorded');
      this.custody();
      if (!settled) {
        if (this.pendingCreation !== token) throw new Error('Sandbox terminal receipt changed');
        this.save(false);
        this.pendingCreation = undefined;
      }
      return result;
    });
  }
  create: SandboxCreationFence = (verify, operation) =>
    this.createForToken(Symbol('sandbox creation'), verify, operation);
  /** An original in-process creation may reconcile only its own durable uncertainty. */
  retainDiscoveryCreation() {
    const token = Symbol('original discovery creation');
    let invoked = false;
    let active = false;
    let dispatched = false;
    let bound: Pick<DiscoveryReceipt, 'name' | 'claim' | 'configHash'> | undefined;
    let ready: DiscoveryOwnedReadyEvidence | undefined;
    return {
      create: ((verify, operation) => {
        if (invoked) return Promise.reject(new Error('Original discovery creation already used'));
        invoked = true;
        return this.createForToken(token, verify, async (dispatch, settle) => {
          active = true;
          try {
            return await operation(() => {
              if (!bound) throw new Error('Original discovery receipt was not bound');
              dispatch();
              dispatched = true;
            }, settle);
          } finally {
            active = false;
          }
        });
      }) as SandboxCreationFence,
      bindReceipt: (receipt: DiscoveryReceipt) => {
        if (
          !active ||
          bound ||
          this.pendingCreation === token ||
          receipt.id ||
          !/^md-[0-9a-f]{16}$/.test(receipt.name) ||
          !/^[0-9a-f]{64}$/.test(receipt.claim) ||
          !/^[0-9a-f]{64}$/.test(receipt.configHash)
        )
          throw new Error('Original discovery receipt binding changed');
        bound = Object.freeze({
          name: receipt.name,
          claim: receipt.claim,
          configHash: receipt.configHash,
        });
      },
      retainReady: (evidence: DiscoveryOwnedReadyEvidence) => {
        assertDiscoveryOwnedReadyEvidence(evidence);
        if (
          !bound ||
          evidence.receipt.name !== bound.name ||
          evidence.receipt.claim !== bound.claim ||
          evidence.receipt.configHash !== bound.configHash
        )
          throw new Error('Original discovery Ready identity changed');
        if (ready) {
          if (JSON.stringify(ready.receipt) !== JSON.stringify(evidence.receipt))
            throw new Error('Original discovery Ready identity changed');
          return;
        }
        if (!invoked || this.pendingCreation !== token || !this.uncertain)
          throw new Error('Original discovery creation is not pending');
        ready = evidence;
      },
      recover: <T>(
        operation: () => Promise<{ result: T; physicalCleanup?: DiscoveryPhysicalCleanupEvidence }>,
      ): Promise<T> => {
        const result = this.tail.then(async () => {
          this.custody();
          const pending = this.uncertain;
          if (pending && (this.pendingCreation !== token || !dispatched || !bound))
            throw new Error('Workspace creation outcome requires original host recovery');
          const outcome = await operation();
          this.custody();
          if (pending) {
            if (
              !this.uncertain ||
              this.pendingCreation !== token ||
              !dispatched ||
              !bound ||
              !outcome.physicalCleanup
            )
              throw new Error('Original discovery physical cleanup unconfirmed');
            assertDiscoveryOriginalPhysicalCleanupEvidence(bound, outcome.physicalCleanup);
            if (ready) assertDiscoveryPhysicalCleanupEvidence(ready, outcome.physicalCleanup);
            this.custody();
            this.save(false);
            this.pendingCreation = undefined;
          }
          return outcome.result;
        });
        this.tail = result.catch(() => undefined);
        return result;
      },
    };
  }
  cleanup<T>(operation: () => Promise<T>): Promise<T> {
    return this.run(operation);
  }
}
