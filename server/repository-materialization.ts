import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { RuntimeMigration } from './openshell-runtime-migration.js';
import { isGitBranchName } from './git-branch.js';
import {
  canonicalRepositorySelection,
  REPOSITORY_SOURCE_LIMIT_MIB,
} from './github-repository-source.js';

const exec = promisify(execFile);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
export const RepositoryMaterializationSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  repository: z.string().refine((v) => canonicalRepositorySelection(v) === v),
  baseBranch: z.string().refine(isGitBranchName),
  featureBranch: z.string().refine(isGitBranchName),
  baseOid: oid,
  tree: oid,
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RepositoryMaterialization = z.infer<typeof RepositoryMaterializationSchema>;
export const RepositoryMaterializationReceiptSchema = RepositoryMaterializationSchema.extend({
  head: oid,
  directory: z.string().min(1).max(4096),
  sandboxName: z.string().min(1).max(128),
  sandboxId: z.string().min(1).max(256),
});
export type RepositoryMaterializationReceipt = z.infer<
  typeof RepositoryMaterializationReceiptSchema
>;

/** A committed migration is continuity evidence, never new admission authority. */
export function repositoryMaterializationMigrationMatches(
  previous: RepositoryMaterializationReceipt,
  next: RepositoryMaterializationReceipt,
  migration: RuntimeMigration | null | undefined,
  conversationId: string,
  accountId: string,
) {
  const source = migration?.source.runtime,
    target = migration?.candidate?.runtime;
  return (
    migration?.phase === 'committed' &&
    migration.identity.conversation === conversationId &&
    migration.identity.accountId === accountId &&
    migration.identity.sandboxId === previous.sandboxId &&
    source?.sandboxId === previous.sandboxId &&
    source.sandboxName === previous.sandboxName &&
    source.workdir === previous.directory &&
    target?.sandboxId === next.sandboxId &&
    target.sandboxName === next.sandboxName &&
    migration.candidateName === next.sandboxName &&
    target.workdir === next.directory &&
    previous.directory === next.directory &&
    JSON.stringify(RepositoryMaterializationSchema.strip().parse(previous)) ===
      JSON.stringify(RepositoryMaterializationSchema.strip().parse(next))
  );
}

/** Only immutable committed objects leave the admitted controller source. The
 * upload directory contains no checkout/config/ignored files and is outside Git. */
