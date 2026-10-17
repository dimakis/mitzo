import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolBuilderWorkspace } from './tool-builder.js';

// Matches the existing native file owner's openat/O_NOFOLLOW boundary. Source
// text and paths travel over stdin, never as shell commands or Python source.
const helper = String.raw`
import json, os, stat, sys

def directory(path):
    if not path.startswith('/') or any(p in ('.','..') for p in path.split('/')):
        raise RuntimeError('Invalid workspace authority')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in filter(None,path.split('/')):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except:
        os.close(fd)
        raise

def check(fd, expected):
    info = os.fstat(fd)
    if str(info.st_dev) != expected['dev'] or str(info.st_ino) != expected['ino']:
        raise RuntimeError('Workspace authority changed')

def remove_contents(fd):
    for name in os.listdir(fd):
        info = os.stat(name,dir_fd=fd,follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try: remove_contents(child)
            finally: os.close(child)
            os.rmdir(name,dir_fd=fd)
        else: os.unlink(name,dir_fd=fd)

def execute(request):
    base=directory(request['base'])
    root=None
    try:
        check(base,request['baseIdentity'])
        name=request['name']
        if '/' in name or not name.startswith('.mitzo-tool-builder-'):
            raise RuntimeError('Invalid workspace identity')
        if request['operation']=='allocate': os.mkdir(name,0o700,dir_fd=base)
        root=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base)
        if request['operation']=='allocate':
            info=os.fstat(root)
            return {'dev':str(info.st_dev),'ino':str(info.st_ino)}
        check(root,request['rootIdentity'])
        if request['operation']=='discard':
            remove_contents(root)
            check(root,request['rootIdentity'])
            current=os.stat(name,dir_fd=base,follow_symlinks=False)
            if current.st_dev!=os.fstat(root).st_dev or current.st_ino!=os.fstat(root).st_ino:
                raise RuntimeError('Workspace authority changed before cleanup')
            os.rmdir(name,dir_fd=base)
            return True
        if request['operation']=='write':
            parts=request['path'].split('/')
            if not parts or any(not part or part in ('.','..') or '\\' in part or '\x00' in part for part in parts):
                raise RuntimeError('File path is outside the authorized workspace')
            parent=os.dup(root)
            try:
                for part in parts[:-1]:
                    try: os.mkdir(part,0o700,dir_fd=parent)
                    except FileExistsError: pass
                    child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                    os.close(parent)
                    parent=child
                content=request['content'].encode('utf8')
                if len(content)>256000: raise RuntimeError('File exceeds source limit')
                file=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
                try:
                    with os.fdopen(file,'wb',closefd=False) as stream: stream.write(content)
                finally: os.close(file)
                return True
            finally: os.close(parent)
        if request['operation']!='snapshot': raise RuntimeError('Unsupported workspace operation')
        files=[]
        total=0
        def visit(fd,prefix,depth):
            nonlocal total
            if depth>30: raise RuntimeError('Workspace nesting limit exceeded')
            names=os.listdir(fd)
            if len(names)>200: raise RuntimeError('Workspace entry limit exceeded')
            for name in sorted(names):
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    try: visit(child,prefix+name+'/',depth+1)
                    finally: os.close(child)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
                    file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
                    try:
                        before=os.fstat(file)
                        if before.st_ino!=info.st_ino or before.st_dev!=info.st_dev: raise RuntimeError('Source changed')
                        with os.fdopen(file,'rb',closefd=False) as stream: content=stream.read(256001)
                        after=os.fstat(file)
                        if before.st_size!=after.st_size or before.st_mtime_ns!=after.st_mtime_ns or len(content)>256000:
                            raise RuntimeError('Source changed or exceeded limit')
                    finally: os.close(file)
                    total+=len(content)
                    if total>2000000 or len(files)>=100: raise RuntimeError('Workspace source limit exceeded')
                    files.append({'path':prefix+name,'content':content.decode('utf8')})
                else: raise RuntimeError('Workspace requires regular source files without links')
        visit(root,'',0)
        return files
    finally:
        if root is not None: os.close(root)
        os.close(base)
try: print(json.dumps({'value':execute(json.load(sys.stdin))}))
except Exception: print(json.dumps({'error':'Tool workspace operation refused; check source paths, links and workspace identity'}))
`;
const Identity = z.strictObject({ dev: z.string(), ino: z.string() });
async function operation(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-I', '-c', helper],
      {
        env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
        signal,
        timeout: 30000,
        maxBuffer: 4_000_000,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Tool workspace helper unavailable or cancelled', { cause: error }));
          return;
        }
        try {
          const response = z
            .union([z.strictObject({ value: z.unknown() }), z.strictObject({ error: z.string() })])
            .parse(JSON.parse(stdout));
          if ('error' in response) throw Error(response.error);
          resolve(response.value);
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin?.on('error', () => {
      /* Process failure is reported by execFile. */
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

export async function createToolBuilderWorkspace(
  worktree: string,
  signal: AbortSignal,
): Promise<ToolBuilderWorkspace> {
  signal.throwIfAborted();
  const base = realpathSync(worktree);
  const info = lstatSync(base, { bigint: true });
  const id = randomUUID();
  const name = `.mitzo-tool-builder-${id}`;
  const request = { base, baseIdentity: { dev: String(info.dev), ino: String(info.ino) }, name };
  // Allocation finishes before cancellation is observed, so the caller receives
  // an identity it can safely discard even when cancellation arrived mid-create.
  const rootIdentity = Identity.parse(
    await operation({ ...request, operation: 'allocate' }, new AbortController().signal),
  );
  const common = { ...request, rootIdentity };
  const snapshot = async () =>
    z
      .array(z.strictObject({ path: z.string(), content: z.string() }))
      .max(100)
      .parse(await operation({ ...common, operation: 'snapshot' }, signal));
  return {
    id,
    root: join(base, name),
    async write(path, content) {
      await operation({ ...common, operation: 'write', path, content }, signal);
    },
    snapshot,
    async read(path) {
      const files = await snapshot();
      const file = files.find((file) => file.path === path);
      if (!file) throw Error('Tool source was not found');
      return file.content;
    },
    async discard() {
      await operation({ ...common, operation: 'discard' }, new AbortController().signal);
    },
  };
}
