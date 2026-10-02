/** The published knowledge lane has its own root; writable task Git never moves. */
export function knowledgeViewManifest(baseline: {
  startingCommit: string;
  payloadSha256: string;
  files: Record<string, { sha256: string; mode: string }>;
}) {
  return {
    schemaVersion: 1,
    sourceCommit: baseline.startingCommit,
    payloadSha256: baseline.payloadSha256,
    files: Object.fromEntries(
      Object.entries(baseline.files).filter(([path]) => !path.startsWith('.git/')),
    ),
  };
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function knowledgePresenceCommand(root: string) {
  return `/usr/bin/python3 -c ${quote("import os,sys; print('true' if os.path.lexists(sys.argv[1]) else 'false')")} ${quote(root)}`;
}

/** A failed verification is a cache miss; SSH/transport errors still fail admission. */
export function knowledgeCacheStatusCommand(root: string, manifestSha256: string) {
  const command = knowledgeVerificationCommand(root, manifestSha256);
  const script = `# knowledge-cache-status
import subprocess
result=subprocess.run(['/bin/sh','-c',${JSON.stringify(command)}],capture_output=True)
print('true' if result.returncode==0 else 'false')`;
  return `/usr/bin/python3 -c ${quote(script)}`;
}

/** Remove only the selected invalid, content-addressed cache under its fixed root. */
export function knowledgeCacheRepairCommand(root: string) {
  if (!/^\/sandbox\/workspaces\/knowledge\/knowledge-[a-f0-9]{64}$/.test(root))
    throw new Error('Invalid knowledge cache repair path');
  const script = `# knowledge-cache-repair
import pathlib,shutil,sys
p=pathlib.Path(sys.argv[1])
assert p.parent.resolve(strict=True)==p.parent, 'knowledge cache parent changed'
if p.is_symlink():
 p.unlink()
elif p.is_dir():
 shutil.rmtree(p)
elif p.exists():
 p.unlink()`;
  return `/usr/bin/python3 -c ${quote(script)} ${quote(root)}`;
}

/** Sandbox-local caches have no checkpoint ownership. Keep the active view,
 * manual pins, and at least ten previous views for thirty days. Unknown paths
 * and legacy directories are deliberately outside this cleanup's authority. */
export function knowledgeCleanupCommand(activeRoot: string) {
  const script = `import pathlib,re,shutil,sys,time
active=pathlib.Path(sys.argv[1]).parent
root=active.parent
assert root.resolve(strict=True)==root
versions=[p for p in root.iterdir() if re.fullmatch(r'knowledge-[a-f0-9]{64}',p.name) and p.is_dir() and not p.is_symlink()]
versions.sort(key=lambda p:p.stat().st_mtime,reverse=True)
for p in versions[10:]:
 if p!=active and not (p/'.pinned').exists() and time.time()-p.stat().st_mtime>30*86400:
  shutil.rmtree(p)`;
  return `/usr/bin/python3 -c ${quote(script)} ${quote(activeRoot)}`;
}

/** Verify uploaded bytes/modes against a host-verified immutable selection. */
export function knowledgeVerificationCommand(root: string, manifestSha256: string) {
  if (!root.startsWith('/') || !/^[a-f0-9]{64}$/.test(manifestSha256))
    throw new Error('Invalid knowledge verification identity');
  const script = `import hashlib,json,pathlib,stat,sys
root=pathlib.Path(sys.argv[1])
assert root.resolve(strict=True)==root, 'knowledge root changed'
manifest=root/'knowledge-view.json'
assert stat.S_ISREG(manifest.lstat().st_mode), 'knowledge manifest is not regular'
raw=manifest.read_bytes()
assert hashlib.sha256(raw).hexdigest()==sys.argv[2], 'knowledge manifest changed'
view=json.loads(raw)
assert view['schemaVersion']==1
workspace=root/'mgmt'
assert workspace.is_dir() and not workspace.is_symlink()
paths=list(workspace.rglob('*'))
assert all(stat.S_ISDIR(p.lstat().st_mode) or stat.S_ISREG(p.lstat().st_mode) for p in paths), 'unsafe knowledge file'
actual={p.relative_to(workspace).as_posix() for p in paths if p.is_file()}
assert actual==set(view['files']), 'knowledge file set changed'
for rel,entry in view['files'].items():
 p=pathlib.PurePosixPath(rel)
 assert not p.is_absolute() and '..' not in p.parts and p.as_posix()==rel
 path=workspace/rel
 assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256'], 'knowledge content changed'
 assert format(path.stat().st_mode & 0o7777,'04o')==entry['mode'], 'knowledge mode changed'
print(json.dumps({'sourceCommit':view['sourceCommit'],'payloadSha256':view['payloadSha256']}))`;
  return `/usr/bin/python3 -c ${quote(script)} ${quote(root)} ${quote(manifestSha256)}`;
}
