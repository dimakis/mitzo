import { describe, expect, it } from 'vitest';
import {
  compareFreshVmGuestApiFacts,
  inspectOriginalFreshVmGuestApi,
} from './staging-vm-guest-api.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const info = () => ({
  host: {
    arch: 'arm64',
    hostname: 'fresh-vm',
    distribution: { distribution: 'fedora', version: '42' },
    security: { rootless: true },
    remoteSocket: { path: '/run/user/501/podman/podman.sock' },
  },
  version: { Version: '5.6.2', APIVersion: '5.6.2', GitCommit: 'a'.repeat(40) },
});
describe('rootless API is bound to independently authenticated fresh guest facts', () => {
  it.each([true, false])(
    'uses the same measured socket, foreign peer=%s prevents API dispatch',
    async (foreign) => {
      const root = mkdtempSync(join(tmpdir(), 'mitzo-guest-unit-'));
      const path = join(root, 'api.sock');
      let connections = 0,
        requests = 0;
      const server = createServer((request, response) => {
        requests++;
        expect(request.url).toBe('/libpod/info');
        response.end(JSON.stringify(info()));
      });
      server.on('connection', () => connections++);
      try {
        await new Promise((done, reject) => {
          server.once('error', reject);
          server.listen(path, done);
        });
        chmodSync(path, 0o600);
        const { dev, ino } = lstatSync(path),
          guestBootUUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const gvproxy = { pid: 123, kernelBirth: '123:1', executable: '/original-gvproxy' };
        const operation = inspectOriginalFreshVmGuestApi({
          socketPath: path,
          socketIdentity: {
            dev,
            ino,
            guestBootUUID,
            guestSocketPath: '/run/user/501/podman/podman.sock',
          },
          originalLineage: { assertCurrent: () => ({ gvproxy }) },
          assertCurrent: () => {},
          peerInspector: { observePeer: async () => ({ ...gvproxy, pid: foreign ? 124 : 123 }) },
          observeGuest: async () => ({ guestBootUUID, info: info() }),
        });
        if (foreign) await expect(operation).rejects.toThrow();
        else expect((await operation).guestBootUUID).toBe(guestBootUUID);
        expect(connections).toBe(1);
        expect(requests).toBe(foreign ? 0 : 1);
      } finally {
        await new Promise((done) => server.close(done));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('compares stable API identity while ignoring volatile uptime', () => {
    const api = info(),
      guest = info();
    api.host.uptime = '2s';
    guest.host.uptime = '3s';
    expect(
      compareFreshVmGuestApiFacts(api, guest, {
        guestSocketPath: '/run/user/501/podman/podman.sock',
      }).hostname,
    ).toBe('fresh-vm');
  });
  it.each(['hostname', 'arch'])('rejects wrong guest %s', (key) => {
    const api = info();
    api.host[key] = 'foreign';
    expect(() =>
      compareFreshVmGuestApiFacts(api, info(), {
        guestSocketPath: '/run/user/501/podman/podman.sock',
      }),
    ).toThrow();
  });
  it('refuses rootful forwarding or unknown guest data', () => {
    const api = info();
    api.host.security.rootless = false;
    expect(() =>
      compareFreshVmGuestApiFacts(api, info(), {
        guestSocketPath: '/run/user/501/podman/podman.sock',
      }),
    ).toThrow();
    expect(() =>
      compareFreshVmGuestApiFacts({}, {}, { guestSocketPath: '/run/user/501/podman/podman.sock' }),
    ).toThrow();
  });
  it('rejects a foreign provider socket path even when both JSON observations agree', () => {
    const api = info();
    api.host.remoteSocket.path = '/run/podman/podman.sock';
    expect(() =>
      compareFreshVmGuestApiFacts(api, api, {
        guestSocketPath: '/run/user/501/podman/podman.sock',
      }),
    ).toThrow();
  });
});
