import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { spawn } from 'node:child_process';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const fail = () => Error('Fresh staging operator authentication failed; no authority issued');
const sha = /^[a-f0-9]{64}$/;
function inspect(path, expectedSha256) {
  if (!isAbsolute(path) || realpathSync(path) !== path || !sha.test(expectedSha256)) throw fail();
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077) throw fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      !(stat.mode & 0o100) ||
      stat.size > 16 * 1024 ** 2 ||
      stat.size < 1
    )
      throw fail();
    const digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
    if (digest !== expectedSha256) throw fail();
    return JSON.stringify({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mode: stat.mode,
      uid: stat.uid,
      digest,
    });
  } finally {
    closeSync(fd);
  }
}

/** The prepared controller supplies an independently reviewed compiled helper pin.
 * This closure, the actual spawned child and a WeakSet own authority. JSON receipts,
 * copied tokens and caller-supplied evidence cannot mint or transfer the brand.
 * No capacity, native custody, containment action or provider permission is granted. */
export function createStagingOfflineOperatorAuthorizer({ helperPath, expectedSha256 }) {
  const enrolledIdentity = inspect(helperPath, expectedSha256);
  const authorities = new WeakSet();
  const deadlines = new WeakMap();
  let pending = false;
  const verifyHelper = () => {
    if (inspect(helperPath, expectedSha256) !== enrolledIdentity) throw fail();
  };
  return Object.freeze({
    authenticate(planSha256) {
      if (
        typeof planSha256 !== 'string' ||
        !sha.test(planSha256) ||
        pending ||
        process.getuid() === 0
      )
        throw fail();
      verifyHelper();
      const uid = process.getuid(),
        parentPid = process.pid,
        nonce = randomUUID();
      pending = true;
      return new Promise((resolve, reject) => {
        let child,
          timer,
          settled = false,
          exited = false,
          output = Buffer.alloc(0),
          stderrBytes = 0;
        const finish = (authority) => {
          if (settled) return;
          settled = true;
          pending = false;
          globalThis.clearTimeout(timer);
          child?.stdout?.removeListener('data', onOutput);
          child?.stderr?.removeListener('data', onErrorOutput);
          child?.removeListener('error', onError);
          child?.removeListener('exit', onExit);
          child?.removeListener('close', onClose);
          if (authority) {
            authorities.add(authority);
            deadlines.set(authority, performance.now() + 600000);
            resolve(authority);
          } else reject(fail());
        };
        const abort = () => {
          try {
            child?.kill('SIGTERM');
          } catch {
            /* Only this original fresh helper handle. */
          }
          finish();
        };
        const onOutput = (chunk) => {
          const bytes = Buffer.from(chunk);
          if (output.length + bytes.length > 1024) return abort();
          output = Buffer.concat([output, bytes]);
        };
        const onErrorOutput = (chunk) => {
          stderrBytes += Buffer.byteLength(chunk);
          // The reviewed helper emits no error body or secrets, only an unsuccessful exit.
          if (stderrBytes) abort();
        };
        const onError = () => abort();
        const onExit = (code, signal) => {
          exited = code === 0 && signal === null;
          if (!exited) finish();
        };
        const onClose = (code, signal) => {
          if (!exited || code !== 0 || signal !== null) return finish();
          try {
            verifyHelper();
            const response = JSON.parse(output.toString('utf8'));
            if (
              !response ||
              Object.keys(response).sort().join() !==
                ['version', 'result', 'planSha256', 'nonce', 'uid', 'parentPid', 'helperPid']
                  .sort()
                  .join() ||
              response.version !== 1 ||
              response.result !== 'authenticated' ||
              response.planSha256 !== planSha256 ||
              response.nonce !== nonce ||
              response.uid !== uid ||
              response.parentPid !== parentPid ||
              response.helperPid !== child.pid
            )
              return finish();
            finish(Object.freeze({ planSha256, expiresAt: Date.now() + 600000 }));
          } catch {
            finish();
          }
        };
        try {
          child = spawn(
            helperPath,
            ['authenticate', '--plan-sha256', planSha256, '--nonce', nonce, '--uid', String(uid)],
            {
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { PATH: '/usr/bin:/bin', LANG: 'C' },
            },
          );
          if (!Number.isSafeInteger(child.pid) || child.pid < 2 || !child.stdout || !child.stderr)
            return abort();
          child.stdout.on('data', onOutput);
          child.stderr.on('data', onErrorOutput);
          child.on('error', onError);
          child.on('exit', onExit);
          child.on('close', onClose);
          timer = globalThis.setTimeout(abort, 120000);
        } catch {
          finish();
        }
      });
    },
    consume(authority, planSha256) {
      if (
        !authority ||
        !authorities.has(authority) ||
        authority.planSha256 !== planSha256 ||
        Date.now() >= authority.expiresAt ||
        performance.now() >= deadlines.get(authority)
      )
        throw fail();
      verifyHelper();
      const deadline = deadlines.get(authority);
      authorities.delete(authority);
      deadlines.delete(authority);
      let closed = false;
      return Object.freeze({
        assertCurrent(requestedPlanSha256) {
          if (
            closed ||
            requestedPlanSha256 !== planSha256 ||
            Date.now() >= authority.expiresAt ||
            performance.now() >= deadline
          )
            throw fail();
          verifyHelper();
          return true;
        },
        close() {
          closed = true;
        },
      });
    },
  });
}
