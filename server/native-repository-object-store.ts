import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import type { NativeReadAnchor } from './native-file-operation.js';
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => isAbsolute(v) && resolve(v) === v && !v.includes('\0'));
const identity = z.strictObject({
  dev: z.string().regex(/^\d{1,32}$/),
  ino: z.string().regex(/^\d{1,32}$/),
});
const anchor = z.strictObject({ rootPath: path, identity });
const Plan = z.strictObject({
  version: z.literal('preparation-object-store-v1'),
  source: anchor,
  target: anchor,
  objectFormat: z.enum(['sha1', 'sha256']),
  deniedRoots: z.array(path).max(256),
});
const Files = z
  .array(
    z.strictObject({
      path: z
        .string()
        .regex(/^(?:[a-f0-9]{2}\/[a-f0-9]{38,62}|pack\/pack-[a-f0-9]{40,64}\.(?:pack|idx))$/),
      size: z
        .number()
        .int()
        .nonnegative()
        .max(128 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      identity,
    }),
  )
  .max(4096);
export interface PreparationObjectStoreCapture {
  readonly directory: string;
  readonly identity: Readonly<NativeReadAnchor['identity']>;
  readonly files: readonly Readonly<z.infer<typeof Files>[number]>[];
  readonly digest: string;
}
export function preparationObjectStoreRequest(input: unknown) {
  const request = z
    .strictObject({
      operation: z.enum(['capture', 'verify']),
      plan: Plan,
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .parse(input);
  if ((request.operation === 'verify') !== !!request.digest)
    throw Error('Preparation object store unavailable');
  return request;
}
export function parsePreparationObjectStoreCapture(
  value: unknown,
  target: NativeReadAnchor,
): Readonly<PreparationObjectStoreCapture> {
  const parsed = z
    .strictObject({ files: Files, digest: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(value);
  if (
    new Set(parsed.files.map((f) => f.path)).size !== parsed.files.length ||
    parsed.files.reduce((n, f) => n + f.size, 0) > 128 * 1024 * 1024
  )
    throw Error('Preparation object store unavailable');
  return Object.freeze({
    directory: target.rootPath,
    identity: Object.freeze({ ...target.identity }),
    digest: parsed.digest,
    files: Object.freeze(
      parsed.files.map((f) => Object.freeze({ ...f, identity: Object.freeze(f.identity) })),
    ),
  });
}
export function preparationObjectStoreCommand(input: unknown) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `/usr/bin/printf '%s' ${quote(JSON.stringify(preparationObjectStoreRequest(input)))} | /usr/bin/python3 -I -c ${quote(preparationObjectStoreProgram)}`;
}
/** Copies opaque containers only. Git later decodes and hashes the required
 * checkout closure under separate expanded-content limits. Source config,
 * alternates, accelerators and optional pack markers are never consumed. */
export const preparationObjectStoreProgram = String.raw`
import hashlib, json, os, re, stat, sys, time

def run(request):
    deadline = time.monotonic() + 30
    def check():
        if time.monotonic() >= deadline: raise RuntimeError()
    plan = request['plan']
    if plan['version'] != 'preparation-object-store-v1': raise RuntimeError()
    oid_length = 40 if plan['objectFormat'] == 'sha1' else 64 if plan['objectFormat'] == 'sha256' else 0
    if not oid_length: raise RuntimeError()
    def allowed(path):
        check()
        if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path or '\x00' in path: raise RuntimeError()
        if any(path==root or path.startswith(root.rstrip('/')+'/') for root in plan['deniedRoots']): raise RuntimeError()
    def ident(info): return {'dev':str(info.st_dev),'ino':str(info.st_ino)}
    def state(info): return [str(info.st_dev),str(info.st_ino),info.st_mode,info.st_nlink,info.st_size,str(info.st_mtime_ns),str(info.st_ctime_ns)]
    def directory(path):
        allowed(path)
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        prefix=''
        try:
            for name in [name for name in path.split('/') if name]:
                prefix+='/'+name; allowed(prefix)
                next_fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                os.close(fd);fd=next_fd
            return fd
        except:
            os.close(fd);raise
    def bounded_names(fd, maximum):
        names, name_bytes = [], 0
        with os.scandir(fd) as children:
            for child in children:
                check(); name_bytes += len(os.fsencode(child.name))
                if len(names) >= maximum or name_bytes > 1024 * 1024: raise RuntimeError()
                names.append(child.name)
        return sorted(names)
    source=directory(plan['source']['rootPath']); target=directory(plan['target']['rootPath'])
    try:
        if ident(os.fstat(source))!=plan['source']['identity'] or ident(os.fstat(target))!=plan['target']['identity']: raise RuntimeError()
        if request['operation']=='capture' and bounded_names(target, 1): raise RuntimeError()
        objects_path=os.path.join(plan['source']['rootPath'],'objects'); allowed(objects_path)
        objects=os.open('objects',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=source)
        try:
            def inspect(copy):
                witnesses=[]; files=[]; total=0
                names=bounded_names(objects, 258)
                if len(names)>258: raise RuntimeError()
                witnesses.append(['objects',ident(os.fstat(objects)),names])
                for name in names:
                    if name=='info': continue
                    if name!='pack' and not re.fullmatch('[a-f0-9]{2}',name): raise RuntimeError()
                    allowed(os.path.join(objects_path,name))
                    shard=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=objects)
                    destination=None
                    try:
                        children=bounded_names(shard, 10000)
                        if len(children)>10000: raise RuntimeError()
                        witnesses.append([name,ident(os.fstat(shard)),children])
                        if copy:
                            os.mkdir(name,0o700,dir_fd=target)
                            destination=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=target)
                        for child in children:
                            if name=='pack' and (child=='multi-pack-index' or re.fullmatch('pack-[a-f0-9]{'+str(oid_length)+'}\.(rev|bitmap|keep|promisor|mtimes)',child)): continue
                            expression='pack-[a-f0-9]{'+str(oid_length)+'}\.(pack|idx)' if name=='pack' else '[a-f0-9]{'+str(oid_length-2)+'}'
                            if not re.fullmatch(expression,child): raise RuntimeError()
                            allowed(os.path.join(objects_path,name,child))
                            info=os.stat(child,dir_fd=shard,follow_symlinks=False)
                            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>(128 if name=='pack' else 16)*1024*1024: raise RuntimeError()
                            total+=info.st_size
                            if total>128*1024*1024 or len(files)>=4096: raise RuntimeError()
                            relative=name+'/'+child
                            witnesses.append([relative,state(info)])
                            item={'path':relative,'size':info.st_size}
                            if copy:
                                original=os.open(child,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=shard)
                                output=None
                                try:
                                    if state(os.fstat(original))!=state(info): raise RuntimeError()
                                    output=os.open(child,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=destination)
                                    digest=hashlib.sha256(); remaining=info.st_size
                                    while remaining:
                                        check()
                                        chunk=os.read(original,min(remaining,1024*1024))
                                        if not chunk: raise RuntimeError()
                                        digest.update(chunk); remaining-=len(chunk)
                                        view=memoryview(chunk)
                                        while view:
                                            written=os.write(output,view)
                                            if written<=0: raise RuntimeError()
                                            view=view[written:]
                                    if state(os.fstat(original))!=state(info) or state(os.stat(child,dir_fd=shard,follow_symlinks=False))!=state(info): raise RuntimeError()
                                    item.update({'sha256':digest.hexdigest(),'identity':ident(os.fstat(output))})
                                finally:
                                    if output is not None: os.close(output)
                                    os.close(original)
                            files.append(item)
                    finally:
                        if destination is not None: os.close(destination)
                        os.close(shard)
                return files,hashlib.sha256(json.dumps(witnesses,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            capture=request['operation']=='capture'
            files,digest=inspect(capture)
            if capture:
                if inspect(False)[1]!=digest: raise RuntimeError()
                return {'files':files,'digest':digest}
            if request['operation']!='verify' or digest!=request['digest']: raise RuntimeError()
            return {'verified':True}
        finally: os.close(objects)
    finally: os.close(source);os.close(target)
try:
    print(json.dumps(run(json.load(sys.stdin))))
except Exception:
    print(json.dumps({'error':'unavailable'}))
`;