export async function prepareRepositoryMaterialization(input: {
  source: string;
  workspaceId: string;
  repository: string;
  baseBranch: string;
  baseOid: string;
  featureBranch: string;
  signal: AbortSignal;
}) {
  const selected = RepositoryMaterializationSchema.omit({ tree: true, bundleSha256: true }).parse({
    version: 1,
    workspaceId: input.workspaceId,
    repository: input.repository,
    baseBranch: input.baseBranch,
    baseOid: input.baseOid,
    featureBranch: input.featureBranch,
  });
  const seed = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-import-')));
  const cleanup = () => rm(seed, { recursive: true, force: true });
  const git = async (...args: string[]) =>
    (
      await exec(
        '/usr/bin/git',
        [
          '-C',
          input.source,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        {
          signal: input.signal,
          timeout: 30000,
          maxBuffer: 65536,
          env: {
            PATH: '/usr/bin:/bin',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
          },
        },
      )
    ).stdout.trim();
  try {
    if (
      (await git('symbolic-ref', 'HEAD')) !== `refs/heads/${selected.featureBranch}` ||
      (await git('rev-parse', 'HEAD')) !== selected.baseOid
    )
      throw Error('Prepared repository identity differs');
    const tree = oid.parse(await git('rev-parse', 'HEAD^{tree}'));
    const bundle = join(seed, 'repository.bundle');
    await git(
      'bundle',
      'create',
      bundle,
      `refs/heads/${selected.featureBranch}`,
      `refs/remotes/origin/${selected.baseBranch}`,
    );
    if ((await stat(bundle)).size > REPOSITORY_SOURCE_LIMIT_MIB * 1024 * 1024)
      throw Error('Repository transfer exceeds its source limit');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(bundle, { signal: input.signal }))
      digest.update(chunk);
    input.signal.throwIfAborted();
    return {
      seed,
      manifest: RepositoryMaterializationSchema.parse({
        ...selected,
        tree,
        bundleSha256: digest.digest('hex'),
      }),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    input.signal.throwIfAborted();
    throw error;
  }
}

/** Code-owned importer, also executed by the real-Git offline contract fixture.
 * Arguments are transported as argv, never interpolated shell or source code.
 * A partial rename is deliberately left for owned recovery, never overwritten. */
export const repositoryMaterializationScript = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const [upload, target, encoded, replace] = process.argv.slice(1), m = JSON.parse(encoded);
const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALTERNATE_OBJECT_DIRECTORIES: '' };
const git = (root, args) => cp.execFileSync('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const need = (v) => { if (!v) throw Error('Repository materialization differs'); };
const marker = (root) => path.join(root, '.git', 'mitzo-materialization.json');
const storage = (root) => {
  const dir = path.join(root, '.git');
  need(fs.lstatSync(dir).isDirectory() && fs.realpathSync(dir) === dir);
  for (const part of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts']) {
    try { fs.lstatSync(path.join(dir, part)); need(false); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  let entries = 0, bytes = 0;
  const walk = (at) => {
    for (const name of fs.readdirSync(at)) {
      const child = path.join(at, name), s = fs.lstatSync(child);
      need(++entries <= 100000 && !s.isSymbolicLink());
      if (s.isDirectory()) walk(child);
      else { need(s.isFile() && s.nlink === 1); bytes += s.size; need(bytes <= 512 * 1024 * 1024); }
    }
  };
  const info = path.join(dir, 'info');
  if (fs.existsSync(info)) { need(fs.lstatSync(info).isDirectory() && fs.realpathSync(info) === info); walk(info); }
  for (const part of ['objects', 'refs']) {
    const at = path.join(dir, part); need(fs.lstatSync(at).isDirectory() && fs.realpathSync(at) === at); walk(at);
  }
  for (const part of ['config', 'HEAD', 'mitzo-materialization.json', 'packed-refs', 'config.worktree', 'shallow']) {
    const at = path.join(dir, part);
    let s; try { s = fs.lstatSync(at); } catch (e) { if (e.code === 'ENOENT' && ['packed-refs', 'config.worktree', 'shallow'].includes(part)) continue; throw e; }
    need(s.isFile() && s.nlink === 1 && fs.realpathSync(at) === at);
  }
  // Parse bounded local bytes outside the repository; never follow includes.
  for (const part of ['config', 'config.worktree']) {
    const at = path.join(dir, part);
    if (!fs.existsSync(at)) continue;
    need(fs.statSync(at).size <= 65536);
    const settings = cp.execFileSync('/usr/bin/git', ['config', '--no-includes', '--file', '-', '--null', '--list'], { cwd: '/', env, input: fs.readFileSync(at), encoding: 'utf8', timeout: 5000, maxBuffer: 131072 });
    for (const setting of settings.split('\0').filter(Boolean)) {
      const separator = setting.indexOf('\n'), key = setting.slice(0, separator === -1 ? undefined : separator).toLowerCase(), value = separator === -1 ? undefined : setting.slice(separator + 1);
      need(!/^include(if)?\./.test(key));
      need(!key.startsWith('extensions.') || ['extensions.objectformat', 'extensions.worktreeconfig'].includes(key));
      need(key !== 'core.worktree' || value === root);
      need(key !== 'core.bare' || ['false', 'no', 'off', '0'].includes((value || '').toLowerCase()));
      need(key !== 'extensions.objectformat' || ['sha1', 'sha256'].includes(value));
    }
  }
  const shallow = path.join(dir, 'shallow');
  if (fs.existsSync(shallow)) {
    need(fs.statSync(shallow).size <= 65536);
    need(fs.readFileSync(shallow, 'utf8').split('\n').filter(Boolean).every((oid) => /^[a-f0-9]{40}$/.test(oid)));
  }
};
const verify = () => {
  need(fs.realpathSync(target) === target && fs.lstatSync(path.join(target, '.git')).isDirectory());
  need(fs.realpathSync(path.join(target, '.git')) === path.join(target, '.git'));
  storage(target);
  const saved = JSON.parse(fs.readFileSync(marker(target), 'utf8'));
  need(JSON.stringify(saved) === JSON.stringify(m));
  need(git(target, ['rev-parse', '--show-toplevel']) === target);
  need(git(target, ['rev-parse', '--absolute-git-dir']) === path.join(target, '.git'));
  need(git(target, ['symbolic-ref', 'HEAD']) === 'refs/heads/' + m.featureBranch);
  need(git(target, ['config', '--local', '--get', 'remote.origin.url']) === 'https://github.com/' + m.repository + '.git');
  git(target, ['merge-base', '--is-ancestor', m.baseOid, 'HEAD']);
  return { ...m, head: git(target, ['rev-parse', 'HEAD']), directory: target };
};
(async () => {
  need(path.isAbsolute(target) && path.resolve(target) === target);
  const parent = path.dirname(target); need(fs.realpathSync(parent) === parent);
  if (fs.existsSync(marker(target))) { console.log(JSON.stringify(verify())); return; }
  need(replace === 'true' || !fs.existsSync(target));
  if (replace === 'true' && !fs.existsSync(path.join(upload, 'repository.bundle'))) { console.log(JSON.stringify({ needsUpload: true })); return; }
  need(fs.realpathSync(upload) === upload);
  const bundle = path.join(upload, 'repository.bundle');
  need(fs.lstatSync(bundle).isFile() && fs.realpathSync(bundle) === bundle && fs.statSync(bundle).size <= 512 * 1024 * 1024);
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(bundle)) digest.update(chunk);
  need(digest.digest('hex') === m.bundleSha256);
  const stage = target + '.materializing-' + m.workspaceId, previous = target + '.before-' + m.workspaceId;
  need(!fs.existsSync(stage) && !fs.existsSync(previous));
  fs.mkdirSync(stage, { mode: 0o700 });
  git(stage, ['init', '--quiet', '--template=', '--initial-branch=' + m.featureBranch]);
  git(stage, ['bundle', 'verify', bundle]);
  git(stage, ['fetch', '--quiet', '--update-head-ok', '--no-tags', bundle, 'refs/heads/' + m.featureBranch + ':refs/heads/' + m.featureBranch, 'refs/remotes/origin/' + m.baseBranch + ':refs/remotes/origin/' + m.baseBranch]);
  need(git(stage, ['rev-parse', 'HEAD']) === m.baseOid && git(stage, ['rev-parse', 'HEAD^{tree}']) === m.tree);
  git(stage, ['config', 'remote.origin.url', 'https://github.com/' + m.repository + '.git']);
  git(stage, ['config', 'user.name', 'Mitzo Sandbox']);
  git(stage, ['config', 'user.email', 'sandbox@mitzo.invalid']);
  git(stage, ['read-tree', '--reset', '-u', 'HEAD']);
  fs.writeFileSync(marker(stage), JSON.stringify(m), { flag: 'wx', mode: 0o600 });
  if (fs.existsSync(target)) fs.renameSync(target, previous);
  fs.renameSync(stage, target);
  console.log(JSON.stringify(verify()));
})().catch(() => { console.error('Repository materialization failed; preserve its original allocation'); process.exitCode = 1; });
`;
