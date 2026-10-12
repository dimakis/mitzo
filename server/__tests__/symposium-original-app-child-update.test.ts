import { expect, it, vi } from 'vitest';
import {
  createOriginalAppChildSelection,
  createOriginalAppChildUpdateControl,
} from '../symposium-original-app-child-update.js';
const native = '/private/stage/releases/' + 'a'.repeat(12),
  app = '/private/stage/releases/' + 'b'.repeat(12);
function fixture() {
  let original = true,
    connected = true;
  const disconnect = vi.fn(() => {
    connected = false;
  });
  const child = {
    pid: 1001,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    get connected() {
      return connected;
    },
    disconnect,
  };
  const current = () => {
    if (!original) throw Error('original custodian lost');
  };
  const port = createOriginalAppChildUpdateControl({
    nativeSourceRoot: native,
    assertOriginalCustodianCurrent: current,
  });
  port.created(child, native);
  port.ready(
    { instanceId: 'actual', custodianPid: process.pid, controllerPid: 1001, epoch: 1 },
    current,
  );
  return {
    port,
    child,
    disconnect,
    current,
    lose: () => {
      original = false;
    },
  };
}
it('retains original custodian and forbids next fork until exact prior child has positively exited', async () => {
  const f = fixture(),
    accepted = vi.fn(async () => {}),
    candidate = createOriginalAppChildSelection({
      sourceCommit: 'b'.repeat(40),
      sourceRoot: app,
      assertCurrent: accepted,
    });
  const result = f.port.replace(candidate);
  await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledOnce());
  await expect(f.port.nextSource()).rejects.toThrow('positively');
  f.child.exitCode = 0;
  f.port.exited(f.child);
  expect(await f.port.nextSource()).toBe(app);
  const next = {
    pid: 1002,
    exitCode: null,
    signalCode: null,
    connected: true,
    disconnect: vi.fn(),
  };
  f.port.created(next, app);
  f.port.ready(
    { instanceId: 'actual', custodianPid: process.pid, controllerPid: 1002, epoch: 2 },
    f.current,
  );
  await expect(result).resolves.toMatchObject({ controllerPid: 1002, epoch: 2 });
  expect(f.port.currentSource()).toBe(app);
  await expect(f.port.nextSource()).rejects.toThrow('existing child');
  expect(accepted).toHaveBeenCalled();
  await expect(f.port.replace(candidate)).rejects.toThrow();
});
it('refuses JSON candidate replay, foreign child exit, stale epoch and lost original ownership', async () => {
  const f = fixture(),
    candidate = createOriginalAppChildSelection({
      sourceCommit: 'b'.repeat(40),
      sourceRoot: app,
      assertCurrent: async () => {},
    });
  await expect(f.port.replace(JSON.parse(JSON.stringify(candidate)))).rejects.toThrow();
  const work = f.port.replace(candidate);
  void work.catch(() => {});
  await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledOnce());
  expect(() => f.port.exited({ ...f.child, exitCode: 0 })).toThrow();
  f.child.exitCode = 0;
  f.port.exited(f.child);
  await f.port.nextSource();
  const next = {
    pid: 1002,
    exitCode: null,
    signalCode: null,
    connected: true,
    disconnect: vi.fn(),
  };
  f.port.created(next, app);
  expect(() =>
    f.port.ready(
      { instanceId: 'actual', custodianPid: process.pid, controllerPid: 1002, epoch: 1 },
      f.current,
    ),
  ).toThrow();
  f.lose();
  expect(() =>
    f.port.ready(
      { instanceId: 'actual', custodianPid: process.pid, controllerPid: 1002, epoch: 2 },
      f.current,
    ),
  ).toThrow('original custodian lost');
  f.port.fence(Error('actual uncertain'));
  await expect(work).rejects.toThrow('uncertain');
  await expect(f.port.nextSource()).rejects.toThrow();
});
it('refuses asynchronous or nonvoid readiness and active current proofs before disconnecting the actual child', async () => {
  const port = createOriginalAppChildUpdateControl({
    nativeSourceRoot: native,
    assertOriginalCustodianCurrent() {},
  });
  const child = {
    pid: process.pid + 1,
    exitCode: null,
    signalCode: null,
    connected: true,
    disconnect: vi.fn(),
  };
  const identity = {
    instanceId: 'actual',
    custodianPid: process.pid,
    controllerPid: child.pid,
    epoch: 1,
  };
  port.created(child, native);
  expect(() => port.ready(identity, async () => {})).toThrow('synchronous');
  expect(() => port.ready(identity, () => true)).toThrow('synchronous');
  let asynchronous = false;
  port.ready(identity, () => (asynchronous ? Promise.resolve() : undefined));
  asynchronous = true;
  const selected = createOriginalAppChildSelection({
    sourceCommit: 'b'.repeat(40),
    sourceRoot: app,
    assertCurrent: async () => {},
  });
  await expect(port.replace(selected)).rejects.toThrow('synchronous');
  expect(child.disconnect).not.toHaveBeenCalled();
});
