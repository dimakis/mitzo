import { SourceImportError } from './symposium-source-errors.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export const SOURCE_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export type SourceSelection = {
  repositoryId: string;
  targetRepository: string;
  baseBranch: string;
  featureBranch: string;
};
export type LocalSourcePlan = SourceSelection & {
  baseOid: string;
  treeOid: string;
  sourceIdentity: string;
  historyCommits: number;
};
export type SourceManifest = LocalSourcePlan & { bundleSha256: string; bundleBytes: number };
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const safeBranch = (s: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(s) &&
  !s.includes('..') &&
  !s.includes('//') &&
  !s.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'));
function plain(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new SourceImportError('Unsupported source filesystem');
  return stat;
}
function source(repositories: Record<string, string>, selection: SourceSelection) {
  if (
    !Object.hasOwn(repositories, selection.repositoryId) ||
    !safeBranch(selection.baseBranch) ||
    !safeBranch(selection.featureBranch) ||
    selection.baseBranch === selection.featureBranch ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selection.targetRepository)
  )
    throw new SourceImportError('Invalid selected source');
  const root = realpathSync(repositories[selection.repositoryId]);
  const gitdir = join(root, '.git');
  plain(gitdir, true);
  const objects = join(gitdir, 'objects');
  const identity = plain(objects, true);
  for (const name of [
    'shallow',
    'commondir',
    'gitdir',
    'objects/info/alternates',
    'objects/info/http-alternates',
  ]) {
    try {
      lstatSync(join(gitdir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    throw new SourceImportError('External or incomplete source objects are unsupported');
  }
  let entries = 0;
  function walk(path: string) {
    for (const name of readdirSync(path)) {
      if (++entries > 100000 || name.endsWith('.promisor'))
        throw new SourceImportError('Source object bound or partial clone');
      const p = join(path, name);
      const stat = lstatSync(p);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new SourceImportError('Unsupported source object');
      if (stat.isDirectory()) walk(p);
    }
  }
  walk(objects);
  const config = join(gitdir, 'config');
  plain(config, false);
  const configBytes = readFileSync(config);
  if (configBytes.length > 65536) throw new SourceImportError('Source configuration bound');
  return {
    root,
    gitdir,
    objects,
    config,
    identity: hash(JSON.stringify([root, identity.dev, identity.ino, hash(configBytes)])),
  };
}
function git(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  maxBuffer = SOURCE_BUNDLE_MAX_BYTES,
  input?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/git',
      args,
      {
        timeout: 20000,
        maxBuffer,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_OPTIONAL_LOCKS: '0',
          ...environment,
        },
        encoding: 'buffer',
      },
      (error, stdout) =>
        error ? reject(new SourceImportError('Selected source Git read failed')) : resolve(stdout),
    );
    child.stdin?.end(input);
  });
}
function readRef(gitdir: string, ref: string) {
  const parts = ref.split('/');
  let path = gitdir;
  try {
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      plain(path, i < parts.length - 1);
    }
    const value = readFileSync(path, 'utf8').trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
    throw new SourceImportError('Unsupported selected source ref');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const packed = join(gitdir, 'packed-refs');
  plain(packed, false);
  const text = readFileSync(packed, 'utf8');
  if (text.length > 1048576) throw new SourceImportError('Source ref bound');
  const matches = text.split('\n').filter((row) => row.endsWith(' ' + ref));
  if (matches.length !== 1 || !/^[a-f0-9]{40} /.test(matches[0]))
    throw new SourceImportError('Selected base is unavailable');
  return matches[0].slice(0, 40);
}
async function withSource<T>(
  repositories: Record<string, string>,
  selection: SourceSelection,
  run: (context: { plan: LocalSourcePlan; args: string[]; env: NodeJS.ProcessEnv }) => Promise<T>,
) {
  const selected = source(repositories, selection);
  for (const branch of [selection.baseBranch, selection.featureBranch]) {
    try {
      await git(['check-ref-format', '--branch', branch], {}, 4096);
    } catch {
      throw new SourceImportError('Selected branch is not a valid Git branch');
    }
  }
  const origin = (
    await git(
      ['config', '--file', selected.config, '--no-includes', '--get', 'remote.origin.url'],
      {},
      4096,
    )
  )
    .toString()
    .trim();
  const target = selection.targetRepository.replace(/\.git$/, '');
  if (
    ![
      `https://github.com/${target}`,
      `https://github.com/${target}.git`,
      `git@github.com:${target}`,
      `git@github.com:${target}.git`,
    ].includes(origin)
  )
    throw new SourceImportError('Selected target differs from canonical source origin');
  const defaultRef = join(selected.gitdir, 'refs/remotes/origin/HEAD');
  plain(defaultRef, false);
  if (
    readFileSync(defaultRef, 'utf8').trim() !== `ref: refs/remotes/origin/${selection.baseBranch}`
  )
    throw new SourceImportError('Only the locally recorded default base is supported');
  const baseOid = readRef(selected.gitdir, `refs/remotes/origin/${selection.baseBranch}`);
  const temp = mkdtempSync(join(tmpdir(), 'mitzo-source-export-'));
  try {
    await git(['init', '--bare', '--quiet', '--template=', '--object-format=sha1', temp]);
    const args = [
      '--git-dir=' + temp,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'pack.threads=1',
      '-c',
      'pack.windowMemory=16m',
    ];
    const env = { GIT_OBJECT_DIRECTORY: selected.objects };
    const treeOid = (await git([...args, 'rev-parse', baseOid + '^{tree}'], env, 4096))
      .toString()
      .trim();
    const historyCommits = Number(
      (await git([...args, 'rev-list', '--count', baseOid], env, 4096)).toString(),
    );
    if (
      !/^[a-f0-9]{40}$/.test(treeOid) ||
      !Number.isSafeInteger(historyCommits) ||
      historyCommits < 1 ||
      historyCommits > 10000
    )
      throw new SourceImportError('Source history bound');
    const plan = {
      ...selection,
      targetRepository: target,
      baseOid,
      treeOid,
      sourceIdentity: selected.identity,
      historyCommits,
    };
    const result = await run({ plan, args, env });
    if (
      source(repositories, selection).identity !== selected.identity ||
      readRef(selected.gitdir, `refs/remotes/origin/${selection.baseBranch}`) !== baseOid
    )
      throw new SourceImportError('Source changed during export');
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export function inspectLocalSource(
  repositories: Record<string, string>,
  selection: SourceSelection,
): Promise<LocalSourcePlan> {
  return withSource(repositories, selection, async ({ plan }) => plan);
}
export function exportLocalSource(repositories: Record<string, string>, expected: LocalSourcePlan) {
  return withSource(repositories, expected, async ({ plan, args, env }) => {
    if (JSON.stringify(plan) !== JSON.stringify(expected))
      throw new SourceImportError('Selected source preview changed');
    const objectIds = (
      await git(
        [...args, 'rev-list', '--objects', '--no-object-names', plan.baseOid],
        env,
        8 * 1024 * 1024,
      )
    )
      .toString()
      .trim()
      .split('\n');
    if (objectIds.length > 100000 || objectIds.some((oid) => !/^[a-f0-9]{40}$/.test(oid)))
      throw new SourceImportError('Source object count bound');
    const input = objectIds.join('\n') + '\n';
    const sizes = (await git([...args, 'cat-file', '--batch-check'], env, 8 * 1024 * 1024, input))
      .toString()
      .trim()
      .split('\n');
    let expanded = 0;
    for (const row of sizes) {
      const match = row.match(/^[a-f0-9]{40} (blob|tree|commit) ([0-9]+)$/);
      if (!match || (expanded += Number(match[2])) > 64 * 1024 * 1024)
        throw new SourceImportError('Source expanded history bound (64 MiB)');
    }
    const data = await git([...args, 'cat-file', '--batch'], env, 80 * 1024 * 1024, input);
    let offset = 0;
    for (const oid of objectIds) {
      const end = data.indexOf(10, offset);
      const header = data.subarray(offset, end).toString().split(' ');
      const bytes = Number(header[2]);
      if (
        header[0] !== oid ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        end + 1 + bytes >= data.length
      )
        throw new SourceImportError('Source object framing');
      const object = data.subarray(end + 1, end + 1 + bytes);
      offset = end + bytes + 2;
      if (header[1] === 'blob' || header[1] === 'commit') {
        const text = object.toString('latin1');
        if (
          /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}|"type"\s*:\s*"service_account"/.test(
            text,
          )
        )
          throw new SourceImportError('Credential-bearing committed history is not importable');
      } else if (header[1] === 'tree') {
        let cursor = 0;
        while (cursor < object.length) {
          const space = object.indexOf(32, cursor),
            nul = object.indexOf(0, space);
          if (space < cursor || nul < space || nul + 21 > object.length)
            throw new SourceImportError('Source tree framing');
          const mode = object.subarray(cursor, space).toString(),
            name = object.subarray(space + 1, nul).toString('utf8');
          if (
            !['40000', '100644', '100755'].includes(mode) ||
            name.includes('\uFFFD') ||
            /[\\/]/.test(name) ||
            [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
            ['.', '..', '.git'].includes(name.toLowerCase())
          )
            throw new SourceImportError('Unsupported historical source path');
          if (
            (/^(?:\.env(?:\..+)?|\.ssh|\.aws|\.docker|\.kube|\.gitconfig|\.netrc|\.npmrc|\.pypirc|application_default_credentials\.json|auth\.json|credentials(?:\.[^.]+)?|id_rsa|id_ed25519)$/i.test(
              name,
            ) &&
              !/\.(example|sample|template)$/i.test(name)) ||
            /\.(pem|key|p12|pfx)$/i.test(name)
          )
            throw new SourceImportError('Credential-bearing committed path is not importable');
          cursor = nul + 21;
        }
      }
    }
    if (offset !== data.length) throw new SourceImportError('Source object framing');
    await git([...args, 'update-ref', 'refs/heads/import', plan.baseOid], env);
    const bundle = await git([...args, 'bundle', 'create', '-', 'refs/heads/import'], env);
    if (!bundle.length || bundle.length > SOURCE_BUNDLE_MAX_BYTES)
      throw new SourceImportError('Source bundle bound (8 MiB)');
    return {
      bundle,
      manifest: { ...plan, bundleSha256: hash(bundle), bundleBytes: bundle.length },
    };
  });
}
// Executed only in a pinned credential-free helper. Existing pristine metadata is
// validated and retained; neither reset/clean nor copying a host .git is permitted.
export const SOURCE_GIT_IMPORTER = String.raw`
import os, sys, stat, json, hashlib, subprocess, configparser, re, signal
def deadline(signum, frame): raise TimeoutError('source import wallclock')
signal.signal(signal.SIGALRM, deadline); signal.alarm(40)
root,bundle=sys.argv[1:3]; manifest=json.loads(sys.argv[3]); gitdir=root+'/.git'
if bundle=='-':
 data=sys.stdin.buffer.read(8388609)
 if len(data)>8388608: raise ValueError('bundle bound')
 bundle='/tmp/source.bundle'
 with open(bundle,'xb') as output: output.write(data)
def regular(path, directory=False):
 s=os.lstat(path)
 if not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)): raise ValueError('source filesystem')
regular(root,True);regular(gitdir,True);regular(bundle)
if sorted(os.listdir(root))!=['.git']: raise ValueError('artifact is not pristine')
allowed_dirs={'objects','objects/info','objects/pack','refs','refs/heads','refs/tags'}
for base,dirs,files in os.walk(gitdir,followlinks=False):
 for name in dirs:
  p=os.path.join(base,name);regular(p,True)
  if os.path.relpath(p,gitdir) not in allowed_dirs: raise ValueError('unexpected Git directory')
 for name in files:
  p=os.path.join(base,name);regular(p)
  if os.path.relpath(p,gitdir) not in {'HEAD','config'}: raise ValueError('unexpected Git metadata')
if open(gitdir+'/HEAD').read()!='ref: refs/heads/main\n': raise ValueError('initial HEAD')
cfg=configparser.ConfigParser();cfg.read(gitdir+'/config')
if cfg.sections()!=['core'] or dict(cfg['core']).get('repositoryformatversion')!='0': raise ValueError('initial config')
allowed={'repositoryformatversion':'0','filemode':'true','bare':'false','logallrefupdates':'true','ignorecase':'true','precomposeunicode':'true'}
if any(allowed.get(k)!=v for k,v in cfg['core'].items()): raise ValueError('unexpected Git config')
size=os.stat(bundle).st_size
if size!=manifest['bundleBytes'] or not 0<size<=8388608: raise ValueError('bundle size')
if hashlib.sha256(open(bundle,'rb').read(8388609)).hexdigest()!=manifest['bundleSha256']: raise ValueError('bundle digest')
for key in ['baseOid','treeOid']:
 if not re.fullmatch('[a-f0-9]{40}',manifest[key]): raise ValueError('object identity')
for key in ['baseBranch','featureBranch']:
 value=manifest[key]
 if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._/-]{0,200}',value) or '..' in value or '//' in value or any(not p or p.startswith('.') or p.endswith('.') or p.endswith('.lock') for p in value.split('/')): raise ValueError('branch')
if manifest['baseBranch']=='HEAD' or manifest['featureBranch']=='HEAD' or manifest['baseBranch']==manifest['featureBranch'] or not re.fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',manifest['targetRepository']): raise ValueError('target')
env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0','LC_ALL':'C'}
def git(*args):
 p=subprocess.run(['/usr/bin/git','--git-dir='+gitdir,'--work-tree='+root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.allow=never',*args],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if p.returncode or len(p.stdout)>67108864: raise ValueError('Git import failed')
 return p.stdout
heads=git('bundle','list-heads',bundle).decode().splitlines()
if heads!=[manifest['baseOid']+' refs/heads/import']: raise ValueError('unexpected bundle refs')
git('bundle','verify',bundle)
git('bundle','unbundle',bundle)
git('fsck','--strict','--no-reflogs',manifest['baseOid'])
if git('rev-parse',manifest['baseOid']+'^{tree}').decode().strip()!=manifest['treeOid']: raise ValueError('tree identity')
if int(git('rev-list','--count',manifest['baseOid']))!=manifest['historyCommits']: raise ValueError('history identity')
# Materialize blobs ourselves: no checkout filters, submodules, hooks, or user commands.
entries=git('ls-tree','-r','-z','--full-tree',manifest['baseOid']).split(b'\0'); total=0; count=0
for entry in entries:
 if not entry: continue
 meta,raw=entry.split(b'\t',1);mode,kind,oid=meta.decode().split();path=raw.decode('utf-8','strict')
 if kind!='blob' or mode not in ('100644','100755') or path.startswith('/') or '\\' in path or any(p in ('','.','..') or p.lower()=='.git' for p in path.split('/')) or any(ord(c)<32 or ord(c)==127 for c in path): raise ValueError('unsupported source path')
 count+=1;data=git('cat-file','blob',oid);total+=len(data)
 if count>10000 or total>67108864: raise ValueError('source content bound')
 destination=root+'/'+path;os.makedirs(os.path.dirname(destination),exist_ok=True)
 with open(destination,'xb') as out: out.write(data)
 os.chmod(destination,0o755 if mode=='100755' else 0o644)
git('read-tree',manifest['baseOid'])
git('update-ref','refs/remotes/origin/'+manifest['baseBranch'],manifest['baseOid'])
git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/'+manifest['baseBranch'])
git('update-ref','refs/heads/'+manifest['featureBranch'],manifest['baseOid'])
git('symbolic-ref','HEAD','refs/heads/'+manifest['featureBranch'])
git('config','--local','remote.origin.url','https://github.com/'+manifest['targetRepository']+'.git')
print(json.dumps({'commit':manifest['baseOid'],'tree':manifest['treeOid'],'featureBranch':manifest['featureBranch'],'bundleSha256':manifest['bundleSha256'],'files':count,'bytes':total},sort_keys=True))
`;
