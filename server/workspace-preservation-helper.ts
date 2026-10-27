/** Descriptor-relative opaque copying: never runs Git or repository code, follows
 * no source symlink, and preserves ignored/untracked files and the complete
 * independent Git store. Every copied tree is read back and restored to scratch
 * before a verified receipt can be issued. */
export const workspacePreservationProgram = String.raw`
import ctypes,hashlib,json,os,stat,sys
r=json.load(sys.stdin)
maximum_files=r.get('maximumFiles',100000)
maximum_bytes=r.get('maximumBytes',2147483648)

def fail(message): raise RuntimeError(message)
def ident(s): return {'dev':s.st_dev,'ino':s.st_ino}
def signature(s): return (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def opened(path, expected=None):
    if not os.path.isabs(path) or os.path.realpath(path)!=path: fail('Canonical directory required')
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    if expected is not None and ident(os.fstat(fd))!=expected:
        os.close(fd); fail('Workspace identity changed')
    return fd

def rename_exclusive(source_fd,source_name,destination_fd,destination_name):
    # Platform no-replace primitives atomically reject even an empty directory
    # created after validation. An exists-check followed by rename can clobber it.
    libc=ctypes.CDLL(None,use_errno=True)
    if sys.platform=='darwin':
        rename=libc.renameatx_np; flags=4 # RENAME_EXCL, Darwin stdio.h
    elif sys.platform.startswith('linux'):
        rename=libc.renameat2; flags=1 # RENAME_NOREPLACE, Linux renameat2(2)
    else: fail('Exclusive directory publication unsupported on this platform')
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    rename.restype=ctypes.c_int
    if rename(source_fd,os.fsencode(source_name),destination_fd,os.fsencode(destination_name),flags)!=0:
        error=ctypes.get_errno(); raise OSError(error,os.strerror(error))

def capture(path,destination=None,expected=None):
    source=opened(path,expected)
    target=None
    if destination is not None:
        os.mkdir(destination,0o700); target=opened(destination)
    records=[]; total=0
    def walk(fd,out,prefix):
        nonlocal total
        before=os.fstat(fd); names=sorted(os.listdir(fd))
        for name in names:
            relative=prefix+name
            s=os.stat(name,dir_fd=fd,follow_symlinks=False)
            mode=stat.S_IMODE(s.st_mode)
            git='/'+relative
            inside_git='/.git/' in git or relative=='.git'
            if name=='.git' and not stat.S_ISDIR(s.st_mode): fail('Retirement requires an independent Git store')
            if inside_git and (name=='commondir' or stat.S_ISLNK(s.st_mode)): fail('Retirement requires an independent Git store')
            record={'path':relative,'mode':mode}
            if stat.S_ISDIR(s.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                copy=None
                try:
                    if signature(os.fstat(child))!=signature(s): fail('Source changed during archive')
                    if out is not None:
                        os.mkdir(name,0o700,dir_fd=out); copy=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=out)
                    record['kind']='directory'; records.append(record)
                    if len(records)>maximum_files: fail('Archive entry limit exceeded')
                    walk(child,copy,relative+'/')
                    if copy is not None: os.fchmod(copy,mode)
                finally:
                    os.close(child)
                    if copy is not None: os.close(copy)
            elif stat.S_ISREG(s.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd); copy=None
                try:
                    if signature(os.fstat(child))!=signature(s): fail('Source changed during archive')
                    if out is not None: copy=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=out)
                    h=hashlib.sha256(); length=0
                    while True:
                        data=os.read(child,1048576)
                        if not data: break
                        length+=len(data); total+=len(data)
                        if total>maximum_bytes: fail('Archive byte limit exceeded')
                        h.update(data)
                        if copy is not None:
                            offset=0
                            while offset<len(data): offset+=os.write(copy,data[offset:])
                    if signature(os.fstat(child))!=signature(s) or length!=s.st_size: fail('Source changed during archive')
                    if inside_git and relative.endswith(('/objects/info/alternates','/objects/info/http-alternates')) and length: fail('Retirement requires an independent Git store')
                    if copy is not None: os.fchmod(copy,mode); os.fsync(copy)
                    record.update(kind='file',size=length,sha256=h.hexdigest()); records.append(record)
                finally:
                    os.close(child)
                    if copy is not None: os.close(copy)
            elif stat.S_ISLNK(s.st_mode):
                text=os.readlink(name,dir_fd=fd)
                record.update(kind='symlink',target=text); records.append(record)
                if out is not None: os.symlink(text,name,dir_fd=out)
            else: fail('Unsupported workspace entry; preserve source')
            if len(records)>maximum_files: fail('Archive entry limit exceeded')
            if signature(os.stat(name,dir_fd=fd,follow_symlinks=False))!=signature(s): fail('Source changed during archive')
        if sorted(os.listdir(fd))!=names or signature(os.fstat(fd))!=signature(before): fail('Source directory changed during archive')
        if out is not None: os.fsync(out)
    try: walk(source,target,'')
    finally:
        os.close(source)
        if target is not None: os.close(target)
    payload=json.dumps(records,sort_keys=True,separators=(',',':')).encode('utf-8')
    return {'sha256':hashlib.sha256(payload).hexdigest(),'files':len(records),'bytes':total}

mode=r['mode']
if mode=='archive':
    result=capture(r['source'],r['destination'],r['identity'])
    if capture(r['source'],expected=r['identity'])!=result: fail('Source changed during archive')
    if capture(r['destination'])!=result: fail('Archive verification failed')
elif mode=='verify': result=capture(r['source'],expected=r.get('identity'))
elif mode=='remove':
    if capture(r['source'],expected=r['identity'])!=r['proof']: fail('Workspace changed after preservation')
    path=r['source']; parent=os.path.dirname(path); name=os.path.basename(path)
    parent_fd=opened(parent); source=opened(path,r['identity'])
    retained=r['retainedSource']; archive_fd=opened(os.path.dirname(retained))
    retained_name=os.path.basename(retained)
    try:
        if retained_name!='retained-source' or os.fstat(parent_fd).st_dev!=os.fstat(archive_fd).st_dev:
            fail('Retirement requires an owned same-filesystem archive')
        try: os.stat(retained_name,dir_fd=archive_fd,follow_symlinks=False)
        except FileNotFoundError: pass
        else: fail('Retained source already exists; reconcile original operation')
        if ident(os.stat(name,dir_fd=parent_fd,follow_symlinks=False))!=r['identity']:
            fail('Workspace identity changed before retirement')
        # An archive proof cannot fence editors holding open files. Keep the
        # original inode tree, including writes after proof, rather than unlink
        # entries based on fresh stats that were never covered by the archive.
        rename_exclusive(parent_fd,name,archive_fd,retained_name)
        if ident(os.stat(retained_name,dir_fd=archive_fd,follow_symlinks=False))!=r['identity']:
            fail('Workspace identity changed during retirement; retain both trees')
        os.fsync(archive_fd); os.fsync(parent_fd)
    finally: os.close(source); os.close(parent_fd); os.close(archive_fd)
    result=r['proof']
elif mode=='publish':
    if capture(r['source'],expected=r['identity'])!=r['proof']: fail('Archive restoration failed')
    source=r['source']; destination=r['destination']
    source_parent=opened(os.path.dirname(source)); destination_parent=opened(os.path.dirname(destination))
    source_fd=opened(source,r['identity'])
    try:
        name=os.path.basename(source); target=os.path.basename(destination)
        if ident(os.stat(name,dir_fd=source_parent,follow_symlinks=False))!=r['identity']:
            fail('Restoration scratch identity changed')
        rename_exclusive(source_parent,name,destination_parent,target)
        if ident(os.stat(target,dir_fd=destination_parent,follow_symlinks=False))!=r['identity']:
            fail('Restored workspace identity changed; retain both trees')
        os.fsync(destination_parent); os.fsync(source_parent)
    finally: os.close(source_fd); os.close(destination_parent); os.close(source_parent)
    result=r['proof']
elif mode=='restore':
    if capture(r['source'])!=r['proof']: fail('Archive verification failed')
    result=capture(r['source'],r['destination'])
    if result!=r['proof'] or capture(r['destination'])!=result: fail('Archive restoration failed')
else: fail('Unsupported preservation operation')
print(json.dumps(result,separators=(',',':')))
`;
