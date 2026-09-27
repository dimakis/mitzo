/** Passed as a literal argv value to isolated Python, never evaluated by a shell.
 * The production caller fixes root and budgets. No Git, imports from artifacts,
 * repository hooks, network, or filesystem mutation occurs here.
 */
export const ARTIFACT_SCANNER = String.raw`
import os, sys, stat, hashlib, json, time
root, max_entries, max_bytes, seconds = sys.argv[1:]
max_entries, max_bytes = int(max_entries), int(max_bytes)
deadline = time.monotonic() + float(seconds)
entries = 0
total = 0
result = []
def check():
    if time.monotonic() > deadline:
        raise RuntimeError('artifact scan timeout')
def stamp(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
def walk(fd, prefix):
    global entries, total
    before = os.fstat(fd)
    names = []
    with os.scandir(fd) as children:
        for child in children:
            check()
            entries += 1
            if entries > max_entries:
                raise RuntimeError('artifact entry limit')
            names.append(child.name)
    for name in sorted(names):
        check()
        if name in ('.', '..') or '/' in name or '\\' in name or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in name):
            raise RuntimeError('invalid artifact path')
        path = prefix + name
        if len(path.encode('utf-8')) > 4096:
            raise RuntimeError('artifact path limit')
        s = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(s.st_mode) and not stat.S_ISDIR(s.st_mode):
            raise RuntimeError('unsupported artifact type')
        if prefix == '' and name == '.git':
            if not stat.S_ISDIR(s.st_mode):
                raise RuntimeError('unsupported git metadata')
            continue
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if stat.S_ISDIR(s.st_mode):
            flags |= os.O_DIRECTORY
        child = os.open(name, flags, dir_fd=fd)
        try:
            if stamp(s) != stamp(os.fstat(child)):
                raise RuntimeError('artifact changed while opening')
            if stat.S_ISDIR(s.st_mode):
                if prefix.count('/') >= 64:
                    raise RuntimeError('artifact depth limit')
                walk(child, path + '/')
            else:
                if s.st_nlink != 1:
                    raise RuntimeError('artifact hard link')
                if total + s.st_size > max_bytes:
                    raise RuntimeError('artifact byte limit')
                h = hashlib.sha256()
                size = 0
                while True:
                    check()
                    data = os.read(child, 65536)
                    if not data:
                        break
                    size += len(data)
                    total += len(data)
                    if total > max_bytes:
                        raise RuntimeError('artifact byte limit')
                    h.update(data)
                if size != s.st_size:
                    raise RuntimeError('artifact size changed')
                result.append(dict(path=path, executable=bool(s.st_mode & 0o111), bytes=size, sha256=h.hexdigest()))
            if stamp(s) != stamp(os.fstat(child)) or stamp(s) != stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)):
                raise RuntimeError('artifact changed while scanning')
        finally:
            os.close(child)
    if stamp(before) != stamp(os.fstat(fd)):
        raise RuntimeError('artifact directory changed')
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    walk(fd, '')
finally:
    os.close(fd)
print(json.dumps(sorted(result, key=lambda item: item['path']), ensure_ascii=True, separators=(',', ':')))
`;
