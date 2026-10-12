import { describe, expect, it } from 'vitest';
import { createOriginalVmStartLineageObserver } from './staging-vm-peer.mjs';

function fixture() {
  const rows = new Map();
  const row = (pid, ppid, executable, kernelBirth = `${pid}:1`) => ({
    pid,
    ppid,
    uid: 501,
    peerUid: 501,
    peerGid: 20,
    kernelBirth,
    executable,
  });
  rows.set(11, row(11, 1, '/node'));
  rows.set(12, row(12, 11, '/podman'));
  rows.set(13, row(13, 12, '/vfkit'));
  rows.set(14, row(14, 12, '/gvproxy'));
  let current = true;
  const observer = createOriginalVmStartLineageObserver({
    supervisor: { path: '/node', argv: '/node supervisor --plan /plan --guard /guard' },
    podman: { path: '/podman', argv: '/podman machine start fresh' },
    vfkit: { path: '/vfkit' },
    gvproxy: { path: '/gvproxy' },
    uid: 501,
    assertCurrent: () => {
      if (!current) throw Error('lost original owner');
    },
    observePeer: async () => rows.get(11),
    observeProcess: (pid) => {
      if (!rows.has(pid)) throw Error('missing');
      return rows.get(pid);
    },
    listProcesses: () =>
      [...rows.values()].map((r) => ({
        pid: r.pid,
        ppid: r.ppid,
        command:
          r.pid === 11
            ? '/node supervisor --plan /plan --guard /guard'
            : r.pid === 12
              ? '/podman machine start fresh'
              : r.executable + ' fixed',
      })),
  });
  return {
    observer,
    rows,
    lose: () => {
      current = false;
    },
  };
}

describe('original kernel VM start lineage', () => {
  it('independently captures live original ancestry before accepting a reported lineage', async () => {
    const f = fixture();
    await f.observer.captureSupervisor({});
    f.observer.captureStart();
    const captured = f.observer.finish({
      supervisor: { pid: 11 },
      podman: { pid: 12 },
      vfkit: { pid: 13 },
      gvproxy: { pid: 14 },
    });
    expect(captured.vfkit.kernelBirth).toBe('13:1');
    f.rows.delete(12);
    f.rows.set(13, { ...f.rows.get(13), ppid: 1 });
    f.rows.set(14, { ...f.rows.get(14), ppid: 1 });
    expect(f.observer.assertCurrent()).toEqual(captured);
  });
  it('continues polling captured helpers after their original Podman parent exits, without adopting an uncaptured orphan', async () => {
    const f = fixture();
    await f.observer.captureSupervisor({});
    f.observer.captureStart();
    f.rows.delete(12);
    f.rows.set(13, { ...f.rows.get(13), ppid: 1 });
    f.rows.set(14, { ...f.rows.get(14), ppid: 1 });
    expect(() => f.observer.captureStart()).not.toThrow();
    expect(() =>
      f.observer.finish({
        supervisor: { pid: 11 },
        podman: { pid: 12 },
        vfkit: { pid: 13 },
        gvproxy: { pid: 14 },
      }),
    ).not.toThrow();
    const g = fixture();
    g.rows.delete(14);
    await g.observer.captureSupervisor({});
    g.observer.captureStart();
    g.rows.delete(12);
    g.rows.set(14, { ...f.rows.get(14) });
    expect(() => g.observer.captureStart()).toThrow();
  });
  it('rejects JSON supervisor PID spoofing', async () => {
    const f = fixture();
    await f.observer.captureSupervisor({});
    f.observer.captureStart();
    expect(() =>
      f.observer.finish({
        supervisor: { pid: 22 },
        podman: { pid: 12 },
        vfkit: { pid: 13 },
        gvproxy: { pid: 14 },
      }),
    ).toThrow();
  });
  it('refuses helpers not observed as children of the original live Podman start', async () => {
    const f = fixture();
    f.rows.get(13).ppid = 1;
    await f.observer.captureSupervisor({});
    f.observer.captureStart();
    expect(() =>
      f.observer.finish({
        supervisor: { pid: 11 },
        podman: { pid: 12 },
        vfkit: { pid: 13 },
        gvproxy: { pid: 14 },
      }),
    ).toThrow();
  });
  it('rejects duplicate starts and microsecond PID reuse even when reported PS birth matches', async () => {
    const f = fixture();
    await f.observer.captureSupervisor({});
    f.observer.captureStart();
    f.observer.finish({
      supervisor: { pid: 11 },
      podman: { pid: 12 },
      vfkit: { pid: 13 },
      gvproxy: { pid: 14 },
    });
    f.rows.get(13).kernelBirth = '13:2';
    expect(() => f.observer.assertCurrent()).toThrow();
  });
  it('requires the original guard after peer observation and for every subsequent assertion', async () => {
    const f = fixture();
    await f.observer.captureSupervisor({});
    f.lose();
    expect(() => f.observer.captureStart()).toThrow('lost original owner');
  });
  it('cannot finish without an independently observed live Podman process', async () => {
    const f = fixture();
    await f.observer.captureSupervisor({});
    f.rows.delete(12);
    f.observer.captureStart();
    expect(() =>
      f.observer.finish({
        supervisor: { pid: 11 },
        podman: { pid: 12 },
        vfkit: { pid: 13 },
        gvproxy: { pid: 14 },
      }),
    ).toThrow();
  });
});
