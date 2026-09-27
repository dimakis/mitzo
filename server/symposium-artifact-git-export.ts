import { ARTIFACT_GIT_VERIFIER_CORE } from './symposium-artifact-git-verifier.js';
/** Entire script runs inside the pinned, credential-free read-only helper. */
export const ARTIFACT_GIT_EXPORT =
  ARTIFACT_GIT_VERIFIER_CORE +
  String.raw`
import re, base64, selectors, time, signal
options=json.loads(sys.argv[2])
expected=options['expected']
if proof!=expected: raise ValueError('sealed Git identity changed')
def branch(value):
 if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,254}',value): raise ValueError('branch')
 git('check-ref-format','refs/heads/'+value)
 return value
base_branch=branch(options['baseBranch'])
source_branch=git('symbolic-ref','--quiet','--short','HEAD').decode().strip()
branch(source_branch)
source_ref='refs/heads/'+source_branch
base_ref='refs/remotes/origin/'+base_branch
if git('rev-parse','--verify',source_ref+'^{commit}').decode().strip()!=commit: raise ValueError('branch commit')
base_oid=git('rev-parse','--verify',base_ref+'^{commit}').decode().strip()
default_ref=git('symbolic-ref','--quiet','refs/remotes/origin/HEAD').decode().strip()
if not default_ref.startswith('refs/remotes/origin/'): raise ValueError('default branch')
default_branch=branch(default_ref[len('refs/remotes/origin/'):])
origin=git('config','--get','remote.origin.url').decode().strip()
# Never emit an origin containing credentials, query text or a non-GitHub host.
if not re.fullmatch(r'(https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?',origin): raise ValueError('origin URL')
count=int(git('rev-list','--count',base_oid+'..'+commit).decode().strip())
paths=set()
for raw in git('diff-tree','--no-commit-id','--name-only','--no-ext-diff','--no-textconv','-r','-z',base_oid+'..'+commit).split(b'\0'):
 if not raw: continue
 path=raw.decode('utf-8','strict')
 if path.startswith('/') or '\\' in path or any(p in ('','.','..','.git') for p in path.split('/')) or any(ord(c)<32 or ord(c)==127 for c in path): raise ValueError('changed path')
 paths.add(path)
 if len(paths)>500: raise ValueError('changed path bound')
inspection={'canonicalRepositoryPath':repo,'status':'clean','sourceBranch':source_branch,'sourceOid':commit,'defaultBranch':default_branch,'originUrl':origin,'commitsAhead':count,'changedFiles':sorted(paths,key=lambda p:p.encode('utf-8')),'sourceBranchProtected':False,'symlinkFree':True}
if options['kind']=='inspect':
 print(json.dumps({'inspection':inspection,'proof':proof},sort_keys=True))
elif options['kind']=='bundle':
 if source_branch!=options['sourceBranch'] or commit!=options['sourceOid']: raise ValueError('export selection changed')
 limit=options['maxBytes']
 if type(limit)!=int or limit<1 or limit>8388608: raise ValueError('bundle bound')
 args=['git','--git-dir='+gitdir,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','pack.threads=1','-c','pack.windowMemory=16m','bundle','create','-',base_ref+'..'+source_ref]
 p=subprocess.Popen(args,cwd=repo,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 selector=selectors.DefaultSelector(); selector.register(p.stdout,selectors.EVENT_READ); chunks=[]; length=0; deadline=time.monotonic()+20
 try:
  while selector.get_map():
   if time.monotonic()>deadline: raise ValueError('bundle time bound')
   for key,_ in selector.select(0.1):
    chunk=os.read(key.fileobj.fileno(),65536)
    if not chunk: selector.unregister(key.fileobj); continue
    length+=len(chunk)
    if length>limit: raise ValueError('bundle byte bound')
    chunks.append(chunk)
  if p.wait(timeout=max(0.1,deadline-time.monotonic()))!=0: raise ValueError('bundle command')
 finally:
  selector.close()
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 data=b''.join(chunks)
 if not data: raise ValueError('empty bundle')
 print(json.dumps({'proof':proof,'bundle':base64.b64encode(data).decode(),'bundleSha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)},sort_keys=True))
else: raise ValueError('export operation')
`;
