import { execFile } from 'node:child_process';
import {
  projectExclusiveTreeRequest,
  type NativeExclusiveTreeRequest,
} from './native-tree-publication.js';

// Python exposes openat via dir_fd on macOS/Linux. Node has no equivalent API.
// Keep the helper embedded so tsc/deploy cannot omit a required runtime asset.
// No user text is interpolated into source or argv: the request travels over stdin.
const helper = String.raw`
import base64, hashlib, json, os, stat, sys, time

def capture_read_anchor(request):
    path = request['file_path']
    parts = [part for part in path.split('/') if part]
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise RuntimeError('Anchored native reads unavailable')
    if any(path == root or path.startswith(root.rstrip('/') + '/') for root in request['deniedRoots']):
        raise RuntimeError('Anchored read unavailable')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            if time.monotonic() >= deadline:
                raise RuntimeError('Anchored read deadline exceeded')
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        info = os.fstat(directory)
        if not stat.S_ISDIR(info.st_mode) or time.monotonic() >= deadline:
            raise RuntimeError('Anchored read unavailable')
        return json.dumps({'rootPath': path, 'identity': {'dev': str(info.st_dev), 'ino': str(info.st_ino)}})
    except FileNotFoundError:
        # A bounded internal fact, never parsed from pathful OS diagnostics.
        return json.dumps({'missing': True})
    finally:
        os.close(directory)

def create_directory(request):
    # Private fixed effect only: no listing, file bytes, cleanup or Git execution.
    path = request['file_path']
    parts = [part for part in path.split('/') if part]
    anchor = request['rootAnchor']
    root_parts = [part for part in anchor['rootPath'].split('/') if part]
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    def check():
        if time.monotonic() >= deadline:
            raise RuntimeError('Exclusive directory deadline exceeded')
    def matches(info, expected):
        return str(info.st_dev) == expected['dev'] and str(info.st_ino) == expected['ino']
    if os.open not in os.supports_dir_fd or os.mkdir not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise RuntimeError('Exclusive directory unavailable')
    if request['expectedAbsent'] is not True or not parts or parts[:-1][:len(root_parts)] != root_parts:
        raise RuntimeError('Exclusive directory unavailable')
    if any(path == root or path.startswith(root.rstrip('/') + '/') for root in request['deniedRoots']):
        raise RuntimeError('Exclusive directory unavailable')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    child = None
    try:
        if not root_parts and not matches(os.fstat(directory), anchor['identity']):
            raise RuntimeError('Exclusive directory root changed')
        for index, part in enumerate(parts[:-1]):
            check()
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
            if index + 1 == len(root_parts) and not matches(os.fstat(directory), anchor['identity']):
                raise RuntimeError('Exclusive directory root changed')
        if not matches(os.fstat(directory), request['parentIdentity']):
            raise RuntimeError('Exclusive directory parent changed')
        check()
        # mkdirat is exclusive: EEXIST is a refusal, never an adoption path.
        os.mkdir(parts[-1], 0o700, dir_fd=directory)
        child = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        info = os.fstat(child)
        check()
        if not stat.S_ISDIR(info.st_mode) or not matches(os.fstat(directory), request['parentIdentity']):
            raise RuntimeError('Exclusive directory changed')
        return json.dumps({'directory': path, 'identity': {'dev': str(info.st_dev), 'ino': str(info.st_ino)}})
    finally:
        if child is not None:
            os.close(child)
        os.close(directory)

def create_file(request, preflight_only=False, deadline=None, expected_receipt=None):
    # This branch never overwrites, follows links, removes files or runs Git.
    deadline = time.monotonic() + request['timeoutMs'] / 1000 if deadline is None else deadline
    source = request['payload']
    exclusions = request['deniedRoots']
    def check():
        if time.monotonic() >= deadline:
            raise RuntimeError('Exclusive file deadline exceeded')
    def matches(info, expected):
        return str(info.st_dev) == expected['dev'] and str(info.st_ino) == expected['ino']
    def parent(item):
        check()
        path = item['file_path']
        parts = [part for part in path.split('/') if part]
        root = item['rootAnchor']
        root_parts = [part for part in root['rootPath'].split('/') if part]
        if not parts or parts[:-1][:len(root_parts)] != root_parts or any(path == denied or path.startswith(denied.rstrip('/') + '/') for denied in exclusions):
            raise RuntimeError('Exclusive file unavailable')
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if not root_parts and not matches(os.fstat(directory), root['identity']):
                raise RuntimeError('Exclusive file root changed')
            for index, part in enumerate(parts[:-1]):
                check()
                next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = next_directory
                if index + 1 == len(root_parts) and not matches(os.fstat(directory), root['identity']):
                    raise RuntimeError('Exclusive file root changed')
            if not matches(os.fstat(directory), item['parentIdentity']):
                raise RuntimeError('Exclusive file parent changed')
            return directory, parts[-1]
        except:
            os.close(directory)
            raise
    def read_payload(file):
        check()
        payload_info = os.fstat(file)
        if not stat.S_ISREG(payload_info.st_mode) or payload_info.st_nlink != 1 or not matches(payload_info, source['identity']) or payload_info.st_size != source['size'] or not 0 <= payload_info.st_size <= 16 * 1024 * 1024:
            raise RuntimeError('Exclusive file payload unavailable')
        os.lseek(file, 0, os.SEEK_SET)
        data = bytearray()
        while len(data) < payload_info.st_size:
            check()
            chunk = os.read(file, min(65536, payload_info.st_size - len(data)))
            if not chunk:
                raise RuntimeError('Exclusive file payload changed')
            data.extend(chunk)
        after = os.fstat(file)
        if os.read(file, 1) or after.st_size != payload_info.st_size or after.st_mtime_ns != payload_info.st_mtime_ns or after.st_ctime_ns != payload_info.st_ctime_ns or after.st_nlink != 1 or hashlib.sha256(data).hexdigest() != source['sha256']:
            raise RuntimeError('Exclusive file payload changed')
        return data
    source_parent = target_parent = source_file = target_file = None
    try:
        if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW') or request['expectedAbsent'] is not True:
            raise RuntimeError('Exclusive file unavailable')
        source_parent, source_name = parent(source)
        source_file = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        data = read_payload(source_file) # Size/hash BEFORE creating the target.
        target_parent, target_name = parent(request)
        check()
        if expected_receipt is not None:
            target_file = os.open(target_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=target_parent)
            before = os.fstat(target_file)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not matches(before, expected_receipt['identity']) or before.st_size != source['size']:
                raise RuntimeError('Exclusive batch publication changed')
            digest = hashlib.sha256()
            count = 0
            while count < before.st_size:
                check()
                chunk = os.read(target_file, min(65536, before.st_size-count))
                if not chunk: raise RuntimeError('Exclusive batch publication changed')
                count += len(chunk)
                digest.update(chunk)
            after = os.fstat(target_file)
            if os.read(target_file, 1) or after.st_nlink != 1 or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns or digest.hexdigest() != source['sha256']:
                raise RuntimeError('Exclusive batch publication changed')
            # Reopen both ORIGINAL enclosing roots and immediate parents after
            # final byte verification; retained descriptors alone are not paths.
            for item, expected, observed in [(source, source['identity'], os.fstat(source_file)), (request, expected_receipt['identity'], after)]:
                directory, name = parent(item)
                try:
                    binding = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if not stat.S_ISREG(binding.st_mode) or binding.st_nlink != 1 or not matches(binding, expected) or binding.st_size != observed.st_size or binding.st_mtime_ns != observed.st_mtime_ns or binding.st_ctime_ns != observed.st_ctime_ns:
                        raise RuntimeError('Exclusive batch publication changed')
                finally:
                    os.close(directory)
            check()
            return None
        try:
            os.stat(target_name, dir_fd=target_parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError('Exclusive file target exists')
        if preflight_only:
            return None
        target_file = os.open(target_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=target_parent)
        target_info = os.fstat(target_file)
        offset = 0
        while offset < len(data):
            check()
            written = os.write(target_file, data[offset:offset + 65536])
            if written <= 0:
                raise RuntimeError('Exclusive file write failed')
            offset += written
        os.fsync(target_file)
        written_info = os.fstat(target_file)
        os.lseek(target_file, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        copied = 0
        while copied < len(data):
            check()
            chunk = os.read(target_file, min(65536, len(data) - copied))
            if not chunk:
                raise RuntimeError('Exclusive file copy changed')
            copied += len(chunk)
            digest.update(chunk)
        after = os.fstat(target_file)
        if os.read(target_file, 1) or not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or not matches(after, {'dev': str(target_info.st_dev), 'ino': str(target_info.st_ino)}) or after.st_size != len(data) or after.st_mtime_ns != written_info.st_mtime_ns or after.st_ctime_ns != written_info.st_ctime_ns or digest.hexdigest() != source['sha256']:
            raise RuntimeError('Exclusive file copy changed')
        # Verify bytes AND the current path-to-parent/root/file bindings after
        # publication. Pinned descriptors alone do not detect renamed ancestors.
        read_payload(source_file)
        source_after = os.fstat(source_file)
        for item, expected, observed in [(source, source['identity'], source_after), (request, {'dev': str(after.st_dev), 'ino': str(after.st_ino)}, after)]:
            directory, name = parent(item)
            file = None
            try:
                file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                current = os.fstat(file)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or not matches(current, expected) or current.st_size != observed.st_size or current.st_mtime_ns != observed.st_mtime_ns or current.st_ctime_ns != observed.st_ctime_ns:
                    raise RuntimeError('Exclusive file path changed')
            finally:
                if file is not None: os.close(file)
                os.close(directory)
        check()
        return json.dumps({'file_path': request['file_path'], 'identity': {'dev': str(after.st_dev), 'ino': str(after.st_ino)}, 'byteLength': copied, 'sha256': digest.hexdigest()})
    finally:
        for file in [source_file, target_file, source_parent, target_parent]:
            if file is not None: os.close(file)

def publish_tree(request):
    # Entire tree is preflighted before the first target mutation. Never run Git,
    # traverse a symlink, overwrite/adopt an entry or remove uncertain effects.
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    exclusions = request['deniedRoots']
    source = request['payload']
    entries = request['entries']
    def check():
        if time.monotonic() >= deadline:
            raise RuntimeError('Exclusive tree unavailable')
    def matches(info, expected):
        return str(info.st_dev) == expected['dev'] and str(info.st_ino) == expected['ino']
    def open_directory(path, root, expected):
        check()
        parts = [part for part in path.split('/') if part]
        root_parts = [part for part in root['rootPath'].split('/') if part]
        if parts[:len(root_parts)] != root_parts or any(path == denied or path.startswith(denied.rstrip('/') + '/') for denied in exclusions):
            raise RuntimeError('Exclusive tree unavailable')
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if not root_parts and not matches(os.fstat(directory), root['identity']):
                raise RuntimeError('Exclusive tree unavailable')
            for index, part in enumerate(parts):
                check()
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
                if index + 1 == len(root_parts) and not matches(os.fstat(directory), root['identity']):
                    raise RuntimeError('Exclusive tree unavailable')
            if not matches(os.fstat(directory), expected):
                raise RuntimeError('Exclusive tree unavailable')
            return directory
        except:
            os.close(directory)
            raise
    def descend(root, relative, identities):
        directory = os.dup(root)
        try:
            parts = relative.split('/')
            for index, part in enumerate(parts):
                check()
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
                if not matches(os.fstat(directory), identities['/'.join(parts[:index + 1])]):
                    raise RuntimeError('Exclusive tree unavailable')
            return directory
        except:
            os.close(directory)
            raise
    def parent(root, relative, identities):
        parts = relative.split('/')
        return (descend(root, '/'.join(parts[:-1]), identities) if len(parts) > 1 else os.dup(root)), parts[-1]
    def content(parent, name, entry, expected):
        check()
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not matches(before, expected) or before.st_nlink != 1 or before.st_size != entry['size']:
            raise RuntimeError('Exclusive tree unavailable')
        if entry['mode'] == '120000':
            if not stat.S_ISLNK(before.st_mode) or before.st_size > 4096:
                raise RuntimeError('Exclusive tree unavailable')
            # A fixed readlinkat buffer avoids unbounded allocation. Literal
            # link bytes are copied, never resolved or traversed.
            import ctypes
            readlinkat = ctypes.CDLL(None, use_errno=True).readlinkat
            readlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t]
            readlinkat.restype = ctypes.c_ssize_t
            buffer = ctypes.create_string_buffer(4097)
            length = readlinkat(parent, os.fsencode(name), buffer, 4097)
            if length < 0 or length > 4096:
                raise RuntimeError('Exclusive tree unavailable')
            value = buffer.raw[:length]
            if not value or b'\x00' in value:
                raise RuntimeError('Exclusive tree unavailable')
        else:
            if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != (0o755 if entry['mode'] == '100755' else 0o644) or before.st_size > 16 * 1024 * 1024:
                raise RuntimeError('Exclusive tree unavailable')
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                opened = os.fstat(file)
                if not matches(opened, expected) or opened.st_nlink != 1 or opened.st_size != entry['size'] or opened.st_mtime_ns != before.st_mtime_ns or opened.st_ctime_ns != before.st_ctime_ns:
                    raise RuntimeError('Exclusive tree unavailable')
                value = bytearray()
                while len(value) < entry['size']:
                    check()
                    chunk = os.read(file, min(65536, entry['size'] - len(value)))
                    if not chunk:
                        raise RuntimeError('Exclusive tree unavailable')
                    value.extend(chunk)
                after = os.fstat(file)
                if os.read(file, 1) or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns or after.st_ctime_ns != before.st_ctime_ns or after.st_nlink != 1:
                    raise RuntimeError('Exclusive tree unavailable')
            finally:
                os.close(file)
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not matches(after, expected) or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns or after.st_ctime_ns != before.st_ctime_ns or after.st_nlink != 1 or len(value) != entry['size'] or hashlib.sha256(value).hexdigest() != entry['sha256']:
            raise RuntimeError('Exclusive tree unavailable')
        return value
    source_root = target_root = None
    source_dirs = {entry['path']: entry['identity'] for entry in entries if entry['mode'] == '040000'}
    target_dirs = {}
    created = {}
    def verify_shape(root, identities, expected_names):
        for relative in [''] + list(identities):
            directory = descend(root, relative, identities) if relative else os.dup(root)
            try:
                names = set()
                with os.scandir(directory) as children:
                    for child in children:
                        check()
                        if len(names) >= 10000:
                            raise RuntimeError('Exclusive tree unavailable')
                        names.add(child.name)
                if names != expected_names.get(relative, set()):
                    raise RuntimeError('Exclusive tree unavailable')
            finally:
                os.close(directory)
    names = {}
    for entry in entries:
        components = entry['path'].split('/')
        names.setdefault('/'.join(components[:-1]), set()).add(components[-1])
    try:
        if len(entries) > 10000 or os.open not in os.supports_dir_fd or os.mkdir not in os.supports_dir_fd or os.symlink not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
            raise RuntimeError('Exclusive tree unavailable')
        source_root = open_directory(source['file_path'], source['rootAnchor'], source['identity'])
        # Validate original owned source parent as well as staged-root identity.
        source_parent = open_directory(os.path.dirname(source['file_path']), source['rootAnchor'], source['parentIdentity'])
        os.close(source_parent)
        target_root = open_directory(request['file_path'], request['rootAnchor'], request['targetIdentity'])
        target_parent = open_directory(os.path.dirname(request['file_path']),request['rootAnchor'],request['parentIdentity'])
        os.close(target_parent)
        verify_shape(source_root, source_dirs, names)
        verify_shape(target_root, {}, {})
        total = 0
        for entry in entries:
            check()
            if entry['mode'] == '040000':
                directory = descend(source_root, entry['path'], source_dirs)
                os.close(directory)
            else:
                directory, name = parent(source_root, entry['path'], source_dirs)
                try:
                    content(directory, name, entry, entry['identity'])
                finally:
                    os.close(directory)
                total += entry['size']
                if total > 128 * 1024 * 1024:
                    raise RuntimeError('Exclusive tree unavailable')
        # Only now publish, in parent-first order. No foreign directory is ever
        # used as an output parent: every descendant identity is THIS effect's.
        for entry in sorted(entries, key=lambda item: (item['path'].count('/'), item['path'])):
            check()
            destination, name = parent(target_root, entry['path'], target_dirs)
            origin = None
            try:
                if entry['mode'] == '040000':
                    os.mkdir(name, 0o700, dir_fd=destination)
                    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=destination)
                    try:
                        info = os.fstat(directory)
                        target_dirs[entry['path']] = {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
                    finally:
                        os.close(directory)
                else:
                    origin, source_name = parent(source_root, entry['path'], source_dirs)
                    value = content(origin, source_name, entry, entry['identity'])
                    if entry['mode'] == '120000':
                        os.symlink(os.fsdecode(value), name, dir_fd=destination)
                        info = os.stat(name, dir_fd=destination, follow_symlinks=False)
                    else:
                        file = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=destination)
                        try:
                            offset = 0
                            while offset < len(value):
                                check()
                                written = os.write(file, value[offset:offset + 65536])
                                if written <= 0:
                                    raise RuntimeError('Exclusive tree unavailable')
                                offset += written
                            os.fchmod(file, 0o755 if entry['mode'] == '100755' else 0o644)
                            os.fsync(file)
                            info = os.fstat(file)
                        finally:
                            os.close(file)
                    created[entry['path']] = {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
            finally:
                if origin is not None: os.close(origin)
                os.close(destination)
        # Reopen BOTH root bindings and every parent/entry after the copy. An
        # error leaves an uncertain partial tree; this helper cannot clean it.
        for path, root, expected in [(source['file_path'], source['rootAnchor'], source['identity']), (request['file_path'], request['rootAnchor'], request['targetIdentity'])]:
            directory = open_directory(path, root, expected)
            os.close(directory)
        verify_shape(source_root, source_dirs, names)
        verify_shape(target_root, target_dirs, names)
        for entry in entries:
            if entry['mode'] == '040000': continue
            for root, identities, expected in [(source_root, source_dirs, entry['identity']), (target_root, target_dirs, created[entry['path']])]:
                directory, name = parent(root, entry['path'], identities)
                try:
                    content(directory, name, entry, expected)
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if root == target_root and entry['mode'] != '120000' and stat.S_IMODE(info.st_mode) != (0o755 if entry['mode'] == '100755' else 0o644):
                        raise RuntimeError('Exclusive tree unavailable')
                finally:
                    os.close(directory)
        for path, root, expected in [(source['file_path'], source['rootAnchor'], source['identity']), (request['file_path'], request['rootAnchor'], request['targetIdentity'])]:
            directory = open_directory(path, root, expected)
            os.close(directory)
        check()
        return json.dumps({'directory': request['file_path'], 'identity': request['targetIdentity'], 'entries': len(entries), 'byteLength': total})
    finally:
        if source_root is not None: os.close(source_root)
        if target_root is not None: os.close(target_root)

def anchored_read(request, deadline=None, budget=None):
    deadline = time.monotonic() + request['timeoutMs'] / 1000 if deadline is None else deadline
    output_limit = 6 * 1024 * 1024 if budget is None else budget['remaining']
    def check():
        if time.monotonic() >= deadline:
            raise RuntimeError('Anchored read deadline exceeded')
    def parts(path):
        if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or len(path.encode('utf-8')) > 4096:
            raise RuntimeError('Invalid anchored read path')
        result = [part for part in path.split('/') if part]
        if len(result) > 128 or any(part in ('.', '..') for part in result):
            raise RuntimeError('Anchored read path depth exceeded')
        return result
    def matches(target_stat, expected):
        return str(target_stat.st_dev) == expected['dev'] and str(target_stat.st_ino) == expected['ino']
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW') or os.scandir not in os.supports_fd:
        raise RuntimeError('Anchored native reads unavailable')
    path_parts = parts(request['file_path'])
    anchor = request['rootAnchor']
    root_parts = parts(anchor['rootPath'])
    if path_parts[:len(root_parts)] != root_parts or (not path_parts and request['operation'] != 'ListDirectory'):
        raise RuntimeError('Anchored read outside captured root')
    operation = request['operation']
    exclusions = request['deniedRoots']
    def excluded(path):
        return any(path == root or path.startswith(root.rstrip('/') + '/') for root in exclusions)
    if excluded(request['file_path']):
        raise RuntimeError('Anchored read unavailable')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    file = None
    try:
        if not root_parts and not matches(os.fstat(directory), anchor['identity']):
            raise RuntimeError('Captured read root changed')
        for index, part in enumerate(path_parts[:-1]):
            check()
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
            # Do not stat/list/open any descendant until the immutable authorized
            # root has been recognized through its pinned descriptor.
            if index + 1 == len(root_parts) and not matches(os.fstat(directory), anchor['identity']):
                raise RuntimeError('Captured read root changed')
        if len(path_parts) > len(root_parts) and not matches(os.fstat(directory), request['parentIdentity']):
            raise RuntimeError('Captured read parent changed')
        if operation == 'ReadLink':
            if os.stat not in os.supports_dir_fd or os.readlink not in os.supports_dir_fd:
                raise RuntimeError('Anchored native reads unavailable')
            before = os.stat(path_parts[-1], dir_fd=directory, follow_symlinks=False)
            if len(path_parts) == len(root_parts) or not matches(before, request['identity']) or not stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
                raise RuntimeError('Captured link changed')
            expected = request.get('expectedState')
            if expected is not None and (before.st_size != expected['size'] or str(before.st_mtime_ns) != expected['mtimeNs'] or str(before.st_ctime_ns) != expected['ctimeNs']):
                raise RuntimeError('Captured link state changed')
            if before.st_size > request['limit']:
                raise RuntimeError('Anchored byte limit exceeded')
            check()
            # Python os.readlink has no buffer bound. Use the same platform's
            # readlinkat with a fixed 4097-byte buffer before any target decoding.
            import ctypes
            readlinkat = ctypes.CDLL(None, use_errno=True).readlinkat
            readlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t]
            readlinkat.restype = ctypes.c_ssize_t
            buffer = ctypes.create_string_buffer(request['limit'] + 1)
            length = readlinkat(directory, os.fsencode(path_parts[-1]), buffer, request['limit'] + 1)
            if length < 0 or length > request['limit']:
                raise RuntimeError('Anchored link unavailable')
            text = buffer.raw[:length]
            after = os.stat(path_parts[-1], dir_fd=directory, follow_symlinks=False)
            if len(text) > request['limit'] or not matches(after, request['identity']) or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns or after.st_nlink != 1:
                raise RuntimeError('Captured link changed')
            check()
            return base64.b64encode(text).decode('ascii')
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if operation == 'ListDirectory':
            flags |= os.O_DIRECTORY
        file = os.dup(directory) if not path_parts else os.open(path_parts[-1], flags, dir_fd=directory)
        target_stat = os.fstat(file)
        if len(path_parts) == len(root_parts) and not matches(target_stat, anchor['identity']):
            raise RuntimeError('Captured read root changed')
        if not matches(target_stat, request['identity']):
            raise RuntimeError('Captured read target changed')
        if operation == 'ListDirectory':
            if not stat.S_ISDIR(target_stat.st_mode):
                raise RuntimeError('Anchored directory required')
            entries = []
            name_bytes = 0
            scanned = 0
            incomplete = False
            with os.scandir(file) as iterator:
                for entry in iterator:
                    check()
                    name_bytes += len(entry.name.encode('utf-8', errors='strict'))
                    scanned += 1
                    if budget is not None:
                        budget['entries'] += 1
                        budget['names'] += len(entry.name.encode('utf-8', errors='strict'))
                        if budget['entries'] > 10000 or budget['names'] > 1024 * 1024:
                            raise RuntimeError('Anchored directory batch unavailable')
                    if scanned > request['maxEntries'] or name_bytes > request['maxNameBytes'] or (len(entries) + 1) * 512 + name_bytes * 6 > output_limit:
                        raise RuntimeError('Anchored directory limit exceeded')
                    if excluded(os.path.join(request['file_path'], entry.name)):
                        incomplete = True
                        continue
                    child = entry.stat(follow_symlinks=False)
                    kind = 'file' if stat.S_ISREG(child.st_mode) else 'directory' if stat.S_ISDIR(child.st_mode) else 'unsupported'
                    entries.append({'name': entry.name, 'identity': {'dev': str(child.st_dev), 'ino': str(child.st_ino)}, 'kind': kind, 'size': child.st_size, 'mode': child.st_mode, 'nlink': child.st_nlink, 'mtimeNs': str(child.st_mtime_ns), 'ctimeNs': str(child.st_ctime_ns)})
            after = os.fstat(file)
            if target_stat.st_mtime_ns != after.st_mtime_ns or target_stat.st_ctime_ns != after.st_ctime_ns:
                raise RuntimeError('Anchored directory changed')
            content = json.dumps({'identity': request['identity'], 'entries': entries, 'truncated': False, 'incomplete': incomplete}, ensure_ascii=True)
            if len(content.encode('utf-8')) > output_limit:
                raise RuntimeError('Anchored directory output limit exceeded')
            return content
        if not stat.S_ISREG(target_stat.st_mode) or target_stat.st_nlink != 1:
            raise RuntimeError('Anchored read requires an unaliased regular file')
        expected_state = request.get('expectedState')
        if expected_state is not None and (target_stat.st_size != expected_state['size'] or str(target_stat.st_mtime_ns) != expected_state['mtimeNs'] or str(target_stat.st_ctime_ns) != expected_state['ctimeNs']):
            raise RuntimeError('Captured read state changed')
        prefix = request.get('prefix', False)
        if target_stat.st_size > request['limit'] and not prefix:
            raise RuntimeError('Anchored byte limit exceeded')
        read_size = min(target_stat.st_size, request['limit'])
        data = bytearray()
        while len(data) < read_size:
            check()
            chunk = os.read(file, min(65536, read_size - len(data)))
            if not chunk:
                raise RuntimeError('Anchored file changed')
            data.extend(chunk)
        after = os.fstat(file)
        if target_stat.st_size != after.st_size or target_stat.st_mtime_ns != after.st_mtime_ns or target_stat.st_ctime_ns != after.st_ctime_ns or after.st_nlink != 1:
            raise RuntimeError('Anchored file changed')
        encoded = base64.b64encode(data).decode('ascii')
        return json.dumps({'bytes': encoded, 'truncated': len(data) < target_stat.st_size}) if prefix else encoded
    finally:
        if file is not None:
            os.close(file)
        os.close(directory)

def execute(request):
    if request['operation'] == 'CreateFileBatch':
        items = request['items']
        if not isinstance(items, list) or not 1 <= len(items) <= 6:
            raise RuntimeError('Exclusive file batch unavailable')
        deadline = time.monotonic() + request['timeoutMs'] / 1000
        # ALL payload bytes, identities, enclosing roots, parents and actual
        # target absences qualify before the first exclusive write. Every write
        # rechecks its binding; a later race retains partial uncertainty.
        for item in items:
            create_file(dict(item, timeoutMs=request['timeoutMs']), True, deadline)
        results = []
        for item in items:
            results.append(json.loads(create_file(dict(item, timeoutMs=request['timeoutMs']), False, deadline)))
        for item, receipt in zip(items, results):
            create_file(dict(item, timeoutMs=request['timeoutMs']), False, deadline, receipt)
        if time.monotonic() >= deadline:
            raise RuntimeError('Exclusive file batch unavailable')
        content = json.dumps(results, ensure_ascii=True)
        if len(content.encode('utf-8')) > 16384:
            raise RuntimeError('Exclusive file batch unavailable')
        return content
    if request['operation'] == 'ListDirectoryBatch':
        items = request['items']
        if not isinstance(items, list) or not 1 <= len(items) <= 8 or len({item['file_path'] for item in items}) != len(items) or any(item['operation'] != 'ListDirectory' for item in items):
            raise RuntimeError('Anchored directory batch unavailable')
        deadline = time.monotonic() + request['timeoutMs'] / 1000
        # Two levels of JSON string escaping remain below the SAME 8MiB
        # encoded envelope cap. Bound allocation before each directory entry.
        budget = {'remaining': 2 * 1024 * 1024 - 1024, 'entries': 0, 'names': 0}
        results = []
        for item in items:
            if time.monotonic() >= deadline:
                raise RuntimeError('Anchored directory batch unavailable')
            content = anchored_read(dict(item, deniedRoots=request['deniedRoots']), deadline, budget)
            budget['remaining'] -= len(content.encode('utf-8'))
            if budget['remaining'] < 0:
                raise RuntimeError('Anchored directory batch unavailable')
            results.append(content)
        if time.monotonic() >= deadline:
            raise RuntimeError('Anchored directory batch unavailable')
        return json.dumps(results, ensure_ascii=True)
    if request['operation'] == 'PublishTree':
        return publish_tree(request)
    if request['operation'] == 'CreateDirectory':
        return create_directory(request)
    if request['operation'] == 'CreateFile':
        return create_file(request)
    if request['operation'] == 'CaptureReadAnchor':
        return capture_read_anchor(request)
    if request['operation'] in ('ReadBytes', 'ListDirectory', 'ReadLink'):
        return anchored_read(request)
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise RuntimeError('Descriptor-relative native file operations are unavailable')
    path = request['file_path']
    parts = path.split('/')
    if not path.startswith('/') or any(p in ('.', '..') for p in parts):
        raise RuntimeError('Invalid canonical native file path')
    parts = [p for p in parts if p]
    if not parts:
        raise RuntimeError('Native tools require a regular file')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    file = None
    try:
        # Each lookup is relative to the pinned parent, including after a rename.
        # O_NOFOLLOW is applied to EVERY component, not only the final filename.
        for part in parts[:-1]:
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        parent = os.fstat(directory)
        expected_parent = request['parentIdentity']
        if str(parent.st_dev) != expected_parent['dev'] or str(parent.st_ino) != expected_parent['ino']:
            raise RuntimeError('Approved parent directory changed; retry the tool')
        operation = request['operation']
        flags = os.O_NOFOLLOW | os.O_NONBLOCK
        if operation == 'Read':
            flags |= os.O_RDONLY
        elif operation == 'Write':
            flags |= os.O_WRONLY
        elif operation == 'Edit':
            flags |= os.O_RDWR
        else:
            raise RuntimeError('Unsupported native file operation')
        expected = request['identity']
        if expected is None:
            if operation != 'Write':
                raise RuntimeError('Approved file does not exist')
            file = os.open(parts[-1], flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        else:
            file = os.open(parts[-1], flags, dir_fd=directory)
        info = os.fstat(file)
        if expected is not None and (str(info.st_dev) != expected['dev'] or str(info.st_ino) != expected['ino']):
            raise RuntimeError('Approved file identity changed; retry the tool')
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError('Native tools require a regular file with no hard-link aliases')
        if operation != 'Write':
            limit = request['limit']
            data = bytearray()
            while len(data) <= limit:
                chunk = os.read(file, min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) > limit:
                raise RuntimeError('File exceeds native read/edit size limit')
            content = data.decode('utf-8', errors='replace')
            if operation == 'Read':
                return content
            old = request['old_string']
            # Match the existing JS semantics, including overlapping occurrences.
            if content.find(old) < 0 or content.find(old) != content.rfind(old):
                raise RuntimeError('Edit requires exactly one matching occurrence')
            content = content.replace(old, request['new_string'], 1)
        else:
            content = request['content']
        data = content.encode('utf-8')
        os.lseek(file, 0, os.SEEK_SET)
        offset = 0
        while offset < len(data):
            written = os.write(file, data[offset:])
            if written <= 0:
                raise RuntimeError('Native file write made no progress')
            offset += written
        os.ftruncate(file, len(data))
        return 'File written' if operation == 'Write' else 'File edited'
    finally:
        if file is not None:
            os.close(file)
        os.close(directory)

request = None
try:
    request = json.load(sys.stdin)
    envelope = json.dumps({'content': execute(request), 'is_error': False})
    if request['operation'] == 'ListDirectoryBatch' and len((envelope + '\n').encode('utf-8')) > 8 * 1024 * 1024:
        raise RuntimeError('Anchored directory batch unavailable')
    if request['operation'] in ('CreateFile', 'PublishTree') and len((envelope + '\n').encode('utf-8')) > 32768:
        raise RuntimeError('Exclusive file unavailable')
    print(envelope)
except Exception as error:
    # OS errors may contain filenames, but never file contents or request payloads.
    content = 'Exclusive file unavailable' if isinstance(request, dict) and request.get('operation') in ('CreateFile', 'PublishTree') else ('Anchored directory batch unavailable' if isinstance(request, dict) and request.get('operation') == 'ListDirectoryBatch' else str(error))
    print(json.dumps({'content': content, 'is_error': True}))
`;

