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
// The legacy one-context path can only retain a bounded diff for truncation.
export const ARTIFACT_REVIEW_HELPER_MAX_SELECTED_BYTES = 128 * 1024 * 1024;
export const ARTIFACT_REVIEW_MAX_PAGES = 32768;
export const ARTIFACT_REVIEW_BATCH_PAGES = 16;
/** Entire script runs inside the pinned, credential-free read-only helper. */
export const ARTIFACT_GIT_EXPORT =
  ARTIFACT_GIT_VERIFIER_CORE +
  String.raw`
import re, base64, selectors, time, signal, codecs
options=json.loads(sys.argv[2])
expected=options['expected']
if proof!=expected: raise ValueError('sealed Git identity changed')
# The verifier retains its last blob and working-tree read in module globals.
# Proof is immutable now; release those byte copies before paging evidence.
for key in ('data','current','tree_output'):
 globals().pop(key,None)
# One budget covers every changed path. Leave time under the owned 60-second
# Podman attach limit for page construction and JSON serialization.
review_diff_deadline=time.monotonic()+40
review_page_deadline=time.monotonic()+55
def review_diff(path,base,target,keep_limit,allow_unretained,consumer=None):
 # The shared verifier's 64 MiB stdout ceiling protects ordinary Git reads.
 # A complete replacement diff can exceed that ceiling even when both blobs
 # fit the sealed 64 MiB tree. Drain this one pinned, literal-path command in
 # bounded chunks and reject before it can exceed the review evidence budget.
 if time.monotonic()>review_diff_deadline: raise ValueError('review diff time bound')
 args=['git','--git-dir='+gitdir,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','diff','--no-ext-diff','--no-textconv','--no-renames','--full-index','--unified=3',base,target,'--',':(literal)'+path]
 p=subprocess.Popen(args,cwd=repo,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ)
 output=bytearray() if consumer is None else None;length=0;digest=hashlib.sha256();decoder=codecs.getincrementaldecoder('utf-8')('strict');tail=b''
 try:
  while selector.get_map():
   if time.monotonic()>review_diff_deadline: raise ValueError('review diff time bound')
   for key,_ in selector.select(0.1):
    chunk=os.read(key.fileobj.fileno(),65536)
    if not chunk: selector.unregister(key.fileobj);continue
    length+=len(chunk)
    if length>${ARTIFACT_REVIEW_MAX_SELECTED_BYTES}: raise ValueError('review diff byte bound')
    digest.update(chunk);decoder.decode(chunk,final=False)
    joined=tail+chunk
    if b'Binary files ' in joined or b'GIT binary patch' in joined: raise ValueError('binary review diff')
    tail=chunk[-32:]
    if consumer is not None: consumer(chunk)
    if output is not None:
     if length>keep_limit:
      if not allow_unretained: raise ValueError('review evidence total byte bound')
      output=None
     else: output.extend(chunk)
  decoder.decode(b'',final=True)
  if p.wait(timeout=max(0.1,review_diff_deadline-time.monotonic()))!=0: raise ValueError('review diff command')
  if time.monotonic()>review_diff_deadline: raise ValueError('review diff time bound')
 finally:
  selector.close()
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 return output,digest.hexdigest(),length
class ReviewSegmenter:
 def __init__(self,emit): self.emit=emit;self.pending=bytearray();self.position=0;self.index=0
 def flush(self,limit):
  end=min(limit,len(self.pending))
  while end:
   try: part=bytes(self.pending[:end]);part.decode('utf-8','strict');break
   except UnicodeDecodeError: end-=1
  if not end: raise ValueError('review UTF-8 page')
  self.emit(self.index,self.position,self.position+end,part)
  del self.pending[:end];self.position+=end;self.index+=1
 def feed(self,chunk):
  self.pending.extend(chunk)
  while len(self.pending)>=16384: self.flush(16384)
 def finish(self):
  while self.pending: self.flush(16384)
  if not self.index: self.emit(0,0,0,b'');self.index=1
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
 files=[];selected_used=0;paged='page' in options;segments=[]
 def excerpt(value,limit):
  data=value.encode('utf-8')
  if len(data)<=limit: return value,False
  # Decode only complete characters; the digest and byte count bind the omitted bytes.
  head=data[:limit//2].decode('utf-8','ignore')
  tail=data[-(limit//2):].decode('utf-8','ignore')
  return head+'\n[... sealed excerpt omitted ...]\n'+tail,True
 for path in sorted(paths,key=lambda p:p.encode('utf-8')):
  source=target.get(path)
  source_data=None
  for objectid in ([base_entries[path]] if path in base_entries else [])+([source['oid']] if source else []):
   data=git('cat-file','blob',objectid)
   if b'\0' in data: raise ValueError('binary review file')
   data.decode('utf-8','strict')
   if source and objectid==source['oid']: source_data=data
  if 'data' in locals(): del data
  # Modified blobs always select the complete diff. Drop their source copy
  # before Git starts streaming, leaving room for retained earlier files.
  if source and path in base_entries and source['oid']!=base_entries[path]: source_data=None
  diff_segments=[]
  def record_diff(index,start,end,piece):
   diff_segments.append((index,start,end,hashlib.sha256(piece).hexdigest(),len(json.dumps(piece.decode('utf-8','strict'),ensure_ascii=False).encode('utf-8'))-2))
  diff_segmenter=ReviewSegmenter(record_diff) if paged else None
  diff_bytes,diff_sha,diff_length=review_diff(path,review_base_oid,commit,${ARTIFACT_REVIEW_HELPER_MAX_SELECTED_BYTES},False,diff_segmenter.feed if paged else None)
  if paged: diff_segmenter.finish()
  content_bytes=source_data
  # A target-only snapshot hides removed lines in a modified file. Preserve the
  # complete endpoint diff even when the new blob is shorter; admission rejects
  # a partial diff if the bounded context cannot carry it.
  if diff_length and (path in base_entries or content_bytes is None or diff_length<=len(content_bytes)):
   representation='diff'
  elif content_bytes is not None:
   representation='content'
  else:
   representation='absent' # Changed in history, but absent at both endpoints.
  if representation=='diff' and diff_bytes is None and not paged: raise ValueError('review evidence total byte bound')
  content=(content_bytes if paged else content_bytes.decode('utf-8','strict')) if content_bytes is not None and representation=='content' else None
  diff=(diff_bytes if paged else diff_bytes.decode('utf-8','strict')) if representation=='diff' else None
  files.append({'path':path,'status':'present' if source else 'deleted','baseMode':base_modes.get(path),'mode':source['mode'] if source else None,'sha256':source['sha256'] if source else None,'bytes':source['bytes'] if source else None,'representation':representation,'complete':True,'content':None if paged else content,'contentTruncated':False,'diff':None if paged else diff,'diffSha256':diff_sha,'diffBytes':diff_length,'diffTruncated':False})
  if paged:
   item=files[-1]
   if representation=='diff':
    selected_segments=diff_segments;selected_sha=diff_sha;selected_length=diff_length
   else:
    selected_segments=[]
    def record_selected(index,start,end,piece):
     selected_segments.append((index,start,end,hashlib.sha256(piece).hexdigest(),len(json.dumps(piece.decode('utf-8','strict'),ensure_ascii=False).encode('utf-8'))-2))
    segmenter=ReviewSegmenter(record_selected);raw=content_bytes if representation=='content' else b''
    for offset in range(0,len(raw),65536): segmenter.feed(raw[offset:offset+65536])
    segmenter.finish();selected_sha=hashlib.sha256(raw).hexdigest();selected_length=len(raw)
   selected_used+=selected_length
   if selected_used>${ARTIFACT_REVIEW_MAX_SELECTED_BYTES}: raise ValueError('review evidence total byte bound')
   item['selectedSha256']=selected_sha;item['selectedBytes']=selected_length;item['segmentCount']=len(selected_segments)
   for index,start,end,segment_sha,escaped in selected_segments:
    segments.append((len(files)-1,index,start,end,segment_sha,escaped))
   if time.monotonic()>review_page_deadline: raise ValueError('review page time bound')
  del diff_bytes,content_bytes,source_data,content,diff
 if paged: raw=b'';diff_segments=[];selected_segments=[]
 if 'page' in options:
  page=options['page']
  if type(page)!=int or page<0 or page>=${ARTIFACT_REVIEW_MAX_PAGES} or page%${ARTIFACT_REVIEW_BATCH_PAGES}!=0: raise ValueError('review page')
  identity={'version':3,'scope':'sealed-changed-path-pages','sourceOid':commit,'baseOid':review_base_oid,'sourceBranch':source_branch,'baseBranch':base_branch,'committedTreeDigest':proof['committedTreeDigest'],'manifestDigest':proof['manifestDigest'],'trackedFileCount':proof['entries'],'changedPathCount':len(paths)}
  descriptors=[{key:item[key] for key in ('path','status','baseMode','mode','sha256','bytes','representation','diffSha256','diffBytes')} for item in files]
  # Re-derive each selected file below; retain only one file and the requested
  # batch instead of the aggregate selection inside the 256 MiB helper.
  evidence_sha=hashlib.sha256(json.dumps({'identity':identity,'files':descriptors},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()
  def segment_for(ref,data=''):
   file_index,index,start,end,segment_sha,escaped=ref
   item=files[file_index];selected=item['representation']
   return {'path':item['path'],'status':item['status'],'baseMode':item['baseMode'],'mode':item['mode'],'sha256':item['sha256'],'bytes':item['bytes'],'representation':selected,'diffSha256':item['diffSha256'],'diffBytes':item['diffBytes'],'selectedSha256':item['selectedSha256'],'selectedBytes':item['selectedBytes'],'segmentIndex':index,'segmentCount':item['segmentCount'],'data':data,'segmentSha256':segment_sha}
  pages=[];current=[]
  def encoded_page(parts,index,total):
   return json.dumps({**identity,'evidenceSha256':evidence_sha,'pageIndex':index,'pageCount':total,'segments':parts},sort_keys=True,separators=(',',':'),ensure_ascii=False)
  def estimated_page_size(refs):
   return len(encoded_page([segment_for(ref) for ref in refs],65535,65535).encode('utf-8'))+sum(ref[5] for ref in refs)
  for segment in segments:
   if current and estimated_page_size(current+[segment])>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}:
    pages.append(current);current=[]
   if estimated_page_size([segment])>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}: raise ValueError('review segment metadata bound')
   current.append(segment)
  if current: pages.append(current)
  if not pages or len(pages)>${ARTIFACT_REVIEW_MAX_PAGES} or page>=len(pages): raise ValueError('review page unavailable')
  digest=hashlib.sha256();digest.update(b'[');selected_pages=[];state={'cursor':0,'pageIndex':0,'parts':[]};active_file=[-1]
  def replay_segment(index,start,end,piece):
   cursor=state['cursor']
   if cursor>=len(segments): raise ValueError('review segment count changed during paging')
   ref=segments[cursor]
   if ref[:4]!=(active_file[0],index,start,end) or hashlib.sha256(piece).hexdigest()!=ref[4] or len(json.dumps(piece.decode('utf-8','strict'),ensure_ascii=False).encode('utf-8'))-2!=ref[5]: raise ValueError('review segment changed during paging')
   state['parts'].append(segment_for(ref,piece.decode('utf-8','strict')))
   state['cursor']=cursor+1
   page_index=state['pageIndex']
   if len(state['parts'])==len(pages[page_index]):
    encoded=encoded_page(state['parts'],page_index,len(pages))
    if len(encoded.encode('utf-8'))>${ARTIFACT_REVIEW_CONTEXT_MAX_BYTES}: raise ValueError('review page byte bound')
    if page_index: digest.update(b',')
    digest.update(json.dumps(encoded,separators=(',',':'),ensure_ascii=False).encode('utf-8'))
    if page<=page_index<page+${ARTIFACT_REVIEW_BATCH_PAGES}: selected_pages.append(encoded)
    state['pageIndex']=page_index+1;state['parts']=[]
   if time.monotonic()>review_page_deadline: raise ValueError('review page time bound')
  for file_index,item in enumerate(files):
   active_file[0]=file_index;segmenter=ReviewSegmenter(replay_segment)
   if item['representation']=='diff':
    _,actual_sha,actual_size=review_diff(item['path'],review_base_oid,commit,${ARTIFACT_REVIEW_MAX_SELECTED_BYTES},False,segmenter.feed)
   elif item['representation']=='content':
    source=target[item['path']];raw=git('cat-file','blob',source['oid']);actual_sha=hashlib.sha256(raw).hexdigest();actual_size=len(raw)
    for offset in range(0,len(raw),65536): segmenter.feed(raw[offset:offset+65536])
    raw=b''
   else: actual_sha=hashlib.sha256(b'').hexdigest();actual_size=0
   segmenter.finish()
   if actual_sha!=item['selectedSha256'] or actual_size!=item['selectedBytes']: raise ValueError('review selection changed during paging')
  if state['cursor']!=len(segments) or state['pageIndex']!=len(pages): raise ValueError('review page count changed')
  digest.update(b']');pages_digest=digest.hexdigest()
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
