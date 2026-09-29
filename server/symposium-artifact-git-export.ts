import { ARTIFACT_GIT_VERIFIER_CORE } from './symposium-artifact-git-verifier.js';
// Shared producer/transport ceiling includes JSON escaping and the trailing newline.
// The 1 MiB history-path input expands at most threefold in ASCII JSON; metadata is bounded.
export const ARTIFACT_INSPECTION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const ARTIFACT_REVIEW_CONTEXT_MAX_BYTES = 48 * 1024;
export const ARTIFACT_REVIEW_CONTEXT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
// The imported base and sealed target each admit at most 64 MiB of file bytes.
// Endpoint diff lines add a prefix and Git headers, so allow roughly twice the
// combined source budget while keeping all emitted helper batches below 2 MiB.
export const ARTIFACT_REVIEW_MAX_SELECTED_BYTES = 260 * 1024 * 1024;
export const ARTIFACT_REVIEW_MAX_PAGES = 32768;
export const ARTIFACT_REVIEW_BATCH_PAGES = 16;
/** Entire script runs inside the pinned, credential-free read-only helper. */
export const ARTIFACT_GIT_EXPORT =
  ARTIFACT_GIT_VERIFIER_CORE +
  String.raw`
import re, base64, selectors, time, signal
options=json.loads(sys.argv[2])
expected=options['expected']
if proof!=expected: raise ValueError('sealed Git identity changed')
if options['kind']=='check':
 path=options['checkPath']
 if not isinstance(path,str) or len(path)>512 or not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',path) or any(p in ('.','..','.git') for p in path.split('/')): raise ValueError('check path')
 entry=next((item for item in manifest if item['path']==path),None)
 print(json.dumps({'proof':proof,'checkPath':path,'observedSha256':entry['sha256'] if entry else None},sort_keys=True))
 sys.exit(0)
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
if len(origin)>2048 or not re.fullmatch(r'(https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?',origin): raise ValueError('origin URL')
review_base_oid=base_oid
if options['kind']=='review_context':
 # Main may advance after the sealed feature commit. Require one shared ancestor
 # rather than including main-only commits or selecting an arbitrary criss-cross base.
 merge_bases=git('merge-base','--all',base_oid,commit).decode().splitlines()
 if len(merge_bases)!=1 or len(merge_bases[0])!=len(commit) or any(c not in '0123456789abcdef' for c in merge_bases[0]): raise ValueError('unique review merge base')
 review_base_oid=merge_bases[0]
comparison_oid=review_base_oid if options['kind']=='review_context' else base_oid
count=int(git('rev-list','--count',comparison_oid+'..'+commit).decode().strip())
paths=set()
# Feed every exported commit; a two-endpoint diff hides reverted/deleted history.
commits=git('rev-list',comparison_oid+'..'+commit)
history_paths=git('diff-tree','--stdin','--root','-m','--no-commit-id','--name-only','--no-renames','--no-ext-diff','--no-textconv','-r','-z',input=commits)
if len(history_paths)>1048576: raise ValueError('history path byte bound')
for raw in history_paths.split(b'\0'):
 if not raw: continue
 path=raw.decode('utf-8','strict')
 if path.startswith('/') or '\\' in path or any(p in ('','.','..','.git') for p in path.split('/')) or any(ord(c)<32 or ord(c)==127 for c in path): raise ValueError('changed path')
 paths.add(path)
 if len(paths)>500: raise ValueError('changed path bound')
inspection={'canonicalRepositoryPath':repo,'status':'clean','sourceBranch':source_branch,'sourceOid':commit,'defaultBranch':default_branch,'originUrl':origin,'commitsAhead':count,'changedFiles':sorted(paths,key=lambda p:p.encode('utf-8')),'sourceBranchProtected':False,'symlinkFree':True}
if options['kind']=='review_context':
 if not paths: raise ValueError('review context has no changed files')
 base_entries={}
 base_modes={}
 for row in git('ls-tree','-r','-z','--full-tree',review_base_oid).split(b'\0'):
  if not row: continue
  meta,rawpath=row.split(b'\t',1); mode,kind,objectid=meta.decode().split(' ')
  path=rawpath.decode('utf-8','strict')
  if path in paths:
   if kind!='blob' or mode not in ('100644','100755'): raise ValueError('unsupported review base entry')
   base_entries[path]=objectid
   base_modes[path]=mode
 target={item['path']:item for item in manifest}
 files=[]
 def excerpt(value,limit):
  data=value.encode('utf-8')
  if len(data)<=limit: return value,False
  # Decode only complete characters; the digest and byte count bind the omitted bytes.
  head=data[:limit//2].decode('utf-8','ignore')
  tail=data[-(limit//2):].decode('utf-8','ignore')
  return head+'\n[... sealed excerpt omitted ...]\n'+tail,True
 for path in sorted(paths,key=lambda p:p.encode('utf-8')):
  source=target.get(path)
  for objectid in ([base_entries[path]] if path in base_entries else [])+([source['oid']] if source else []):
   data=git('cat-file','blob',objectid)
   if b'\0' in data: raise ValueError('binary review file')
   data.decode('utf-8','strict')
  content=git('cat-file','blob',source['oid']).decode('utf-8','strict') if source else None
  diff=git('diff','--no-ext-diff','--no-textconv','--no-renames','--full-index','--unified=3',review_base_oid,commit,'--',':(literal)'+path).decode('utf-8','strict')
  if 'Binary files ' in diff or 'GIT binary patch' in diff: raise ValueError('binary review diff')
  diff_bytes=diff.encode('utf-8')
  content_bytes=content.encode('utf-8') if content is not None else None
  # A target-only snapshot hides removed lines in a modified file. Preserve the
  # complete endpoint diff even when the new blob is shorter; admission rejects
  # a partial diff if the bounded context cannot carry it.
  if diff and (path in base_entries or content_bytes is None or len(diff_bytes)<=len(content_bytes)):
   representation='diff'
  elif content is not None:
   representation='content'
  else:
   representation='absent' # Changed in history, but absent at both endpoints.
  files.append({'path':path,'status':'present' if source else 'deleted','baseMode':base_modes.get(path),'mode':source['mode'] if source else None,'sha256':source['sha256'] if source else None,'bytes':source['bytes'] if source else None,'representation':representation,'complete':True,'content':content if representation=='content' else None,'contentTruncated':False,'diff':diff if representation=='diff' else None,'diffSha256':hashlib.sha256(diff_bytes).hexdigest(),'diffBytes':len(diff_bytes),'diffTruncated':False})
 if 'page' in options:
  page=options['page']
  if type(page)!=int or page<0 or page>=${ARTIFACT_REVIEW_MAX_PAGES} or page%${ARTIFACT_REVIEW_BATCH_PAGES}!=0: raise ValueError('review page')
  identity={'version':3,'scope':'sealed-changed-path-pages','sourceOid':commit,'baseOid':review_base_oid,'sourceBranch':source_branch,'baseBranch':base_branch,'committedTreeDigest':proof['committedTreeDigest'],'manifestDigest':proof['manifestDigest'],'trackedFileCount':proof['entries'],'changedPathCount':len(paths)}
  descriptors=[{key:item[key] for key in ('path','status','baseMode','mode','sha256','bytes','representation','diffSha256','diffBytes')} for item in files]
  # Each page is re-derived from the pinned Git tree by a fresh helper. Keep the
  # complete selection bounded before emitting any page to limit repeated work.
  selected_bytes=sum(len((item[item['representation']] if item['representation'] in ('diff','content') else '').encode('utf-8')) for item in files)
  if selected_bytes>${ARTIFACT_REVIEW_MAX_SELECTED_BYTES}: raise ValueError('review evidence total byte bound')
  evidence_sha=hashlib.sha256(json.dumps({'identity':identity,'files':descriptors},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()
  segments=[]
  for item in files:
   selected=item['representation']
   data=item[selected] if selected in ('diff','content') else ''
   raw=data.encode('utf-8')
   parts=[]
   if not raw: parts=['']
   else:
    start=0
    while start<len(raw):
     end=min(start+16384,len(raw))
     while end>start:
      try: part=raw[start:end].decode('utf-8','strict');break
      except UnicodeDecodeError: end-=1
     if end==start: raise ValueError('review UTF-8 page')
     parts.append(part);start=end
   selected_sha=hashlib.sha256(raw).hexdigest()
   for index,part in enumerate(parts):
    segments.append({'path':item['path'],'status':item['status'],'baseMode':item['baseMode'],'mode':item['mode'],'sha256':item['sha256'],'bytes':item['bytes'],'representation':selected,'diffSha256':item['diffSha256'],'diffBytes':item['diffBytes'],'selectedSha256':selected_sha,'selectedBytes':len(raw),'segmentIndex':index,'segmentCount':len(parts),'data':part,'segmentSha256':hashlib.sha256(part.encode('utf-8')).hexdigest()})
  pages=[];current=[]
  def encoded_page(parts,index,total):
   return json.dumps({**identity,'evidenceSha256':evidence_sha,'pageIndex':index,'pageCount':total,'segments':parts},sort_keys=True,separators=(',',':'),ensure_ascii=False)
  for segment in segments:
   if current and len(encoded_page(current+[segment],65535,65535).encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}:
    pages.append(current);current=[]
   if len(encoded_page([segment],65535,65535).encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}: raise ValueError('review segment metadata bound')
   current.append(segment)
  if current: pages.append(current)
  if not pages or len(pages)>${ARTIFACT_REVIEW_MAX_PAGES} or page>=len(pages): raise ValueError('review page unavailable')
  encoded_pages=[encoded_page(parts,index,len(pages)) for index,parts in enumerate(pages)]
  if any(len(encoded.encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES} for encoded in encoded_pages): raise ValueError('review page byte bound')
  pages_digest=hashlib.sha256(json.dumps(encoded_pages,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()
  selected_pages=encoded_pages[page:page+${ARTIFACT_REVIEW_BATCH_PAGES}]
  print(json.dumps({'proof':proof,'context':selected_pages[0],'contextSha256':hashlib.sha256(selected_pages[0].encode('utf-8')).hexdigest(),'pages':selected_pages,'pagesSha256':pages_digest},sort_keys=True,ensure_ascii=False))
  sys.exit(0)
 context={'version':2,'scope':'bounded-changed-path-evidence','sourceOid':commit,'baseOid':review_base_oid,'sourceBranch':source_branch,'baseBranch':base_branch,'committedTreeDigest':proof['committedTreeDigest'],'manifestDigest':proof['manifestDigest'],'trackedFileCount':proof['entries'],'changedPathCount':len(paths),'omittedPathCount':0,'files':[]}
 for item in files:
  context['files'].append(item)
  context['omittedPathCount']=len(files)-len(context['files'])
  if len(json.dumps(context,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}:
   context['files'].pop()
   if item['representation'] in ('diff','content'):
    selected=item['representation']
    partial=dict(item)
    partial['representation']='partial';partial['complete']=False
    partial[selected],_=excerpt(item[selected],2048)
    partial[selected+'Truncated']=True
    context['files'].append(partial)
    context['omittedPathCount']=len(files)-len(context['files'])
    if len(json.dumps(context,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}: context['files'].pop()
   context['omittedPathCount']=len(files)-len(context['files'])
   break
 if not context['files']: raise ValueError('review context metadata exceeds byte bound')
 encoded=json.dumps(context,sort_keys=True,separators=(',',':'),ensure_ascii=False)
 if len(encoded.encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}: raise ValueError('review context byte bound')
 print(json.dumps({'proof':proof,'context':encoded,'contextSha256':hashlib.sha256(encoded.encode('utf-8')).hexdigest()},sort_keys=True,ensure_ascii=False))
elif options['kind']=='inspect':
 encoded=json.dumps({'inspection':inspection,'proof':proof},sort_keys=True)+'\n'
 if len(encoded.encode('utf-8'))>${ARTIFACT_INSPECTION_MAX_OUTPUT_BYTES}: raise ValueError('inspection byte bound')
 sys.stdout.write(encoded)
elif options['kind'] in ('bundle','successor'):
 if options['kind']=='successor' and default_ref!=base_ref: raise ValueError('successor default ref must be selected base')
 if source_branch!=options['sourceBranch'] or commit!=options['sourceOid']: raise ValueError('export selection changed')
 limit=options['maxBytes']
 if type(limit)!=int or limit<1 or limit>8388608: raise ValueError('bundle bound')
 refs=[base_ref,source_ref] if options['kind']=='successor' else [base_ref+'..'+source_ref]
 args=['git','--git-dir='+gitdir,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','pack.threads=1','-c','pack.windowMemory=16m','bundle','create','-',*refs]
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
 result={'proof':proof,'bundle':base64.b64encode(data).decode(),'bundleSha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
 if options['kind']=='successor': result['selection']={'sourceRef':source_ref,'sourceOid':commit,'baseRef':base_ref,'baseOid':base_oid,'defaultBranch':default_branch,'originUrl':origin}
 print(json.dumps(result,sort_keys=True))
else: raise ValueError('export operation')
`;
