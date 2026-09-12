#!/usr/bin/env python3
"""Strict, portable OpenShell checkpoint archive helper (format v1)."""
import argparse, hashlib, io, json, os, shutil, stat, sys, tarfile, tempfile

FILES = {'.sandbox_migration','goals_1.sqlite','goals_1.sqlite-wal','goals_1.sqlite-shm','installation_id','memories_1.sqlite','memories_1.sqlite-wal','memories_1.sqlite-shm','queue_1.sqlite','queue_1.sqlite-wal','queue_1.sqlite-shm','state_5.sqlite','state_5.sqlite-wal','state_5.sqlite-shm','thread_history_1.sqlite','thread_history_1.sqlite-wal','thread_history_1.sqlite-shm'}
DIRS = {'sessions','archived_sessions','skills'}
VOLATILE = {'tmp','.tmp','thread-writer-locks','logs_2.sqlite','logs_2.sqlite-wal','logs_2.sqlite-shm','shell_snapshots'}
MAX_FILES, MAX_BYTES = 100000, 2*1024*1024*1024

def fail(msg): raise ValueError(msg)
def files(root):
    if os.path.islink(root): fail('symlink blocked')
    out=[]
    for base, dirs, names in os.walk(root, followlinks=False):
        if os.path.islink(base): fail('symlink blocked')
        for name in dirs + names:
            full=os.path.join(base,name)
            if os.path.islink(full): fail('symlink blocked')
        out.append((os.path.relpath(base,root), True, os.lstat(base)))
        for name in names:
            full=os.path.join(base,name); s=os.lstat(full)
            if not stat.S_ISREG(s.st_mode): fail('special file blocked')
            out.append((os.path.relpath(full,root), False, s))
    return sorted(out)
def canonical(root, entries):
    h=hashlib.sha256(); total=0
    if len(entries)>MAX_FILES: fail('too many files')
    for rel,isdir,s in entries:
        h.update(('d' if isdir else 'f').encode()+b'\0'+rel.encode()+b'\0'+str(stat.S_IMODE(s.st_mode)).encode()+b'\0')
        if not isdir:
            total += s.st_size
            if total>MAX_BYTES: fail('archive too large')
            with open(os.path.join(root,rel),'rb') as f: h.update(f.read())
    return h.hexdigest()
def validate_source(source):
    codex=os.path.join(source,'.codex'); work=os.path.join(source,'workspace')
    if not os.path.isdir(codex) or not os.path.isdir(work): fail('source roots missing')
    for name in os.listdir(codex):
        full=os.path.join(codex,name)
        if os.path.islink(full): fail('provider symlink blocked')
        if name in VOLATILE: continue
        if (os.path.isfile(full) and name in FILES) or (os.path.isdir(full) and name in DIRS): continue
        fail('unsupported provider state: '+name)
    for rel, isdir, _ in files(work):
        if not isdir and (rel.startswith('.env') or rel in ('auth.json','credentials.json') or rel.startswith('.aws/') or rel.startswith('.ssh/')):
            fail('credential-like workspace file')
    return codex,work
def validate_source_roots(provider, workspace):
    if not provider or not workspace: fail('provider and workspace roots required')
    root=os.path.dirname(provider) if os.path.basename(provider)=='.codex' else provider
    if provider==os.path.join(root,'.codex') and workspace==os.path.join(root,'workspace'):
        return validate_source(root)
    if not os.path.isdir(provider) or not os.path.isdir(workspace): fail('source roots missing')
    # Fixed runtime roots use the same strict checks through a temporary parent view.
    return provider,workspace