/** Private transport of the SAME fixed helper through an existing enforced
 * owner. Supplying it never permits fallback to the direct host runner. */
export type NativeFileHelperTransport = (request: {
  command: string;
  /** Bounded original fixed-helper arguments, never an arbitrary program. */
  requestJson: string;
  maxOutputBytes: number;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<{ stdout: string; isError: boolean }>;

function helperCommand(requestJson: string) {
  const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
  return `/usr/bin/printf '%s' ${quote(requestJson)} | /usr/bin/python3 -I -c ${quote(helper)}`;
}

/** Narrow private runner input: the program is always this embedded helper.
 * Legacy/public file or arbitrary shell operations cannot select this branch. */
export function projectPrivateNativeFileHelperRequest(requestJson: string): string {
  if (typeof requestJson !== 'string' || Buffer.byteLength(requestJson) > 128 * 1024)
    throw Error('Private file helper unavailable');
  const request = JSON.parse(requestJson);
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    JSON.stringify(request) !== requestJson ||
    !['CreateFile', 'CreateDirectory', 'PublishTree', 'CreateFileBatch'].includes(
      request.operation,
    ) ||
    request.identity !== null ||
    request.limit !== 1 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 30000 ||
    Object.keys(request).some(
      (key) =>
        ![
          'operation',
          'identity',
          'file_path',
          'limit',
          'parentIdentity',
          'rootAnchor',
          'payload',
          'entries',
          'items',
          'originalSourcePath',
          'targetIdentity',
          'expectedAbsent',
          'deniedRoots',
          'timeoutMs',
        ].includes(key),
    )
  )
    throw Error('Private file helper unavailable');
  let projected:
    | NativeExclusiveDirectoryRequest
    | NativeExclusiveFileRequest
    | NativeExclusiveTreeRequest
    | NativeExclusiveFileBatchRequest;
  if (request.operation === 'CreateFileBatch')
    projected = projectExclusiveFileBatchRequest(request);
  else if (request.operation === 'PublishTree') projected = projectExclusiveTreeRequest(request);
  else if (request.operation === 'CreateFile') projected = projectExclusiveFileRequest(request);
  else {
    if (
      !validNativeReadPath(request.file_path) ||
      !validNativeReadPath(request.rootAnchor?.rootPath) ||
      !validExclusiveIdentity(request.rootAnchor?.identity) ||
      !validExclusiveIdentity(request.parentIdentity) ||
      request.expectedAbsent !== true ||
      request.file_path === request.rootAnchor.rootPath ||
      !request.file_path.startsWith(
        request.rootAnchor.rootPath === '/' ? '/' : request.rootAnchor.rootPath + '/',
      )
    )
      throw Error('Private file helper unavailable');
    const denied = freezeNativeReadExclusions(request.deniedRoots);
    if (
      denied.some(
        (path) =>
          request.file_path === path ||
          request.file_path.startsWith(path === '/' ? '/' : path + '/'),
      )
    )
      throw Error('Private file helper unavailable');
    if ('payload' in request) throw Error('Private file helper unavailable');
    projected = {
      file_path: request.file_path,
      rootAnchor: {
        rootPath: request.rootAnchor.rootPath,
        identity: { dev: request.rootAnchor.identity.dev, ino: request.rootAnchor.identity.ino },
      },
      parentIdentity: { dev: request.parentIdentity.dev, ino: request.parentIdentity.ino },
      expectedAbsent: true,
      deniedRoots: denied,
    };
  }
  return JSON.stringify({
    ...projected,
    operation: request.operation,
    identity: null,
    limit: 1,
    timeoutMs: request.timeoutMs,
  });
}
export function privateNativeFileHelperCommand(requestJson: string) {
  const command = helperCommand(projectPrivateNativeFileHelperRequest(requestJson));
  if (Buffer.byteLength(command) > 192 * 1024) throw Error('Private file helper unavailable');
  return command;
}

export function executeNativeFileOperation(
  request: {
    operation: string;
    identity: { dev: string; ino: string } | null;
    parentIdentity: { dev: string; ino: string };
    file_path: string;
    limit: number;
    content?: string;
    old_string?: string;
    new_string?: string;
    /** Private CaptureReadAnchor arguments, never legacy model-tool options. */
    deniedRoots?: readonly string[];
    timeoutMs?: number;
    rootAnchor?: NativeReadAnchor;
    expectedAbsent?: true;
    payload?: NativeExclusiveFilePayload | NativeExclusiveTreeRequest['payload'];
    entries?: NativeExclusiveTreeRequest['entries'];
    originalSourcePath?: string;
    targetIdentity?: NativeReadIdentity;
    items?: readonly NativeDirectoryVerificationItem[] | readonly NativeExclusiveFileRequest[];
  },
  signal: AbortSignal,
  timeoutMs = 30_000,
  privateTransport?: NativeFileHelperTransport,
): Promise<{ content: string; is_error: boolean }> {
  signal.throwIfAborted();
  if (
    [
      'CreateDirectory',
      'CreateFile',
      'CreateFileBatch',
      'PublishTree',
      'ListDirectoryBatch',
    ].includes(request.operation) &&
    typeof privateTransport !== 'function'
  )
    return Promise.reject(Error('Private helper transport unavailable'));
  const maxBuffer = [
    'CaptureReadAnchor',
    'CreateDirectory',
    'CreateFile',
    'CreateFileBatch',
    'PublishTree',
  ].includes(request.operation)
    ? 32768
    : ['ListDirectory', 'ListDirectoryBatch'].includes(request.operation)
      ? 8 * 1024 * 1024
      : request.operation === 'ReadBytes'
        ? Math.ceil(request.limit / 3) * 4 + 1024
        : Math.max(1024 * 1024, request.limit * 12 + 1024);
  const decode = (stdout: string, canonical = false) => {
    const result: unknown = JSON.parse(stdout);
    if (
      !result ||
      typeof result !== 'object' ||
      !('content' in result) ||
      typeof result.content !== 'string' ||
      !('is_error' in result) ||
      typeof result.is_error !== 'boolean' ||
      Object.keys(result).length !== 2
    )
      throw new Error('Invalid native file helper response');
    if (canonical) {
      // This fixed helper emits exactly one Python json.dumps envelope plus LF.
      // Check its complete encoding: JSON.parse alone accepts duplicate keys and
      // could silently replace a helper failure flag with a later success flag.
      const content = JSON.stringify(result.content).replace(
        /[\u007f-\uffff]/g,
        (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
      );
      if (stdout !== `{"content": ${content}, "is_error": ${result.is_error}}\n`)
        throw Error('Invalid native file helper response');
    }
    return { content: result.content, is_error: result.is_error };
  };
  if (privateTransport !== undefined) {
    if (typeof privateTransport !== 'function') throw Error('Private helper transport unavailable');
    const requestJson = ['PublishTree', 'CreateFileBatch'].includes(request.operation)
      ? projectPrivateNativeFileHelperRequest(JSON.stringify(request))
      : JSON.stringify(request);
    const command = ['PublishTree', 'CreateFileBatch'].includes(request.operation)
      ? privateNativeFileHelperCommand(requestJson)
      : helperCommand(requestJson);
    return privateTransport({
      command,
      requestJson,
      signal,
      timeoutMs,
      maxOutputBytes: maxBuffer,
    }).then((result) => {
      signal.throwIfAborted();
      if (
        !result ||
        result.isError !== false ||
        typeof result.stdout !== 'string' ||
        Buffer.byteLength(result.stdout) > maxBuffer
      )
        throw Error('Private helper transport unavailable');
      return decode(result.stdout, true);
    });
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-I', '-c', helper],
      {
        // Ignore user/site Python configuration and do not inherit provider credentials.
        env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
        signal,
        timeout: timeoutMs,
        maxBuffer,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Native file helper unavailable, cancelled, or failed', { cause: error }),
          );
          return;
        }
        try {
          resolve(decode(stdout));
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin?.on('error', () => {
      /* execFile reports process failure. */
    });
    child.stdin?.end(JSON.stringify(request));
  });
}

export interface NativeReadIdentity {
  readonly dev: string;
  readonly ino: string;
}
export interface NativeReadAnchor {
  readonly rootPath: string;
  readonly identity: NativeReadIdentity;
}
/** Internal absence fact from the qualified capture helper.
 * Missing interpreter/process failures and access refusals remain unavailable. */
export class NativeReadAnchorMissingError extends Error {
  readonly code = 'ENOENT';
  constructor() {
    super('Anchored native read unavailable');
  }
}
export interface NativeAnchoredReadRequest {
  operation: 'ReadBytes' | 'ListDirectory' | 'ReadLink';
  /** Complete actual owner exclusions, never model input or inferred defaults. */
  deniedRoots: readonly string[];
  file_path: string;
  /** Actual owner-captured immutable root; never sourced from model intent. */
  rootAnchor: NativeReadAnchor;
  parentIdentity: NativeReadIdentity;
  identity: NativeReadIdentity;
  limit: number;
  maxEntries?: number;
  maxNameBytes?: number;
  expectedState?: { size: number; mtimeNs: string; ctimeNs: string };
  /** Trusted instruction projection only; callers must expose explicit truncation. */
  prefix?: boolean;
}

export type NativeDirectoryVerificationItem = Omit<
  NativeAnchoredReadRequest,
  'operation' | 'deniedRoots' | 'prefix' | 'expectedState'
> & { readonly operation: 'ListDirectory' };
export interface NativeDirectoryVerificationRequest {
  readonly operation: 'ListDirectoryBatch';
  readonly deniedRoots: readonly string[];
  readonly items: readonly NativeDirectoryVerificationItem[];
}

/** Copy bounded plain data descriptors before any await/lookup. No getters or
 * caller-owned mutable authority can survive into a batch operation. */
function directoryBatchData(value: unknown, depth = 0, count = { value: 0, bytes: 0 }): unknown {
  if (depth > 8 || ++count.value > 4096) throw Error('Invalid directory batch data');
  if (typeof value === 'string' && (count.bytes += Buffer.byteLength(value)) > 128 * 1024)
    throw Error('Invalid directory batch data');
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value))
    return value;
  if (typeof value !== 'object' || Object.getOwnPropertySymbols(value).length)
    throw Error('Invalid directory batch data');
  const array = Array.isArray(value);
  if (array && value.length > 256) throw Error('Invalid directory batch data');
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw Error('Invalid directory batch data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable)
      throw Error('Invalid directory batch data');
    if (array && (!/^\d+$/.test(key) || Number(key) >= 4096))
      throw Error('Invalid directory batch data');
    Object.defineProperty(result, key, {
      value: directoryBatchData(descriptor.value, depth + 1, count),
      enumerable: true,
    });
  }
  if (array && Object.keys(result).length !== (value as unknown[]).length)
    throw Error('Invalid directory batch data');
  return Object.freeze(result);
}

