import { describe, expect, it } from 'vitest';
import { collectStore, removeImage, measureFilesystem } from '../lib/podman-storage-host.mjs';

const image = `sha256:${'a'.repeat(64)}`;
function fake(platform = 'darwin') {
  const calls: [string, string[]][] = [];
  const run = async (exe: string, args: string[]) => {
    calls.push([exe, args]);
    if (args.includes('info'))
      return JSON.stringify({
        host: {
          serviceIsRemote: platform === 'darwin',
          security: { rootless: true },
          remoteSocket: { path: 'unix:///run/podman.sock' },
        },
        store: { graphRoot: '/guest/store', graphDriverName: 'overlay' },
      });
    if (args.includes('connection'))
      return JSON.stringify([
        {
          Name: 'selected',
          URI: 'ssh://core@127.0.0.1:1000/run/podman.sock',
          Identity: '/key',
          IsMachine: true,
        },
      ]);
    if (args.includes('machine') && args.includes('inspect'))
      return JSON.stringify([
        {
          Name: 'vm',
          Created: 'created',
          SSHConfig: { Port: 1000, IdentityPath: '/key', RemoteUsername: 'core' },
          ConfigDir: { Path: '/vm/config' },
        },
      ]);
    if (exe === 'cat' || args.includes('cat')) return 'guest-machine-id\n';
    if (exe === 'stat' || args.includes('stat')) return 'fs-id\n';
    if (exe === 'findmnt' || args.includes('findmnt')) return '/dev/vda4\n';
    if (exe === 'df' || args.includes('df'))
      return args.includes('-i')
        ? 'Filesystem Inodes IUsed IFree IUse% Mounted\n/dev/vda4 1000 100 900 10% /guest\n'
        : 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vda4 1000 900 100 90% /guest\n';
    if (args.includes('ps')) return JSON.stringify([{ Id: 'c', ImageID: image }]);
    if (args.includes('images')) return JSON.stringify([{ Id: image }]);
    if (args.includes('inspect'))
      return JSON.stringify([{ Id: image, Parent: '', RootFS: { Layers: ['sha256:layer'] } }]);
    return '';
  };
  return { calls, run, platform };
}
const selection = { connection: 'selected', machine: 'vm', hostBackingPath: '/vm/disk.raw' };

describe('selected store guest telemetry', () => {
  it('measures bytes and inodes at discovered guest graph root and host backing separately', async () => {
    const f = fake();
    const s = await collectStore(selection, { ...f, enrollment: null });
    expect(s.complete).toBe(true);
    expect(s.telemetry.guest.freeBytes).toBe(102400);
    expect(s.telemetry.guest.freeInodes).toBe(900);
    expect(s.store.graphRoot).toBe('/guest/store');
    expect(s.store.machineId).toBe('guest-machine-id');
    expect(f.calls).toContainEqual([
      'podman',
      ['machine', 'ssh', 'vm', 'df', '-k', '-P', '--', '/guest/store'],
    ]);
    expect(f.calls).toContainEqual(['df', ['-k', '-P', '--', '/vm/disk.raw']]);
    expect(s.containers[0].image).toBe(image);
  });
  it('uses the local Linux store explicitly and never a default remote connection', async () => {
    const f = fake('linux');
    const s = await collectStore({ local: true }, { ...f, enrollment: null });
    expect(s.complete).toBe(true);
    expect(f.calls).toContainEqual(['df', ['-k', '-P', '--', '/guest/store']]);
    expect(f.calls.some(([, args]) => args.includes('machine'))).toBe(false);
    expect(
      f.calls.filter(([exe]) => exe === 'podman').every(([, args]) => args[0] === '--remote=false'),
    ).toBe(true);
  });
  it('reports missing host measurements without substituting host root for guest', async () => {
    const f = fake();
    const s = await collectStore(
      { connection: 'selected', machine: 'vm' },
      { ...f, enrollment: null },
    );
    expect(s.telemetry.host.status).toBe('unavailable');
    expect(s.telemetry.guest.status).toBe('available');
    expect(s.complete).toBe(true);
    expect(f.calls.some(([exe, args]) => exe === 'df' && args.includes('/'))).toBe(false);
  });
  it.each([
    'connection mismatch',
    'guest unavailable',
    'image inspect missing',
    'external build',
    'incomplete container',
  ])('fails closed on %s', async (fault) => {
    const f = fake();
    const original = f.run;
    f.run = async (exe, args) => {
      if (fault === 'connection mismatch' && args.includes('connection'))
        return JSON.stringify([
          { Name: 'selected', URI: 'ssh://root@127.0.0.1:2000/run/podman.sock', IsMachine: true },
        ]);
      if (fault === 'guest unavailable' && args.includes('df')) throw Error('guest unreachable');
      if (fault === 'image inspect missing' && args.includes('inspect') && args.includes('image'))
        return '[]';
      if (fault === 'external build' && args.includes('ps'))
        return JSON.stringify([{ Id: 'external', ImageID: '' }]);
      if (fault === 'incomplete container' && args.includes('ps')) return JSON.stringify([{}]);
      return original(exe, args);
    };
    const s = await collectStore(selection, { ...f, enrollment: null });
    expect(s.complete).toBe(false);
    expect(s.blockers.length).toBeGreaterThan(0);
  });
  it('accepts only exact immutable IDs and passes no-prune without force', async () => {
    const f = fake();
    await removeImage(selection, image, f.run);
    expect(f.calls).toEqual([
      ['podman', ['--connection', 'selected', 'image', 'rm', '--no-prune', image]],
    ]);
    await expect(removeImage(selection, 'runtime:latest', f.run)).rejects.toThrow();
  });
  it('rejects invalid filesystem statistics', async () => {
    await expect(measureFilesystem('/store', async () => 'bad df')).rejects.toThrow();
  });
  it('refuses guest paths that would be interpreted by machine SSH shell joining', async () => {
    const f = fake();
    const original = f.run;
    f.run = async (exe, args) => {
      const text = await original(exe, args);
      if (args.includes('info')) {
        const v = JSON.parse(text);
        v.store.graphRoot = '/store;touch /tmp/unplanned';
        return JSON.stringify(v);
      }
      return text;
    };
    const s = await collectStore(selection, { ...f, enrollment: null });
    expect(s.complete).toBe(false);
    expect(f.calls.some(([, args]) => args.some((arg) => arg.includes('touch')))).toBe(false);
  });
});
