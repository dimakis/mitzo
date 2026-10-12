import { createConnection } from 'node:net';
import { Agent, request } from 'node:http';
import { lstatSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';

const refuse = () => {
  throw Error('Original gvproxy socket or fresh guest API binding unavailable');
};
function facts(info, guestSocketPath) {
  const host = info?.host,
    version = info?.version;
  if (
    !/^5\.6\.[0-9]{1,4}$/.test(version?.APIVersion ?? '') ||
    host?.security?.rootless !== true ||
    !/^\/run\/user\/[1-9]\d{0,9}\/podman\/podman\.sock$/.test(guestSocketPath ?? '') ||
    host.remoteSocket?.path !== guestSocketPath ||
    !['aarch64', 'arm64'].includes(host.arch) ||
    typeof host.hostname !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(host.hostname)
  )
    refuse();
  const values = {
    arch: host.arch,
    hostname: host.hostname,
    distribution: host.distribution?.distribution,
    distributionVersion: host.distribution?.version,
    version: version?.Version,
    apiVersion: version?.APIVersion,
    gitCommit: version?.GitCommit,
    rootless: true,
    remoteSocket: guestSocketPath,
  };
  for (const value of Object.values(values))
    if (
      typeof value !== 'boolean' &&
      (typeof value !== 'string' ||
        !value.length ||
        value.length > 128 ||
        [...value].some((character) => character.charCodeAt(0) < 32))
    )
      refuse();
  return Object.freeze(values);
}
export function compareFreshVmGuestApiFacts(api, guest, { guestSocketPath } = {}) {
  const a = facts(api, guestSocketPath),
    b = facts(guest, guestSocketPath);
  if (JSON.stringify(a) !== JSON.stringify(b)) refuse();
  return a;
}

/** Called only by original source-owned physical effects. observeGuest must use
 * the plan's exact stock machine SSH command and key, observe boot UUID before
 * and after podman info, and recheck the original lifecycle guard. */
export async function inspectOriginalFreshVmGuestApi({
  socketPath,
  socketIdentity,
  peerInspector,
  originalLineage,
  assertCurrent,
  observeGuest,
}) {
  const lineage = originalLineage.assertCurrent();
  assertCurrent();
  const before = lstatSync(socketPath);
  if (
    !before.isSocket() ||
    before.uid !== process.getuid() ||
    (before.mode & 0o777) !== 0o600 ||
    before.nlink !== 1 ||
    before.dev !== socketIdentity.dev ||
    before.ino !== socketIdentity.ino
  )
    refuse();
  const socket = createConnection({ path: socketPath });
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  // Force the HTTP client to use the very connection whose kernel peer was
  // measured; opening a second path connection would leave a replacement race.
  let consumedSocket = false;
  agent.createConnection = () => {
    if (consumedSocket) refuse();
    consumedSocket = true;
    return socket;
  };
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Error('Fresh guest API connect timeout')), 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        done();
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const peer = await peerInspector.observePeer(socket);
    assertCurrent();
    originalLineage.assertCurrent();
    if (
      peer.pid !== lineage.gvproxy.pid ||
      peer.kernelBirth !== lineage.gvproxy.kernelBirth ||
      peer.executable !== lineage.gvproxy.executable
    )
      refuse();
    const guest = await observeGuest();
    assertCurrent();
    originalLineage.assertCurrent();
    if (
      !/^[a-f0-9-]{36}$/.test(guest?.guestBootUUID) ||
      guest.guestBootUUID !== socketIdentity.guestBootUUID
    )
      refuse();
    const guestFacts = facts(guest.info, socketIdentity.guestSocketPath);
    const api = await new Promise((done, reject) => {
      let timer;
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      const req = request(
        {
          method: 'GET',
          host: 'localhost',
          path: '/v' + guestFacts.apiVersion + '/libpod/info',
          agent,
          headers: { Host: 'localhost', Connection: 'close' },
        },
        (response) => {
          let bytes = 0,
            body = '';
          if (response.statusCode !== 200) {
            response.destroy();
            fail(Error('Fresh API info refused'));
            return;
          }
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 131072) {
              response.destroy();
              fail(Error('Fresh API info oversized'));
            } else body += chunk;
          });
          response.once('error', fail);
          response.once('aborted', () => fail(Error('Fresh API info incomplete')));
          response.once('end', () => {
            clearTimeout(timer);
            try {
              done(JSON.parse(body));
            } catch (e) {
              fail(e);
            }
          });
        },
      );
      timer = setTimeout(() => req.destroy(Error('Fresh API info timeout')), 10000);
      req.once('error', fail);
      req.end();
    });
    assertCurrent();
    originalLineage.assertCurrent();
    const afterGuest = await observeGuest();
    assertCurrent();
    originalLineage.assertCurrent();
    if (afterGuest.guestBootUUID !== guest.guestBootUUID) refuse();
    const stable = compareFreshVmGuestApiFacts(api, guest.info, {
      guestSocketPath: socketIdentity.guestSocketPath,
    });
    compareFreshVmGuestApiFacts(api, afterGuest.info, {
      guestSocketPath: socketIdentity.guestSocketPath,
    });
    const after = lstatSync(socketPath);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== before.uid ||
      after.mode !== before.mode
    )
      refuse();
    return Object.freeze({
      guestBootUUID: guest.guestBootUUID,
      gvproxyPid: peer.pid,
      gvproxyKernelBirth: peer.kernelBirth,
      socketDev: before.dev,
      socketIno: before.ino,
      guestFactsSha256: createHash('sha256')
        .update(Buffer.from(JSON.stringify(stable)))
        .digest('hex'),
    });
  } finally {
    agent.destroy();
    socket.destroy();
  }
}