/** Private factory copies original request DATA before per-target owner checks;
 * never invoke a getter or retain caller mutations across those awaits. */
export function freezeNativeDirectoryVerificationInputs(
  value: readonly NativeAnchoredReadRequest[],
): readonly NativeAnchoredReadRequest[] {
  const captured = directoryBatchData(value) as readonly NativeAnchoredReadRequest[];
  if (
    !Array.isArray(captured) ||
    captured.length < 1 ||
    captured.length > 8 ||
    captured.some(
      (item) =>
        !item ||
        item.operation !== 'ListDirectory' ||
        Object.keys(item).some(
          (key) =>
            ![
              'operation',
              'deniedRoots',
              'file_path',
              'rootAnchor',
              'parentIdentity',
              'identity',
              'limit',
              'maxEntries',
              'maxNameBytes',
            ].includes(key),
        ),
    )
  )
    throw Error('Anchored directory batch unavailable');
  return captured;
}

/** Private verification only: no host fallback, mixed operations or partial
 * result. The caller supplies current authority and the existing SRT transport. */
export async function executeNativeDirectoryVerificationBatch(
  request: NativeDirectoryVerificationRequest,
  signal: AbortSignal,
  timeoutMs = 30000,
  privateTransport?: NativeFileHelperTransport,
): Promise<readonly { content: string; is_error: false }[]> {
  const unavailable = () => Error('Anchored directory batch unavailable');
  signal.throwIfAborted();
  try {
    if (
      typeof privateTransport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000
    )
      throw unavailable();
    const captured = directoryBatchData(request) as NativeDirectoryVerificationRequest;
    const keys = (value: object, allowed: readonly string[]) =>
      Object.keys(value).every((key) => allowed.includes(key));
    if (
      !keys(captured, ['operation', 'deniedRoots', 'items']) ||
      captured.operation !== 'ListDirectoryBatch' ||
      !Array.isArray(captured.items) ||
      captured.items.length < 1 ||
      captured.items.length > 8
    )
      throw unavailable();
    const deniedRoots = freezeNativeReadExclusions(captured.deniedRoots);
    const paths = new Set<string>();
    const id = (value: NativeReadIdentity) =>
      value &&
      keys(value, ['dev', 'ino']) &&
      typeof value.dev === 'string' &&
      typeof value.ino === 'string' &&
      /^\d{1,32}$/.test(value.dev) &&
      /^\d{1,32}$/.test(value.ino);
    const bounded = (value: number | undefined, max: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
    for (const item of captured.items) {
      if (
        !item ||
        !keys(item, [
          'operation',
          'file_path',
          'rootAnchor',
          'parentIdentity',
          'identity',
          'limit',
          'maxEntries',
          'maxNameBytes',
        ]) ||
        item.operation !== 'ListDirectory' ||
        !validNativeReadPath(item.file_path) ||
        !item.rootAnchor ||
        !keys(item.rootAnchor, ['rootPath', 'identity']) ||
        !validNativeReadPath(item.rootAnchor.rootPath) ||
        !id(item.rootAnchor.identity) ||
        !id(item.parentIdentity) ||
        !id(item.identity) ||
        item.limit !== 1 ||
        !bounded(item.maxEntries, 10000) ||
        !bounded(item.maxNameBytes, 1024 * 1024) ||
        paths.has(item.file_path) ||
        !(
          item.file_path === item.rootAnchor.rootPath ||
          item.file_path.startsWith(
            item.rootAnchor.rootPath === '/' ? '/' : item.rootAnchor.rootPath + '/',
          )
        ) ||
        deniedRoots.some(
          (root) =>
            item.file_path === root || item.file_path.startsWith(root === '/' ? '/' : root + '/'),
        )
      )
        throw unavailable();
      paths.add(item.file_path);
    }
    const payload = {
      operation: 'ListDirectoryBatch',
      deniedRoots,
      items: captured.items,
      timeoutMs,
      file_path: '/',
      identity: null,
      parentIdentity: { dev: '0', ino: '0' },
      limit: 1,
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > 128 * 1024) throw unavailable();
    const result = await executeNativeFileOperation(payload, signal, timeoutMs, privateTransport);
    signal.throwIfAborted();
    if (result.is_error || Buffer.byteLength(result.content) > 4 * 1024 * 1024) throw unavailable();
    const values: unknown = JSON.parse(result.content);
    if (
      !Array.isArray(values) ||
      values.length !== captured.items.length ||
      values.some((value) => typeof value !== 'string') ||
      values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 2 * 1024 * 1024 - 1024
    )
      throw unavailable();
    return Object.freeze(
      values.map((content, index) => {
        const value = JSON.parse(content);
        if (
          !value ||
          !keys(value, ['identity', 'entries', 'truncated', 'incomplete']) ||
          !id(value.identity) ||
          value.identity.dev !== captured.items[index].identity.dev ||
          value.identity.ino !== captured.items[index].identity.ino ||
          !Array.isArray(value.entries) ||
          value.entries.length > captured.items[index].maxEntries! ||
          value.truncated !== false ||
          typeof value.incomplete !== 'boolean'
        )
          throw unavailable();
        return Object.freeze({ content, is_error: false as const });
      }),
    );
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
}

const validNativeReadPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length <= 4096 &&
  Buffer.byteLength(path) <= 4096 &&
  path.startsWith('/') &&
  !path.includes('\0') &&
  !path.includes('//') &&
  (path === '/' || !path.endsWith('/')) &&
  path.split('/').length <= 129 &&
  !path.split('/').some((part) => part === '.' || part === '..');
/** Private fact projection only; validates and copies, never confers authority. */
export function freezeNativeReadExclusions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256)
    throw Error('Actual read exclusions unavailable');
  let bytes = 0;
  for (const path of value) {
    if (!validNativeReadPath(path) || (bytes += Buffer.byteLength(path)) > 65536)
      throw Error('Actual read exclusions unavailable');
  }
  return Object.freeze([...value]);
}

