import process from 'node:process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync,
  realpathSync,
  lstatSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statfsSync,
} from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';
import { assertVisibleTrackedIndex } from './staging-files.mjs';
import { git, bytes } from './staging-cold-audit.mjs';
const refuse = () =>
  Error('Original bounded source acceptance unavailable or revoked; preserve operation evidence');
const sha = /^[a-f0-9]{40}$/;
export const SOURCE_HISTORY_SCRATCH_BYTES = 64 * 1024 ** 2;
const sourceLifetimeMs = 12 * 60 * 1000;
/** Count this private store, never the external read-only alternates. Refuse
 * links, unsupported types or an unexpected object/file population. */
export function measureSourceHistoryScratch(root) {
  let size = 0,
    allocated = 0,
    files = 0,
    directories = 0;
  const visit = (path) => {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw refuse();
    if (s.isDirectory()) {
      if (++directories > 64) throw refuse();
      size += s.size;
      allocated += s.blocks * 512;
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (s.isFile() && s.nlink === 1) {
      if (++files > 64) throw refuse();
      size += s.size;
      allocated += s.blocks * 512;
    } else throw refuse();
    if (Math.max(size, allocated) > SOURCE_HISTORY_SCRATCH_BYTES) throw refuse();
  };
  visit(root);
  return { size, allocated, files, directories };
}
/** Original process-local source acceptance only. A serialized witness cannot
 * replay an operation, grant authentication, native capacity or guard custody. */
export function createProcessLocalSourceAcceptanceWitness(effects) {
  for (const name of ['verifyFresh', 'readPinned', 'readMain', 'assertAcceptedAncestry', 'close'])
    if (typeof effects?.[name] !== 'function') throw refuse();
  const branded = new WeakSet();
  let used = false,
    closed = false,
    target,
    frozen,
    receipt,
    deadline;
  const now = effects.now ?? (() => performance.now());
  return Object.freeze({
    async admit(selected) {
      if (used || closed || !sha.test(selected)) throw refuse();
      used = true;
      deadline = now() + sourceLifetimeMs;
      const fresh = await effects.verifyFresh();
      const first = await effects.readPinned();
      if (
        fresh.sourceCommit !== selected ||
        first.sourceCommit !== selected ||
        digest(first.receipt) !== digest(fresh) ||
        (await effects.readMain()) !== selected
      )
        throw refuse();
      const after = await effects.readPinned();
      if (digest(first) !== digest(after) || (await effects.readMain()) !== selected)
        throw refuse();
      if (now() >= deadline) throw refuse();
      target = selected;
      frozen = digest(first);
      receipt = JSON.parse(JSON.stringify(fresh));
      const token = Object.freeze({});
      branded.add(token);
      return token;
    },
    async assertCurrent(token) {
      if (closed || !token || !branded.has(token) || now() >= deadline) throw refuse();
      const main = await effects.readMain();
      if (!sha.test(main)) throw refuse();
      if (main !== target) await effects.assertAcceptedAncestry(target, main);
      if (digest(await effects.readPinned()) !== frozen || now() >= deadline) throw refuse();
      const after = await effects.readMain();
      if (after !== main) {
        if (!sha.test(after)) throw refuse();
        await effects.assertAcceptedAncestry(target, after);
      }
      if (digest(await effects.readPinned()) !== frozen || closed || now() >= deadline)
        throw refuse();
      return JSON.parse(JSON.stringify(receipt));
    },
    close() {
      if (closed) return;
      closed = true;
      effects.close();
    },
  });
}
/** Public Git history is fetched only into a private bounded scratch object store.
 * The release Git directory, refs and source/index are never updated. Unknown or
 * nonancestor main refuses; an initial stale main never creates a witness. */
export function createStagingSourceAcceptanceWitness({ canonicalRoot, sourceRoot, verifyFresh }) {
  let scratch,
    scratchIdentity,
    fetches = 0;
  const provenMain = new Set();
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const repository = 'https://github.com/dimakis/mitzo.git';
  const readMain = () =>
    git(sourceRoot, 'ls-remote', repository, 'refs/heads/main').split(/\s+/)[0];
  const run = (argv) => {
    const p = spawnSync(
      '/usr/bin/git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...argv],
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 ** 2,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/private/tmp',
          LANG: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    if (p.error || p.signal || p.status !== 0) throw refuse();
    return p.stdout.trim();
  };
  const fetchBounded = (argv) =>
    new Promise((resolve, reject) => {
      // POSIX sh limits each file to at most 4 MiB (some shells use 512-byte
      // blocks and are stricter). Forced pack storage means at most pack/index/
      // temporary pairs per fetch; no loose-object expansion or maintenance.
      // Three fetches plus existing metadata reserve a conservative 64 MiB peak.
      if (++fetches > 3) {
        reject(refuse());
        return;
      }
      const assertScratch = () => {
        const measured = measureSourceHistoryScratch(scratch);
        // Keep 16 MiB of the 64 MiB reservation for concurrent bounded pack,
        // index, temporary index and small reference/metadata writes.
        if (Math.max(measured.size, measured.allocated) > 48 * 1024 ** 2) throw refuse();
      };
      assertScratch();
      const p = spawn(
        '/bin/sh',
        [
          '-c',
          'ulimit -f 4096 || exit 125; exec /usr/bin/git "$@"',
          'mitzo-source-history',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'fetch.unpackLimit=0',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          ...argv,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/private/tmp',
            LANG: 'C',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
      let output = 0,
        failed = false;
      const stop = () => {
        failed = true;
        p.kill('SIGKILL');
      };
      const poll = setInterval(() => {
        try {
          assertScratch();
        } catch {
          stop();
        }
      }, 10);
      const timer = setTimeout(stop, 30000);
      for (const stream of [p.stdout, p.stderr])
        stream.on('data', (chunk) => {
          output += chunk.length;
          if (output > 1024 ** 2) stop();
        });
      p.on('error', stop);
      p.on('close', (code, signal) => {
        clearInterval(poll);
        clearTimeout(timer);
        try {
          assertScratch();
          if (failed || signal || code !== 0) throw refuse();
          resolve();
        } catch {
          reject(refuse());
        }
      });
    });
  const readPinned = () => {
    const current = git(sourceRoot, 'rev-parse', 'HEAD'),
      status = git(sourceRoot, 'status', '--porcelain'),
      index = git(sourceRoot, 'ls-files', '-v');
    if (
      realpathSync(sourceRoot) !== sourceRoot ||
      sourceRoot !== join(canonicalRoot, 'releases', current.slice(0, 12)) ||
      (status !== '' && status !== '?? staging-release.json') ||
      git(sourceRoot, 'remote', 'get-url', 'origin') !== repository ||
      realpathSync(git(sourceRoot, 'rev-parse', '--show-toplevel')) !== sourceRoot
    )
      throw refuse();
    assertVisibleTrackedIndex(index);
    const receipt = verifyPreparedController(canonicalRoot, sourceRoot, current);
    const helperPath = join(sourceRoot, 'dist/staging-offline-operator-auth/helper'),
      helper = lstatSync(helperPath);
    return {
      receipt,
      receiptSha256: hash(bytes(join(sourceRoot, 'staging-release.json'))),
      sourceCommit: current,
      sourceTree: git(sourceRoot, 'rev-parse', 'HEAD^{tree}'),
      indexSha256: hash(index),
      helperIdentity: {
        dev: helper.dev,
        ino: helper.ino,
        uid: helper.uid,
        mode: helper.mode,
        nlink: helper.nlink,
        size: helper.size,
      },
      helperSha256: hash(bytes(helperPath)),
    };
  };
  return createProcessLocalSourceAcceptanceWitness({
    verifyFresh,
    readPinned,
    readMain,
    async assertAcceptedAncestry(target, main) {
      if (!sha.test(target) || !sha.test(main)) throw refuse();
      if (provenMain.has(main)) return;
      if (!scratch) {
        const free = statfsSync(tmpdir());
        if (free.bavail * free.bsize < 20 * 1024 ** 3 + SOURCE_HISTORY_SCRATCH_BYTES)
          throw refuse();
        scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-source-acceptance-')));
        const s = lstatSync(scratch);
        scratchIdentity = { dev: s.dev, ino: s.ino };
      }
      const store = join(scratch, 'history.git');
      if (!lstatSync(store, { throwIfNoEntry: false })) {
        run(['init', '--bare', store]);
        const common = realpathSync(
          git(sourceRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        );
        mkdirSync(join(store, 'objects/info'), { recursive: true, mode: 0o700 });
        writeFileSync(join(store, 'objects/info/alternates'), join(common, 'objects') + '\n', {
          mode: 0o600,
          flag: 'wx',
        });
      }
      // Commit objects only; no trees/blobs, model calls, provider configuration or
      // staging/runtime control. A bounded graph that cannot establish ancestry
      // remains unsupported rather than silently accepting a new history.
      let selected = main;
      for (let attempt = 0; attempt < 3; attempt++) {
        await fetchBounded([
          '--git-dir',
          store,
          'fetch',
          '--filter=tree:0',
          '--depth=256',
          '--no-tags',
          repository,
          selected,
        ]);
        const fetched = run(['--git-dir', store, 'rev-parse', 'FETCH_HEAD']);
        if (fetched !== selected) throw refuse();
        run(['--git-dir', store, 'merge-base', '--is-ancestor', target, selected]);
        provenMain.add(selected);
        const current = readMain();
        if (current === selected) return;
        if (!sha.test(current)) throw refuse();
        selected = current;
      }
      throw refuse();
    },
    close() {
      if (scratch) {
        const s = lstatSync(scratch);
        if (
          s.isDirectory() &&
          s.uid === process.getuid() &&
          (s.mode & 0o777) === 0o700 &&
          s.dev === scratchIdentity.dev &&
          s.ino === scratchIdentity.ino &&
          realpathSync(scratch) === scratch
        )
          rmSync(scratch, { recursive: true });
        scratch = undefined;
      }
    },
  });
}
