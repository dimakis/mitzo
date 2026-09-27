import { ARTIFACT_GIT_VERIFIER_CORE } from './symposium-artifact-git-verifier.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
/** Bounded stdin is the only artifact input. No parent mount, copied Git config, hooks or filters. */
export const ARTIFACT_GIT_SUCCESSOR_IMPORT =
  String.raw`
import os, sys, stat, json, hashlib, subprocess, tempfile, signal, re
signal.alarm(45)
root='${SYMPOSIUM_ARTIFACT_TARGET}'
options=json.loads(sys.argv[2]); expected=options['expected']; selection=options['selection']
relative=sys.argv[1]
if relative!='.' and (relative.startswith('/') or any(p in ('','.','..') for p in relative.split('/'))): raise ValueError('repository path')
if not stat.S_ISDIR(os.lstat(root).st_mode) or stat.S_ISLNK(os.lstat(root).st_mode) or os.listdir(root): raise ValueError('fresh empty child required')
limit=options['bytes']
if type(limit)!=int or limit<1 or limit>8388608: raise ValueError('bundle byte bound')
data=sys.stdin.buffer.read(limit+1)
if len(data)!=limit or hashlib.sha256(data).hexdigest()!=options['bundleSha256']: raise ValueError('bundle integrity')
source=selection['sourceRef']; base=selection['baseRef']
if 'refs/remotes/origin/'+selection['defaultBranch']!=base: raise ValueError('successor default ref must be selected base')
for ref,prefix in [(source,'refs/heads/'),(base,'refs/remotes/origin/')]:
 if not ref.startswith(prefix) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,254}',ref[len(prefix):]): raise ValueError('selected ref')
if selection['sourceOid']!=expected['commit']: raise ValueError('selected commit')
origin=selection['originUrl']
if len(origin)>2048 or not re.fullmatch(r'(https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?',origin): raise ValueError('origin')
repo=root if relative=='.' else root+'/'+relative
os.makedirs(repo,exist_ok=True)
env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','LC_ALL':'C'}
def run(*args):
 p=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],cwd=repo,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
 if p.returncode or len(p.stdout)>67108864: raise ValueError('child Git operation failed')
 return p.stdout
run('init','--quiet','--template=','--object-format='+('sha256' if len(expected['commit'])==64 else 'sha1'))
run('check-ref-format',source); run('check-ref-format',base)
run('check-ref-format','refs/heads/'+selection['defaultBranch'])
with tempfile.NamedTemporaryFile(prefix='mitzo-successor-',suffix='.bundle') as f:
 f.write(data);f.flush()
 heads=run('bundle','list-heads',f.name).decode().strip().split('\n')
 if sorted(heads)!=sorted([selection['sourceOid']+' '+source,selection['baseOid']+' '+base]): raise ValueError('bundle ref selection')
 run('bundle','verify',f.name) # Empty repository proves there are no prerequisite objects.
 run('fetch','--no-tags','--no-write-fetch-head',f.name,source+':'+source,base+':'+base)
run('symbolic-ref','HEAD',source)
run('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/'+selection['defaultBranch'])
run('config','remote.origin.url',origin)
# Materialize committed regular blobs directly: never run checkout filters or hooks.
tree=run('ls-tree','-r','-z','--full-tree',expected['commit'])
if len(tree)>1048576: raise ValueError('tree bound')
count=0;total=0
for row in tree.split(b'\0'):
 if not row: continue
 meta,raw=row.split(b'\t',1); mode,kind,oid=meta.decode().split(' '); path=raw.decode('utf-8','strict')
 if kind!='blob' or mode not in ('100644','100755') or path.startswith('/') or '\\' in path or any(p in ('','.','..','.git') for p in path.split('/')) or any(ord(c)<32 or ord(c)==127 for c in path): raise ValueError('unsupported tree entry')
 count+=1; blob=run('cat-file','blob',oid);total+=len(blob)
 if count>10000 or total>67108864: raise ValueError('artifact bound')
 dest=repo+'/'+path;os.makedirs(os.path.dirname(dest),exist_ok=True)
 with open(dest,'xb') as f: f.write(blob)
 os.chmod(dest,0o755 if mode=='100755' else 0o644)
run('read-tree',expected['commit'])
` +
  ARTIFACT_GIT_VERIFIER_CORE +
  String.raw`
if proof!=expected: raise ValueError('child verification differs from sealed parent')
print(json.dumps(proof,sort_keys=True))
`;