def manifest(args, digest): return {'version':1,'conversation':args.conversation,'thread':args.thread,'binding':args.binding,'image':args.image,'policy':args.policy,'helper':'mitzo-checkpoint-v1','digest':digest}
def capture(args):
    if args.source: codex,work=validate_source(args.source)
    else: codex,work=validate_source_roots(args.provider_root,args.workspace_root)
    stage=tempfile.mkdtemp(prefix='mitzo-checkpoint-',dir=os.path.dirname(args.output) or '.')
    try:
        os.mkdir(os.path.join(stage,'.codex')); os.mkdir(os.path.join(stage,'workspace'))
        for name in os.listdir(codex):
            if name in FILES or name in DIRS: shutil.copytree(os.path.join(codex,name),os.path.join(stage,'.codex',name),symlinks=True) if os.path.isdir(os.path.join(codex,name)) else shutil.copy2(os.path.join(codex,name),os.path.join(stage,'.codex',name))
        shutil.copytree(work,os.path.join(stage,'workspace'),symlinks=True,dirs_exist_ok=True)
        entries=files(stage); m=manifest(args,canonical(stage,entries))
        with tarfile.open(args.output+'.tmp','w') as tar:
            for rel,isdir,_ in entries: tar.add(os.path.join(stage,rel),arcname=rel,recursive=False)
            data=json.dumps(m,sort_keys=True).encode(); info=tarfile.TarInfo('manifest.json'); info.size=len(data); info.mode=0o600; tar.addfile(info,io.BytesIO(data))
        os.chmod(args.output+'.tmp',0o600); os.replace(args.output+'.tmp',args.output); print(json.dumps(m))
    finally: shutil.rmtree(stage,ignore_errors=True)
def read_archive(path):
    with tarfile.open(path,'r') as tar:
        members=tar.getmembers(); names=[m.name for m in members]
        if len(names)>MAX_FILES or len(names)!=len(set(names)) or 'manifest.json' not in names: fail('invalid archive')
        total=0
        for m in members:
            parts=m.name.split('/')
            if m.name not in ('.','./') and (m.name.startswith('/') or '..' in parts or parts[0] not in ('.codex','workspace','manifest.json') or m.islnk() or m.issym() or not (m.isdir() or m.isfile()) or m.mode & ~0o777): fail('unsafe archive member')
            total += m.size
            if total>MAX_BYTES: fail('archive too large')
        raw=tar.extractfile('manifest.json').read(); m=json.loads(raw)
        if len(raw)>65536 or m.get('version')!=1 or m.get('helper')!='mitzo-checkpoint-v1': fail('unsupported manifest')
        stage=tempfile.mkdtemp(prefix='mitzo-restore-')
        try:
            for member in members:
                if member.name=='manifest.json': continue
                target=os.path.join(stage,member.name); parent=os.path.dirname(target); os.makedirs(parent,exist_ok=True)
                if member.isdir(): os.makedirs(target,exist_ok=True); os.chmod(target,member.mode)
                else:
                    with tar.extractfile(member) as src, open(target,'wb') as dst: shutil.copyfileobj(src,dst)
                    os.chmod(target,member.mode)
            if canonical(stage,files(stage)) != m.get('digest'): fail('digest mismatch')
            return m,stage
        except: shutil.rmtree(stage,ignore_errors=True); raise
def identity(m,args):
    for key in ('conversation','thread','binding','image','policy'):
        if m.get(key)!=getattr(args,key): fail('checkpoint identity mismatch')
def verify(args):
    m,stage=read_archive(args.input)
    try: identity(m,args); print(json.dumps(m))
    finally: shutil.rmtree(stage,ignore_errors=True)
def restore(args):
    m,stage=read_archive(args.input)
    try:
        identity(m,args)
        if args.destination:
            if os.path.exists(args.destination): fail('destination exists')
            os.replace(stage,args.destination); stage=None; print(json.dumps(m)); return
        if os.path.exists(args.provider_root) or os.path.exists(args.workspace_root): fail('restore roots already exist')
        os.makedirs(os.path.dirname(args.provider_root),exist_ok=True); os.makedirs(os.path.dirname(args.workspace_root),exist_ok=True)
        os.replace(os.path.join(stage,'.codex'),args.provider_root); os.replace(os.path.join(stage,'workspace'),args.workspace_root); shutil.rmtree(stage); stage=None; print(json.dumps(m))
    finally:
        if stage: shutil.rmtree(stage,ignore_errors=True)
def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    for cmd in ('capture','restore','verify'):
        q=sub.add_parser(cmd); q.add_argument('--input' if cmd!='capture' else '--source'); q.add_argument('--output', required=cmd=='capture'); q.add_argument('--destination'); q.add_argument('--provider-root'); q.add_argument('--workspace-root'); q.add_argument('--conversation',required=True); q.add_argument('--thread',required=True); q.add_argument('--binding',required=True); q.add_argument('--image',required=True); q.add_argument('--policy',required=True)
    a=p.parse_args(); {'capture':capture,'restore':restore,'verify':verify}[a.cmd](a)
if __name__=='__main__':
    try: main()
    except Exception as e: print('checkpoint: '+str(e),file=sys.stderr); sys.exit(2)
