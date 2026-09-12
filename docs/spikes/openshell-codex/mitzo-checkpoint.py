#!/usr/bin/env python3
"""Strict, portable OpenShell checkpoint archive helper (format v1)."""
import argparse, hashlib, io, json, os, shutil, stat, sys, tarfile, tempfile

FILES={'.sandbox_migration','goals_1.sqlite','goals_1.sqlite-wal','goals_1.sqlite-shm','installation_id','memories_1.sqlite','memories_1.sqlite-wal','memories_1.sqlite-shm','queue_1.sqlite','queue_1.sqlite-wal','queue_1.sqlite-shm','state_5.sqlite','state_5.sqlite-wal','state_5.sqlite-shm','thread_history_1.sqlite','thread_history_1.sqlite-wal','thread_history_1.sqlite-shm'}
DIRS={'sessions','archived_sessions','skills'}
VOLATILE={'tmp','.tmp','thread-writer-locks','logs_2.sqlite','logs_2.sqlite-wal','logs_2.sqlite-shm','shell_snapshots'}
MAX_FILES,MAX_BYTES,MAX_MANIFEST=100000,2*1024*1024*1024,65536
def fail(s): raise ValueError(s)
def lst(path):
 s=os.lstat(path)
 if stat.S_ISLNK(s.st_mode): fail('symlink blocked')
 return s
def entries(root):
 lst(root); out=[]
 for base,dirs,names in os.walk(root,followlinks=False):
  s=lst(base)
  if not stat.S_ISDIR(s.st_mode): fail('invalid directory')
  out.append((os.path.relpath(base,root),True,s))
  for n in dirs+names: lst(os.path.join(base,n))
  for n in names:
   s=lst(os.path.join(base,n))
   if not stat.S_ISREG(s.st_mode): fail('special file blocked')
   out.append((os.path.relpath(os.path.join(base,n),root),False,s))
 return sorted(out)
def digest(root,es):
 if len(es)>MAX_FILES: fail('too many files')
 h=hashlib.sha256(); total=0
 for rel,isdir,s in es:
  h.update(('d' if isdir else 'f').encode()+b'\0'+rel.encode()+b'\0'+str(stat.S_IMODE(s.st_mode)).encode()+b'\0')
  if not isdir:
   total+=s.st_size
   if total>MAX_BYTES: fail('archive too large')
   with open(os.path.join(root,rel),'rb') as f:
    while c:=f.read(1024*1024): h.update(c)
 return h.hexdigest()
def cred(rel):
 return any(x in ('.codex','.aws','.ssh','auth.json','credentials.json') or x.startswith('.env') or x.startswith('credential') for x in rel.split('/'))
def provider(path):
 if not os.path.isdir(path): fail('provider state is missing')
 lst(path)
 for n in os.listdir(path):
  s=lst(os.path.join(path,n))
  if n in VOLATILE: continue
  if stat.S_ISREG(s.st_mode) and n in FILES: continue
  if stat.S_ISDIR(s.st_mode) and n in DIRS: entries(os.path.join(path,n)); continue
  fail('unsupported provider state: '+n)
def workspace(path):
 if not os.path.isdir(path): fail('workspace is missing')
 for rel,isdir,_ in entries(path):
  if rel!='.' and cred(rel): fail('credential-like workspace file')
def source(p,w): provider(p); workspace(w); return p,w
def quiescent(provider_root, workspace_root):
 # The lifecycle coordinator owns shutdown.  This only proves that shutdown
 # completed; it never kills an unowned process to make capture possible.
 if not os.path.isdir('/proc'): fail('cannot verify provider quiescence')
 for pid in os.listdir('/proc'):
  if not pid.isdigit() or int(pid)==os.getpid(): continue
  try:
   command=open('/proc/'+pid+'/cmdline','rb').read().replace(b'\0',b' ').decode(errors='ignore')
   if 'app-server' in command or 'run-mitzo-app-server' in command: fail('provider writer is still running')
   for fd in os.listdir('/proc/'+pid+'/fd'):
    try:
     target=os.readlink('/proc/'+pid+'/fd/'+fd)
     if target.startswith(provider_root+'/') or target.startswith(workspace_root+'/'): fail('sandbox writer is still open')
    except FileNotFoundError: pass
  except (FileNotFoundError,ProcessLookupError): continue
  except PermissionError: fail('cannot verify provider quiescence')
def manifest(a,d):
 m={'version':1,'conversation':a.conversation,'thread':a.thread,'binding':a.binding,'image':a.image,'policy':a.policy,'sandboxId':a.sandbox_id,'resourceVersion':a.resource_version,'accountProvider':a.account_provider,'accountId':a.account_id,'provider':a.provider,'model':a.model,'profileRevision':a.profile_revision,'runtimeScope':a.runtime_scope,'routeKind':a.route_kind,'routeProvider':a.route_provider,'helper':'mitzo-checkpoint-v1','digest':d}
 if a.route_kind=='chatgpt-subscription':
  if not all((a.route_provider_type,a.route_provider_id,a.route_grant_id)): fail('subscription route identity is incomplete')
  m.update({'routeProviderType':a.route_provider_type,'routeProviderId':a.route_provider_id,'routeGrantId':a.route_grant_id})
 elif any((a.route_provider_type,a.route_provider_id,a.route_grant_id)): fail('api route must not include subscription identity')
 return m
