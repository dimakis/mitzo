import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
/** Pinned credential-free verifier code. Git only reads committed objects; it never
 * runs status/diff filters, hooks, a remote, or a caller-provided command. */
export const ARTIFACT_GIT_VERIFIER_CORE = String.raw`
import os, sys, stat, json, hashlib, subprocess
root='${SYMPOSIUM_ARTIFACT_TARGET}'
relative=sys.argv[1]
if relative != '.' and (relative.startswith('/') or any(p in ('','.', '..') for p in relative.split('/'))): raise ValueError('repository path')
repo=root if relative=='.' else root+'/'+relative
for path in [root]+[root+'/'+ '/'.join(relative.split('/')[:i]) for i in range(1,len(relative.split('/'))+1) if relative!='.']:
 s=os.lstat(path)
 if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode): raise ValueError('repository custody')
gitdir=repo+'/.git'
if not stat.S_ISDIR(os.lstat(gitdir).st_mode) or stat.S_ISLNK(os.lstat(gitdir).st_mode): raise ValueError('git directory')
count=0
for base, dirs, files in os.walk(repo, followlinks=False):
 for name in dirs+files:
  count+=1
  if count>100000: raise ValueError('entry limit')
  s=os.lstat(base+'/'+name)
  if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)): raise ValueError('nonregular entry')
for name in ['objects/info/alternates','objects/info/http-alternates','shallow','commondir','gitdir']:
 if os.path.lexists(gitdir+'/'+name): raise ValueError('external or incomplete objects')
env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0','LC_ALL':'C'}
def git(*args):
 p=subprocess.run(['git','--git-dir='+gitdir,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false',*args],cwd=repo,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
 if p.returncode or len(p.stdout)>67108864: raise ValueError('git read failed')
 return p.stdout
commit=git('rev-parse','--verify','HEAD^{commit}').decode().strip()
tree=git('rev-parse','--verify',commit+'^{tree}').decode().strip()
if len(commit) not in (40,64) or any(c not in '0123456789abcdef' for c in commit+tree) or len(tree)!=len(commit): raise ValueError('git oid')
manifest=[]; total=0; tracked=set()
for row in git('ls-tree','-r','-z','--full-tree',commit).split(b'\0'):
 if not row: continue
 meta, rawpath=row.split(b'\t',1); mode,kind,oid=meta.decode().split(' '); path=rawpath.decode('utf-8','strict')
 if kind!='blob' or mode not in ('100644','100755') or path.startswith('/') or any(p in ('','.','..','.git') for p in path.split('/')) or '\\' in path or any(ord(c)<32 or ord(c)==127 for c in path): raise ValueError('unsupported tree entry')
 if path in tracked: raise ValueError('duplicate tree entry')
 tracked.add(path)
 data=git('cat-file','blob',oid); total+=len(data)
 if total>67108864 or len(tracked)>10000: raise ValueError('artifact limit')
 physical=repo+'/'+path; s=os.lstat(physical)
 if not stat.S_ISREG(s.st_mode) or bool(s.st_mode & 0o111)!=(mode=='100755'): raise ValueError('working tree mode')
 with open(physical,'rb') as f: current=f.read(67108865)
 if current!=data: raise ValueError('uncommitted working tree')
 manifest.append({'path':path,'mode':mode,'oid':oid,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
index={}
for row in git('ls-files','--stage','-z').split(b'\0'):
 if not row: continue
 meta,rawpath=row.split(b'\t',1); mode,objectid,stage=meta.decode().split(' '); path=rawpath.decode('utf-8','strict')
 if stage!='0' or path in index: raise ValueError('unmerged index')
 index[path]=(mode,objectid)
if index!={item['path']:(item['mode'],item['oid']) for item in manifest}: raise ValueError('uncommitted index')
actual=set()
for base,dirs,files in os.walk(repo,followlinks=False):
 if base==repo: dirs[:]=[d for d in dirs if d!='.git']
 for name in files: actual.add(os.path.relpath(base+'/'+name,repo))
if actual!=tracked: raise ValueError('untracked working tree')
manifest.sort(key=lambda x:x['path'].encode('utf-8'))
tree_manifest=[{'mode':item['mode'],'oid':item['oid'],'path':item['path']} for item in manifest]
tree_digest=hashlib.sha256(b'mitzo-committed-tree-v1\0'+json.dumps(tree_manifest,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()
proof={'version':1,'commit':commit,'tree':tree,'entries':len(manifest),'bytes':total,'committedTreeDigest':tree_digest,'manifestDigest':hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
`;

export const ARTIFACT_GIT_VERIFIER =
  ARTIFACT_GIT_VERIFIER_CORE + '\nprint(json.dumps(proof,sort_keys=True))\n';