/** Private directory fact capture only. The original read owner must qualify
 * path access before calling; this identity is neither a grant nor a lease. */
export async function captureNativeReadAnchor(
  request: { file_path: string; deniedRoots: readonly string[] },
  signal: AbortSignal,
  timeoutMs = 30_000,
  privateTransport?: NativeFileHelperTransport,
): Promise<NativeReadAnchor> {
  signal.throwIfAborted();
  const path = request.file_path;
  const unavailable = () => Error('Anchored native read unavailable');
  let deniedRoots: readonly string[];
  try {
    deniedRoots = freezeNativeReadExclusions(request.deniedRoots);
  } catch {
    throw unavailable();
  }
  if (
    !validNativeReadPath(path) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30_000 ||
    deniedRoots.some((root) => path === root || path.startsWith(root === '/' ? '/' : root + '/'))
  )
    throw unavailable();
  try {
    const result = await executeNativeFileOperation(
      {
        operation: 'CaptureReadAnchor',
        file_path: path,
        deniedRoots,
        timeoutMs,
        identity: null,
        parentIdentity: { dev: '0', ino: '0' },
        limit: 1,
      },
      signal,
      timeoutMs,
      privateTransport,
    );
    signal.throwIfAborted();
    if (result.is_error || result.content.length > 8192) throw unavailable();
    if (result.content === '{"missing": true}') throw new NativeReadAnchorMissingError();
    const value: unknown = JSON.parse(result.content);
    if (
      !value ||
      typeof value !== 'object' ||
      !('rootPath' in value) ||
      value.rootPath !== path ||
      !('identity' in value) ||
      !value.identity ||
      typeof value.identity !== 'object' ||
      !('dev' in value.identity) ||
      typeof value.identity.dev !== 'string' ||
      !/^\d{1,32}$/.test(value.identity.dev) ||
      !('ino' in value.identity) ||
      typeof value.identity.ino !== 'string' ||
      !/^\d{1,32}$/.test(value.identity.ino)
    )
      throw unavailable();
    return Object.freeze({
      rootPath: path,
      identity: Object.freeze({ dev: value.identity.dev, ino: value.identity.ino }),
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof NativeReadAnchorMissingError) throw error;
    throw unavailable();
  }
}

/** Private filesystem primitive only. This is not a model tool or a grant. */
export async function executeNativeAnchoredReadOperation(
  request: NativeAnchoredReadRequest,
  signal: AbortSignal,
  timeoutMs = 30_000,
  privateTransport?: NativeFileHelperTransport,
): Promise<{ content: string; is_error: boolean; truncated?: boolean }> {
  signal.throwIfAborted();
  const captured = {
    deniedRoots: request.deniedRoots,
    operation: request.operation,
    file_path: request.file_path,
    rootAnchor: {
      rootPath: request.rootAnchor?.rootPath,
      identity: { dev: request.rootAnchor?.identity?.dev, ino: request.rootAnchor?.identity?.ino },
    },
    identity: { dev: request.identity?.dev, ino: request.identity?.ino },
    parentIdentity: { dev: request.parentIdentity?.dev, ino: request.parentIdentity?.ino },
    limit: request.limit,
    maxEntries: request.maxEntries,
    maxNameBytes: request.maxNameBytes,
    prefix: request.prefix,
    expectedState:
      request.expectedState === undefined
        ? undefined
        : {
            size: request.expectedState.size,
            mtimeNs: request.expectedState.mtimeNs,
            ctimeNs: request.expectedState.ctimeNs,
          },
  };
  const bounded = (value: number | undefined, maximum: number) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maximum;
  if (
    !validNativeReadPath(captured.file_path) ||
    !validNativeReadPath(captured.rootAnchor.rootPath) ||
    !['ReadBytes', 'ListDirectory', 'ReadLink'].includes(captured.operation) ||
    !bounded(captured.limit, 16 * 1024 * 1024) ||
    !bounded(timeoutMs, 30_000) ||
    (captured.operation === 'ReadLink' &&
      (!bounded(captured.limit, 4096) || captured.prefix !== undefined)) ||
    (captured.prefix !== undefined &&
      (typeof captured.prefix !== 'boolean' || captured.operation !== 'ReadBytes')) ||
    (captured.expectedState !== undefined &&
      (!Number.isSafeInteger(captured.expectedState.size) ||
        captured.expectedState.size < 0 ||
        !/^\d{1,32}$/.test(captured.expectedState.mtimeNs) ||
        !/^\d{1,32}$/.test(captured.expectedState.ctimeNs))) ||
    (captured.operation === 'ListDirectory' &&
      (!bounded(captured.maxEntries, 10000) || !bounded(captured.maxNameBytes, 1024 * 1024))) ||
    [captured.rootAnchor?.identity, captured.identity, captured.parentIdentity].some(
      (value) => !value || !/^\d{1,32}$/.test(value.dev) || !/^\d{1,32}$/.test(value.ino),
    )
  )
    return Promise.resolve({
      content: 'Invalid anchored read limits or authority',
      is_error: true,
    });
  let deniedRoots: readonly string[];
  try {
    deniedRoots = freezeNativeReadExclusions(captured.deniedRoots);
  } catch {
    return { content: 'Actual read exclusions unavailable', is_error: true };
  }
  if (
    deniedRoots.some(
      (root) =>
        captured.file_path === root ||
        captured.file_path.startsWith(root === '/' ? '/' : root + '/'),
    )
  )
    return { content: 'Anchored native read unavailable', is_error: true };
  const payload = { ...captured, deniedRoots, timeoutMs };
  const result = await executeNativeFileOperation(payload, signal, timeoutMs, privateTransport);
  signal.throwIfAborted();
  if (result.is_error)
    return {
      content: /^Anchored (directory|byte)( output)? limit exceeded$/.test(result.content)
        ? 'Anchored read limit exceeded'
        : 'Anchored native read unavailable',
      is_error: true,
    };
  if (!captured.prefix) return result;
  try {
    const value: unknown = JSON.parse(result.content);
    if (
      !value ||
      typeof value !== 'object' ||
      !('bytes' in value) ||
      typeof value.bytes !== 'string' ||
      !('truncated' in value) ||
      typeof value.truncated !== 'boolean'
    )
      throw Error('Invalid prefix');
    return { content: value.bytes, truncated: value.truncated, is_error: false };
  } catch {
    return { content: 'Anchored native read unavailable', is_error: true };
  }
}

/** Original pre-effect facts only; these are neither authority nor a grant.
 * The original current owner supplies the enforced actor transport separately. */
export interface NativeExclusiveDirectoryRequest {
  readonly file_path: string;
  readonly rootAnchor: NativeReadAnchor;
  readonly parentIdentity: NativeReadIdentity;
  readonly expectedAbsent: true;
  readonly deniedRoots: readonly string[];
}

export interface NativeExclusiveFilePayload {
  readonly file_path: string;
  readonly rootAnchor: NativeReadAnchor;
  readonly parentIdentity: NativeReadIdentity;
  readonly identity: NativeReadIdentity;
  readonly size: number;
  readonly sha256: string;
}
export interface NativeExclusiveFileRequest extends NativeExclusiveDirectoryRequest {
  readonly payload: NativeExclusiveFilePayload;
}
function exclusiveData(value: unknown, key: string): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Exclusive file data unavailable');
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !('value' in property)) throw Error('Exclusive file data unavailable');
  return property.value;
}
function validExclusiveIdentity(value: unknown): value is NativeReadIdentity {
  try {
    return (
      Reflect.ownKeys(value as object).length === 2 &&
      ['dev', 'ino'].every((key) => {
        const field = exclusiveData(value, key);
        return typeof field === 'string' && /^\d{1,32}$/.test(field);
      })
    );
  } catch {
    return false;
  }
}
function projectExclusiveFileRequest(input: unknown): Readonly<NativeExclusiveFileRequest> {
  const identity = (value: unknown) => {
    if (!validExclusiveIdentity(value)) throw Error('Exclusive file data unavailable');
    return Object.freeze({ dev: value.dev, ino: value.ino });
  };
  const endpoint = (value: unknown) => {
    const path = exclusiveData(value, 'file_path');
    const root = exclusiveData(value, 'rootAnchor');
    const rootPath = exclusiveData(root, 'rootPath');
    if (
      !validNativeReadPath(path) ||
      !validNativeReadPath(rootPath) ||
      path === rootPath ||
      !path.startsWith(rootPath === '/' ? '/' : rootPath + '/')
    )
      throw Error('Exclusive file data unavailable');
    return {
      file_path: path,
      rootAnchor: Object.freeze({ rootPath, identity: identity(exclusiveData(root, 'identity')) }),
      parentIdentity: identity(exclusiveData(value, 'parentIdentity')),
    };
  };
  const target = endpoint(input);
  const originalPayload = exclusiveData(input, 'payload');
  const source = endpoint(originalPayload);
  const size = exclusiveData(originalPayload, 'size');
  const sha256 = exclusiveData(originalPayload, 'sha256');
  const deniedRoots = freezeNativeReadExclusions(
    exclusiveData(input, 'deniedRoots') as readonly string[],
  );
  if (
    exclusiveData(input, 'expectedAbsent') !== true ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 16 * 1024 * 1024 ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    target.file_path === source.file_path ||
    [target.file_path, source.file_path].some((path) =>
      deniedRoots.some((root) => path === root || path.startsWith(root === '/' ? '/' : root + '/')),
    )
  )
    throw Error('Exclusive file data unavailable');
  return Object.freeze({
    ...target,
    expectedAbsent: true,
    payload: Object.freeze({
      ...source,
      identity: identity(exclusiveData(originalPayload, 'identity')),
      size,
      sha256,
    }),
    deniedRoots,
  });
}

