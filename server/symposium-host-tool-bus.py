# Controller-owned bounded transport; requests are untrusted data, never commands.
import json, os, re, stat, sys
BASE = '/sandbox/.symposium-seats'
claim, operation = sys.argv[1:]
if not re.fullmatch('[a-f0-9]{64}', claim):
    raise ValueError('Invalid claim')
DATA_LIMIT = 1024 * 1024
raw = sys.stdin.buffer.read(DATA_LIMIT + 1)
if len(raw) > DATA_LIMIT:
    raise ValueError('Input too large')
data = json.loads(raw or b'{}')
if operation == 'setup':
    os.makedirs(BASE, mode=0o700, exist_ok=True)
base = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    if operation == 'setup':
        try: os.mkdir(claim, 0o700, dir_fd=base)
        except FileExistsError: pass
    home = os.open(claim, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
finally:
    os.close(base)
try:
    if operation == 'setup':
        os.mkdir('host-access', 0o700, dir_fd=home)
    bus = os.open('host-access', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home)
    try:
        def regular(fd, limit):
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
                raise ValueError('Unsafe bus file')
        def write(name, value):
            encoded = value.encode('utf8')
            if len(encoded) > DATA_LIMIT: raise ValueError('Output too large')
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=bus)
            try:
                regular(fd, DATA_LIMIT)
                with os.fdopen(fd, 'wb', closefd=False) as output: output.write(encoded)
            finally: os.close(fd)
        if operation == 'setup':
            write('definitions.json', json.dumps(data['definitions']))
            write('mcp.py', data['shim'])
            print('{}')
        elif operation == 'take':
            calls = []
            for name in sorted(os.listdir(bus)):
                if not re.fullmatch('[a-f0-9-]{36}\.request', name): continue
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=bus)
                try:
                    regular(fd, 32768)
                    with os.fdopen(fd, 'rb', closefd=False) as source: value = json.loads(source.read(32769))
                    current = os.stat(name, dir_fd=bus, follow_symlinks=False)
                    if current.st_ino != os.fstat(fd).st_ino: raise ValueError('Bus file changed')
                    if not isinstance(value, dict): raise ValueError('Invalid request')
                    value['id'] = name[:-8]
                    calls.append(value)
                    os.unlink(name, dir_fd=bus)
                finally: os.close(fd)
                if len(calls) == 8: break
            print(json.dumps(calls))
        elif operation == 'put':
            identifier = data['id']
            if not re.fullmatch('[a-f0-9-]{36}', identifier): raise ValueError('Invalid call identity')
            write(identifier + '.tmp', json.dumps(data['response']))
            os.rename(identifier + '.tmp', identifier + '.response', src_dir_fd=bus, dst_dir_fd=bus)
            print('{}')
        elif operation == 'close':
            for name in os.listdir(bus):
                if name not in ('mcp.py', 'definitions.json') and not re.fullmatch('[a-f0-9-]{36}\.(request|response|tmp)', name):
                    raise ValueError('Unexpected bus entry')
                os.unlink(name, dir_fd=bus)
            os.rmdir('host-access', dir_fd=home)
            print('{}')
        else: raise ValueError('Unknown operation')
    finally: os.close(bus)
finally: os.close(home)
