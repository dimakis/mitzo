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