export interface NativeExclusiveFileBatchRequest {
  readonly items: readonly NativeExclusiveFileRequest[];
  readonly deniedRoots: readonly string[];
}
function projectExclusiveFileBatchRequest(
  input: unknown,
): Readonly<NativeExclusiveFileBatchRequest> {
  const original = exclusiveData(input, 'items');
  const deniedRoots = freezeNativeReadExclusions(
    exclusiveData(input, 'deniedRoots') as readonly string[],
  );
  if (
    !Array.isArray(original) ||
    Object.getPrototypeOf(original) !== Array.prototype ||
    original.length < 1 ||
    original.length > 6
  )
    throw Error('Exclusive file batch unavailable');
  const items = Array.from({ length: original.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(original, String(index));
    if (!item || !('value' in item)) throw Error('Exclusive file batch unavailable');
    const projected = projectExclusiveFileRequest(item.value);
    if (JSON.stringify(projected.deniedRoots) !== JSON.stringify(deniedRoots))
      throw Error('Exclusive file batch unavailable');
    return projected;
  });
  let bytes = 0;
  const folded = (path: string) => path.normalize('NFD').toLowerCase();
  const targets = items.map((item) => folded(item.file_path));
  for (let index = 0; index < items.length; index++) {
    bytes += items[index].payload.size;
    const privateNames = new Set([
      '.ssh',
      '.aws',
      '.gnupg',
      '.kube',
      '.azure',
      '.gcloud',
      '.claude',
      '.cursor',
      '.codex',
      'keychains',
    ]);
    if (
      [items[index].file_path, items[index].payload.file_path].some((path) =>
        path.split('/').some((part) => privateNames.has(part.normalize('NFKC').toLowerCase())),
      )
    )
      throw Error('Exclusive file batch unavailable');
    if (
      targets.some(
        (path, other) =>
          other !== index &&
          (path === targets[index] ||
            path.startsWith(targets[index] + '/') ||
            targets[index].startsWith(path + '/')),
      )
    )
      throw Error('Exclusive file batch unavailable');
    // Negative-only alias refusal, never an authority/path canonicalizer.
    if (
      deniedRoots.some((root) =>
        [items[index].file_path, items[index].payload.file_path].some(
          (path) =>
            folded(path) === folded(root) ||
            folded(path).startsWith(folded(root).replace(/\/$/, '') + '/'),
        ),
      )
    )
      throw Error('Exclusive file batch unavailable');
  }
  if (bytes > 16 * 1024 * 1024 + 65536) throw Error('Exclusive file batch unavailable');
  // Reject predictable receipt/envelope overflow BEFORE any target lookup or
  // effect. Python uses ASCII escaping and spaces at both JSON levels; reserve
  // conservative fixed overhead in addition to the longest identity strings.
  const ascii = (value: string) =>
    value.replace(
      /[\u007f-\uffff]/g,
      (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  const estimate = ascii(
    JSON.stringify(
      items.map((item) => ({
        file_path: item.file_path,
        identity: { dev: '9'.repeat(32), ino: '9'.repeat(32) },
        byteLength: item.payload.size,
        sha256: item.payload.sha256,
      })),
    ),
  );
  if (
    Buffer.byteLength(estimate) + 1024 > 16384 ||
    Buffer.byteLength(ascii(JSON.stringify({ content: estimate, is_error: false }))) + 2048 > 32768
  )
    throw Error('Exclusive file batch unavailable');
  const result = Object.freeze({ items: Object.freeze(items), deniedRoots });
  if (Buffer.byteLength(JSON.stringify(result)) > 120 * 1024)
    throw Error('Exclusive file batch unavailable');
  return result;
}
/** Private fixed metadata phase only: exact file roots are independently
 * supplied by the consumed actor. No source directory grant or host fallback. */
export async function createNativeExclusiveFileBatch(
  request: NativeExclusiveFileBatchRequest,
  signal: AbortSignal,
  timeoutMs: number,
  privateTransport: NativeFileHelperTransport,
) {
  signal.throwIfAborted();
  try {
    if (
      typeof privateTransport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000
    )
      throw Error('Exclusive file batch unavailable');
    const projected = projectExclusiveFileBatchRequest(request);
    const result = await executeNativeFileOperation(
      {
        ...projected,
        operation: 'CreateFileBatch',
        identity: null,
        file_path: '',
        parentIdentity: { dev: '0', ino: '0' },
        limit: 1,
        timeoutMs,
      },
      signal,
      timeoutMs,
      privateTransport,
    );
    signal.throwIfAborted();
    if (result.is_error || Buffer.byteLength(result.content) > 16384)
      throw Error('Exclusive file batch unavailable');
    const returned: unknown = JSON.parse(result.content);
    if (!Array.isArray(returned) || returned.length !== projected.items.length)
      throw Error('Exclusive file batch unavailable');
    return Object.freeze(
      returned.map((item, index) => {
        const target = projected.items[index];
        if (
          !item ||
          typeof item !== 'object' ||
          Object.keys(item).length !== 4 ||
          item.file_path !== target.file_path ||
          !validExclusiveIdentity(item.identity) ||
          item.byteLength !== target.payload.size ||
          item.sha256 !== target.payload.sha256
        )
          throw Error('Exclusive file batch unavailable');
        return Object.freeze({
          file_path: target.file_path,
          identity: Object.freeze({ ...item.identity }),
          byteLength: target.payload.size,
          sha256: target.payload.sha256,
        });
      }),
    );
  } catch {
    signal.throwIfAborted();
    throw Error('Exclusive native file batch unavailable');
  }
}

/** Private exclusive binary publication from an already-owned actor scratch.
 * The enforced transport owns scratch/scope/current custody. No host fallback,
 * overwrite, source-config evaluation or cleanup is available in this primitive. */
export async function createNativeExclusiveFile(
  request: NativeExclusiveFileRequest,
  signal: AbortSignal,
  timeoutMs: number,
  privateTransport: NativeFileHelperTransport,
): Promise<
  Readonly<{ file_path: string; identity: NativeReadIdentity; byteLength: number; sha256: string }>
> {
  signal.throwIfAborted();
  try {
    if (
      typeof privateTransport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000
    )
      throw Error('Invalid private helper');
    const projected = projectExclusiveFileRequest(request);
    const result = await executeNativeFileOperation(
      { ...projected, operation: 'CreateFile', identity: null, limit: 1, timeoutMs },
      signal,
      timeoutMs,
      privateTransport,
    );
    signal.throwIfAborted();
    if (result.is_error || Buffer.byteLength(result.content) > 8192)
      throw Error('Invalid helper result');
    const value = JSON.parse(result.content);
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 4 ||
      value.file_path !== projected.file_path ||
      !validExclusiveIdentity(value.identity) ||
      value.byteLength !== projected.payload.size ||
      value.sha256 !== projected.payload.sha256
    )
      throw Error('Invalid helper result');
    return Object.freeze({
      file_path: value.file_path,
      identity: Object.freeze({ ...value.identity }),
      byteLength: value.byteLength,
      sha256: value.sha256,
    });
  } catch {
    signal.throwIfAborted();
    throw Error('Exclusive native file unavailable');
  }
}

/** Private same-helper mkdirat effect. Never falls back to a host executor and
 * never removes anything, including an uncertain effect after cancellation. */
export async function createNativeExclusiveDirectory(
  request: NativeExclusiveDirectoryRequest,
  signal: AbortSignal,
  timeoutMs: number,
  privateTransport: NativeFileHelperTransport,
): Promise<Readonly<{ directory: string; identity: NativeReadIdentity }>> {
  signal.throwIfAborted();
  const unavailable = () => Error('Exclusive native directory unavailable');
  try {
    // Validate and project the bounded fields before copying. Unrelated caller
    // objects, getters, buffers and credential-bearing material never enter IPC.
    const deniedRoots = freezeNativeReadExclusions(request.deniedRoots);
    const path = request.file_path;
    const root = request.rootAnchor?.rootPath;
    const rootIdentity = {
      dev: request.rootAnchor?.identity?.dev,
      ino: request.rootAnchor?.identity?.ino,
    };
    const parentIdentity = { dev: request.parentIdentity?.dev, ino: request.parentIdentity?.ino };
    const validIdentity = (value: unknown): value is NativeReadIdentity =>
      !!value &&
      typeof value === 'object' &&
      Object.keys(value).length === 2 &&
      'dev' in value &&
      typeof value.dev === 'string' &&
      /^\d{1,32}$/.test(value.dev) &&
      'ino' in value &&
      typeof value.ino === 'string' &&
      /^\d{1,32}$/.test(value.ino);
    if (
      typeof privateTransport !== 'function' ||
      !validNativeReadPath(path) ||
      !validNativeReadPath(root) ||
      !validIdentity(rootIdentity) ||
      !validIdentity(parentIdentity) ||
      request.expectedAbsent !== true ||
      path === root ||
      !path.startsWith(root === '/' ? '/' : root + '/') ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000 ||
      deniedRoots.some(
        (denied) => path === denied || path.startsWith(denied === '/' ? '/' : denied + '/'),
      )
    )
      throw unavailable();
    const result = await executeNativeFileOperation(
      {
        file_path: path,
        rootAnchor: { rootPath: root, identity: rootIdentity },
        parentIdentity,
        expectedAbsent: true,
        deniedRoots,
        operation: 'CreateDirectory',
        identity: null,
        limit: 1,
        timeoutMs,
      },
      signal,
      timeoutMs,
      privateTransport,
    );
    signal.throwIfAborted();
    if (result.is_error || result.content.length > 8192) throw unavailable();
    const value: unknown = JSON.parse(result.content);
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 2 ||
      !('directory' in value) ||
      value.directory !== path ||
      !('identity' in value) ||
      !validIdentity(value.identity)
    )
      throw unavailable();
    return Object.freeze({ directory: path, identity: Object.freeze({ ...value.identity }) });
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
}

/** Private whole-tree publication; every entry is preflighted before mutation.
 * A failure preserves partial state and never authorizes retry or cleanup. */
export async function createNativeExclusiveTree(
  input: NativeExclusiveTreeRequest,
  signal: AbortSignal,
  timeoutMs: number,
  privateTransport: NativeFileHelperTransport,
): Promise<
  Readonly<{ directory: string; identity: NativeReadIdentity; entries: number; byteLength: number }>
> {
  signal.throwIfAborted();
  try {
    if (
      typeof privateTransport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000
    )
      throw Error('Invalid helper');
    const request = projectExclusiveTreeRequest(input);
    const result = await executeNativeFileOperation(
      {
        ...request,
        operation: 'PublishTree',
        identity: null,
        parentIdentity: request.parentIdentity,
        limit: 1,
        timeoutMs,
      },
      signal,
      timeoutMs,
      privateTransport,
    );
    signal.throwIfAborted();
    if (result.is_error || Buffer.byteLength(result.content) > 8192) throw Error('Invalid helper');
    const value = JSON.parse(result.content);
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 4 ||
      value.directory !== request.file_path ||
      !validExclusiveIdentity(value.identity) ||
      value.identity.dev !== request.targetIdentity.dev ||
      value.identity.ino !== request.targetIdentity.ino ||
      value.entries !== request.entries.length ||
      value.byteLength !== request.entries.reduce((total, entry) => total + entry.size, 0)
    )
      throw Error('Invalid helper');
    return Object.freeze({
      directory: value.directory,
      identity: Object.freeze({ ...value.identity }),
      entries: value.entries,
      byteLength: value.byteLength,
    });
  } catch {
    signal.throwIfAborted();
    throw Error('Exclusive native tree unavailable');
  }
}