def capture(a):
 p,w=source(os.path.join(a.source,'.codex'),os.path.join(a.source,'workspace')) if a.source else source(a.provider_root,a.workspace_root); stage=tempfile.mkdtemp(prefix='mitzo-checkpoint-',dir=os.path.dirname(os.path.abspath(a.output))) ; tmp=a.output+'.tmp'
 try:
  if a.require_quiescent: quiescent(p,w)
  os.mkdir(os.path.join(stage,'.codex'),0o700); os.mkdir(os.path.join(stage,'workspace'),0o700)
  for n in os.listdir(p):
   if n in FILES or n in DIRS:
    src,dst=os.path.join(p,n),os.path.join(stage,'.codex',n)
    shutil.copytree(src,dst,symlinks=True) if os.path.isdir(src) else shutil.copy2(src,dst)
  shutil.copytree(w,os.path.join(stage,'workspace'),symlinks=True,dirs_exist_ok=True)
  es=entries(stage); m=manifest(a,digest(stage,es)); fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as raw,tarfile.open(fileobj=raw,mode='w') as tar:
   for rel,_,_ in es: tar.add(os.path.join(stage,rel),arcname=rel,recursive=False)
   data=json.dumps(m,sort_keys=True,separators=(',',':')).encode(); i=tarfile.TarInfo('manifest.json'); i.size=len(data); i.mode=0o600; tar.addfile(i,io.BytesIO(data))
  os.replace(tmp,a.output); print(json.dumps(m,sort_keys=True))
 except:
  if os.path.exists(tmp): os.unlink(tmp)
  raise
 finally: shutil.rmtree(stage,ignore_errors=True)
def safe_name(n):
 if n in ('.','./'): return '.'
 if not n or n.startswith('/') or '\\' in n: fail('unsafe archive member')
 v=os.path.normpath(n)
 if v in ('.','') or v.startswith('../') or v!=n.rstrip('/'): fail('unsafe archive member')
 if v.split('/')[0] not in ('.codex','workspace','manifest.json'): fail('unsafe archive member')
 return v
def validate_names(names):
 for n in names:
  if n.startswith('.codex/'):
   top=n.split('/')[1]
   if top in VOLATILE: fail('volatile provider state')
   if top not in FILES and top not in DIRS: fail('unsupported provider state: '+top)
  if n.startswith('workspace/') and cred('/'.join(n.split('/')[1:])): fail('credential-like workspace file')
def copy_member(src,target,size):
 done=0
 with src,open(target,'xb') as dst:
  while c:=src.read(1024*1024):
   done+=len(c)
   if done>size or done>MAX_BYTES: fail('archive member size changed')
   dst.write(c)
 if done!=size: fail('truncated archive member')
def read_archive(path):
 with tarfile.open(path,'r') as tar:
  ms=tar.getmembers()
  if len(ms)>MAX_FILES: fail('too many archive members')
  names=[safe_name(x.name) for x in ms]
  if len(set(names))!=len(names) or 'manifest.json' not in names: fail('invalid archive')
  validate_names(names); total=0; mm=None
  for x,n in zip(ms,names):
   if x.islnk() or x.issym() or not(x.isdir() or x.isfile()) or x.mode&~0o777: fail('unsafe archive member')
   total+=x.size
   if total>MAX_BYTES: fail('archive too large')
   if n=='manifest.json': mm=x
  if not mm or mm.size>MAX_MANIFEST: fail('unsupported manifest')
  raw=tar.extractfile(mm).read(MAX_MANIFEST+1)
  if len(raw)!=mm.size or len(raw)>MAX_MANIFEST: fail('truncated manifest')
  m=json.loads(raw); required={'version','conversation','thread','binding','image','policy','sandboxId','resourceVersion','accountProvider','accountId','provider','model','profileRevision','runtimeScope','routeKind','routeProvider','helper','digest'}; subscription={'routeProviderType','routeProviderId','routeGrantId'}
  if not isinstance(m,dict) or set(m) not in (required,required|subscription) or m['version']!=1 or m['helper']!='mitzo-checkpoint-v1' or not all(isinstance(m[x],str) and m[x] for x in required-{'version','helper'}): fail('unsupported manifest')
  if (m['routeKind']=='api' and set(m)&subscription) or (m['routeKind']=='chatgpt-subscription' and (set(m)&subscription)!=subscription) or m['routeKind'] not in ('api','chatgpt-subscription'): fail('unsupported route identity')
  stage=tempfile.mkdtemp(prefix='mitzo-restore-')
  try:
   for x,n in zip(ms,names):
    if n=='manifest.json': continue
    target=os.path.join(stage,n); os.makedirs(os.path.dirname(target),exist_ok=True)
    if x.isdir(): os.makedirs(target,exist_ok=True); os.chmod(target,x.mode)
    else:
     f=tar.extractfile(x)
     if not f: fail('missing archive member')
     copy_member(f,target,x.size); os.chmod(target,x.mode)
   provider(os.path.join(stage,'.codex')); workspace(os.path.join(stage,'workspace'))
   if digest(stage,entries(stage))!=m['digest']: fail('digest mismatch')
   return m,stage
  except: shutil.rmtree(stage,ignore_errors=True); raise
