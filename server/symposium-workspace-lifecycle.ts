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
export type SandboxCreationFence = <T>(
  verify: () => void,
  operation: (markDispatched: () => void) => Promise<T>,
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
  private draining = false;
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
  create: SandboxCreationFence = (verify, operation) =>
    this.run(async () => {
      if (this.draining) throw new Error('Workspace is shutting down');
      verify();
      let dispatched = false;
      const result = await operation(() => {
        if (this.draining) throw new Error('Workspace is shutting down');
        if (dispatched) throw new Error('Sandbox creation dispatch already recorded');
        try {
          verify();
          this.custody();
        } catch (error) {
          throw new SandboxCreationPreflightError(error);
        }
        this.save(true);
        dispatched = true;
      });
      if (!dispatched) throw new Error('Sandbox creation dispatch was not recorded');
      this.custody();
      this.save(false);
      return result;
    });
  cleanup<T>(operation: () => Promise<T>): Promise<T> {
    return this.run(operation);
  }
}
