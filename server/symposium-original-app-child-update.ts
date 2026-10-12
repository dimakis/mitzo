import { resolve } from 'node:path';
interface Child {
  readonly pid?: number;
  readonly connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  disconnect(): void;
}
export interface OriginalAppChildIdentity {
  readonly instanceId: string;
  readonly custodianPid: number;
  readonly controllerPid: number;
  readonly epoch: number;
}
const selectionBrand = Symbol('original accepted app child');
export interface OriginalAppChildSelection {
  readonly [selectionBrand]: true;
}
const selections = new WeakMap<
  object,
  { sourceCommit: string; sourceRoot: string; assertCurrent(): Promise<void>; used: boolean }
>();
const refuse = (detail = '') =>
  Error('Original accepted app-child transition unavailable' + (detail ? ': ' + detail : ''));
/** Same-process accepted launcher construction. The callback independently
 * checks original custody, accepted immutable candidate bytes and queue guard;
 * this token is not decoded from an HTTP/IPC request or JSON observation. */
export function createOriginalAppChildSelection(input: {
  sourceCommit: string;
  sourceRoot: string;
  assertCurrent(): Promise<void>;
}): OriginalAppChildSelection {
  if (
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    resolve(input.sourceRoot) !== input.sourceRoot ||
    !input.sourceRoot.endsWith('/releases/' + input.sourceCommit.slice(0, 12)) ||
    typeof input.assertCurrent !== 'function'
  )
    throw refuse();
  const token = Object.freeze({ [selectionBrand]: true as const });
  selections.set(token, { ...input, used: false });
  return token;
}
/** Original main owns created/ready/exited calls using its actual fork reference.
 * Only replace is handed to the registered launcher. Disconnect requests the
 * existing authenticated IPC controller drain; nextSource never skips its
 * positive exact-child exit. No VM or native capacity action exists here. */
export function createOriginalAppChildUpdateControl({
  nativeSourceRoot,
  assertOriginalCustodianCurrent,
}: {
  nativeSourceRoot: string;
  assertOriginalCustodianCurrent(): void;
}) {
  if (
    resolve(nativeSourceRoot) !== nativeSourceRoot ||
    !/\/releases\/[a-f0-9]{12}$/.test(nativeSourceRoot) ||
    typeof assertOriginalCustodianCurrent !== 'function'
  )
    throw refuse();
  let sourceRoot = nativeSourceRoot,
    active:
      | {
          child: Child;
          sourceRoot: string;
          identity?: Readonly<OriginalAppChildIdentity>;
          current?: () => void;
        }
      | undefined;
  let latest: Readonly<OriginalAppChildIdentity> | undefined;
  let pending:
    | {
        selection: NonNullable<ReturnType<typeof selections.get>>;
        old: Child;
        oldIdentity: Readonly<OriginalAppChildIdentity>;
        exited: boolean;
        resolve(identity: Readonly<OriginalAppChildIdentity>): void;
        reject(error: Error): void;
      }
    | undefined;
  let fenced = false;
  const original = () => {
    if (fenced) throw refuse('original lifetime fenced');
    const result: unknown = assertOriginalCustodianCurrent();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw refuse();
    }
  };
  const candidate = async (selected: NonNullable<ReturnType<typeof selections.get>>) => {
    original();
    const result: unknown = await selected.assertCurrent();
    if (result !== undefined) throw refuse('candidate source/queue proof');
    original();
  };
  const activeCurrent = () => {
    original();
    if (
      !active?.identity ||
      !active.current ||
      !active.child.connected ||
      active.child.exitCode !== null ||
      active.child.signalCode !== null
    )
      throw refuse('actual current child missing');
    active.current();
    original();
    return active;
  };
  const port = {
    async replace(token: OriginalAppChildSelection): Promise<Readonly<OriginalAppChildIdentity>> {
      const selected = selections.get(token);
      if (!selected || selected.used || pending)
        throw refuse('single-use actual selection required');
      const prior = activeCurrent();
      if (
        selected.sourceRoot.slice(0, -12) !== nativeSourceRoot.slice(0, -12) ||
        selected.sourceRoot === sourceRoot
      )
        throw refuse('candidate namespace');
      await candidate(selected);
      if (pending || activeCurrent() !== prior || selected.used)
        throw refuse('original child changed before dispatch');
      selected.used = true;
      return new Promise((done, reject) => {
        pending = {
          selection: selected,
          old: prior.child,
          oldIdentity: prior.identity!,
          exited: false,
          resolve: done,
          reject,
        };
        try {
          prior.child.disconnect();
        } catch (error) {
          fenced = true;
          reject(error instanceof Error ? error : refuse('disconnect uncertain'));
        }
      });
    },
    async nextSource() {
      original();
      if (active) throw refuse('existing child must positively exit before another fork');
      if (pending) {
        if (!pending.exited) throw refuse('positive original child exit required');
        await candidate(pending.selection);
        return pending.selection.sourceRoot;
      }
      return sourceRoot;
    },
    currentSource() {
      original();
      return sourceRoot;
    },
    created(child: Child, selectedRoot: string) {
      original();
      if (
        active ||
        !Number.isSafeInteger(child.pid) ||
        child.pid! < 2 ||
        child.pid === process.pid ||
        !child.connected ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        selectedRoot !== (pending?.selection.sourceRoot ?? sourceRoot) ||
        (pending && !pending.exited)
      )
        throw refuse('original fork identity');
      active = { child, sourceRoot: selectedRoot };
    },
    ready(identity: Readonly<OriginalAppChildIdentity>, current: () => void) {
      original();
      if (
        !active ||
        typeof current !== 'function' ||
        identity.custodianPid !== process.pid ||
        identity.controllerPid !== active.child.pid ||
        !identity.instanceId ||
        !Number.isSafeInteger(identity.epoch) ||
        identity.epoch < 1 ||
        !active.child.connected ||
        active.child.exitCode !== null ||
        active.child.signalCode !== null ||
        (latest &&
          (identity.instanceId !== latest.instanceId ||
            identity.custodianPid !== latest.custodianPid ||
            identity.epoch <= latest.epoch ||
            identity.controllerPid === latest.controllerPid))
      )
        throw refuse('awaited new child identity');
      current();
      original();
      const actual = Object.freeze({ ...identity });
      active.identity = actual;
      active.current = current;
      latest = actual;
      sourceRoot = active.sourceRoot;
      if (pending) {
        if (
          !pending.exited ||
          sourceRoot !== pending.selection.sourceRoot ||
          actual.epoch <= pending.oldIdentity.epoch ||
          actual.controllerPid === pending.oldIdentity.controllerPid
        )
          throw refuse('replacement child mismatch');
        const done = pending.resolve;
        pending = undefined;
        done(actual);
      }
    },
    exited(child: Child) {
      original();
      if (
        !active ||
        active.child !== child ||
        (child.exitCode === null && child.signalCode === null)
      )
        throw refuse('positive exact child exit required');
      if (pending) {
        if (pending.old !== child) throw refuse('foreign original child');
        pending.exited = true;
      }
      active = undefined;
    },
    fence(error: Error) {
      fenced = true;
      pending?.reject(error);
    },
  };
  return Object.freeze(port);
}