def identity(m,a):
 for key,arg in [('conversation','conversation'),('thread','thread'),('binding','binding'),('image','image'),('policy','policy'),('sandboxId','sandbox_id'),('resourceVersion','resource_version'),('accountProvider','account_provider'),('accountId','account_id'),('provider','provider'),('model','model'),('profileRevision','profile_revision'),('runtimeScope','runtime_scope'),('routeKind','route_kind'),('routeProvider','route_provider'),('routeProviderType','route_provider_type'),('routeProviderId','route_provider_id'),('routeGrantId','route_grant_id')]:
  if m.get(key)!=getattr(a,arg): fail('checkpoint identity mismatch')
def verify(a):
 m,s=read_archive(a.input)
 try: identity(m,a); print(json.dumps(m,sort_keys=True))
 finally: shutil.rmtree(s,ignore_errors=True)
def restore(a):
 m,s=read_archive(a.input)
 try:
  identity(m,a)
  if a.destination:
   if os.path.lexists(a.destination): fail('destination exists')
   os.replace(s,a.destination); s=None
  elif a.replace_fresh_roots:
   if not(os.path.isabs(a.provider_root) and os.path.basename(a.provider_root)=='.codex' and os.path.isabs(a.workspace_root) and os.path.basename(a.workspace_root)=='mgmt'): fail('fresh-root replacement is restricted')
   for r in (a.provider_root,a.workspace_root):
    if os.path.lexists(r) and os.path.islink(r): fail('restore root symlink blocked')
   backups=[]
   try:
    for r in (a.provider_root,a.workspace_root):
     os.makedirs(os.path.dirname(r),exist_ok=True)
     if os.path.exists(r):
      b=r+'.mitzo-pre-restore'
      if os.path.lexists(b): fail('restore backup exists')
      os.rename(r,b); backups.append((r,b))
    os.rename(os.path.join(s,'.codex'),a.provider_root); os.rename(os.path.join(s,'workspace'),a.workspace_root)
    for _,b in backups: shutil.rmtree(b)
   except:
    for r,b in reversed(backups):
     if os.path.exists(r): shutil.rmtree(r)
     if os.path.exists(b): os.rename(b,r)
    raise
   shutil.rmtree(s); s=None
  else:
   if os.path.lexists(a.provider_root) or os.path.lexists(a.workspace_root): fail('restore roots already exist')
   os.makedirs(os.path.dirname(a.provider_root),exist_ok=True); os.makedirs(os.path.dirname(a.workspace_root),exist_ok=True)
   os.replace(os.path.join(s,'.codex'),a.provider_root); os.replace(os.path.join(s,'workspace'),a.workspace_root); shutil.rmtree(s); s=None
  print(json.dumps(m,sort_keys=True))
 finally:
  if s: shutil.rmtree(s,ignore_errors=True)
def main():
 p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
 for c in ('capture','restore','verify'):
  q=sub.add_parser(c); q.add_argument('--input' if c!='capture' else '--source'); q.add_argument('--output',required=c=='capture'); q.add_argument('--destination'); q.add_argument('--provider-root'); q.add_argument('--workspace-root'); q.add_argument('--replace-fresh-roots',action='store_true'); q.add_argument('--require-quiescent',action='store_true'); q.add_argument('--conversation',required=True); q.add_argument('--thread',required=True); q.add_argument('--binding',required=True); q.add_argument('--image',required=True); q.add_argument('--policy',required=True); q.add_argument('--sandbox-id',required=True); q.add_argument('--resource-version',required=True); q.add_argument('--account-provider',required=True); q.add_argument('--account-id',required=True); q.add_argument('--provider',required=True); q.add_argument('--model',required=True); q.add_argument('--profile-revision',required=True); q.add_argument('--runtime-scope',required=True); q.add_argument('--route-kind',choices=('api','chatgpt-subscription'),required=True); q.add_argument('--route-provider',required=True); q.add_argument('--route-provider-type'); q.add_argument('--route-provider-id'); q.add_argument('--route-grant-id')
 a=p.parse_args(); {'capture':capture,'restore':restore,'verify':verify}[a.cmd](a)
if __name__=='__main__':
 try: main()
 except Exception as e: print('checkpoint: '+str(e),file=sys.stderr); sys.exit(2)
