import { isAbsolute, resolve, dirname, join, basename } from 'node:path';
import { z } from 'zod';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const identity = z.strictObject({
  dev: z.string().regex(/^\d{1,32}$/),
  ino: z.string().regex(/^\d{1,32}$/),
});
const root = z.strictObject({ path, identity });
export const PreparedTopologySchema = z
  .strictObject({
    directory: path,
    featureBranch: z
      .string()
      .max(1024)
      .regex(/^mitzo\/[A-Za-z0-9._/-]+$/)
      .refine((value) => !value.includes('..')),
    root: identity,
    git: identity,
    source: z.strictObject({ root, common: root, gitDirectory: path }).optional(),
    linked: root.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      !!value.source !== !!value.linked ||
      (value.linked &&
        value.linked.path !==
          join(value.source!.common.path, 'worktrees', basename(value.directory)))
    )
      ctx.addIssue({ code: 'custom', message: 'Exact linked topology required' });
  });
export type PreparedTopology = z.infer<typeof PreparedTopologySchema>;

/** Data only. The actual factory reader still owns current authority and the
 * physical helper; persisted topology never grants a read. */
export function preparedTopologyInput(
  task: Readonly<RepositoryTaskCheckout>,
  sourceGitDirectory: string,
) {
  if (!task.localSource) throw Error('Prepared repository topology unavailable');
  const numeric = (value: { dev: number; ino: number }) => ({
    dev: String(value.dev),
    ino: String(value.ino),
  });
  const topology = PreparedTopologySchema.parse({
    directory: task.directory,
    featureBranch: task.featureBranch,
    root: numeric(task.root),
    git: numeric(task.git),
    ...(task.linkedGit
      ? {
          source: {
            root: { path: task.localSource.path, identity: numeric(task.localSource.root) },
            common: {
              path: task.localSource.commonDirectory,
              identity: numeric(task.localSource.commonRoot),
            },
            gitDirectory: sourceGitDirectory,
          },
          linked: { path: task.linkedGit.directory, identity: numeric(task.linkedGit.identity) },
        }
      : {}),
  });
  const name = /^repo-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
    basename(task.directory),
  );
  if (topology.linked && !name) throw Error('Prepared repository topology unavailable');
  return {
    mode: topology.linked ? ('topology' as const) : ('task-topology' as const),
    sourcePath: topology.source?.root.path ?? topology.directory,
    ...(topology.linked ? { taskRoot: dirname(task.directory), workspaceId: name![1] } : {}),
    readableRoots: topology.linked ? ['/'] : [topology.directory],
    expectedTopology: topology,
  };
}

/** Existing Git grammar, fixed argv and bounded captured stdin only. This is
 * embedded in the same descriptor helper and owned process group as capture. */
export const preparedTopologyPython = String.raw`
def assert_prepared_topology(expected, source, git, common, entries, files, absent, deadline_remaining, check, fail):
    import re, subprocess
    def regular(path):
        value = entries.get(path)
        if value is None or value['kind'] != 'file' or value['nlink'] != 1: fail()
        return value
    def content(path):
        regular(path)
        captured = files.get(path)
        if captured is None or captured['link']: fail()
        return base64.b64decode(captured['bytes'], validate=True)
    def directory(path, identity):
        value = entries.get(path)
        if value is None or value['kind'] != 'directory' or value['identity'] != identity: fail()
    def missing(path): return any(path == root or path.startswith(root.rstrip('/') + '/') for root in absent)
    def trim(value): return value.strip('\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
    def branch(value):
        return bool(value) and value != 'HEAD' and not value.startswith('-') and not value.endswith('.') and '..' not in value and '@{' not in value and not any(ord(c) <= 32 or ord(c) == 127 or c in '~^:?*[\\' for c in value) and all(part and not part.startswith('.') and not part.endswith('.lock') for part in value.split('/'))
    task = expected['directory']; feature = expected['featureBranch']
    if not branch(feature): fail()
    directory(task, expected['root'])
    marker = os.path.join(task, '.git')
    if entries.get(marker, {}).get('identity') != expected['git']: fail()
    linked = expected.get('linked'); retained = expected.get('source')
    if linked:
        if retained is None or source != retained['root']['path'] or git != retained['gitDirectory'] or common != retained['common']['path']: fail()
        directory(source, retained['root']['identity']); directory(common, retained['common']['identity']); directory(linked['path'], linked['identity'])
        pointers = [(marker, 'gitdir: ' + linked['path'] + '\n'), (os.path.join(linked['path'], 'commondir'), os.path.relpath(common, linked['path']) + '\n'), (os.path.join(linked['path'], 'gitdir'), marker + '\n'), (os.path.join(linked['path'], 'HEAD'), 'ref: refs/heads/' + feature + '\n')]
        for path, value in pointers:
            if content(path) != value.encode('utf-8'): fail()
        index = os.path.join(linked['path'], 'index'); regular(index)
        reference = content(os.path.join(common, 'refs', 'heads', feature))
        if re.fullmatch(b'[a-f0-9]{40}(?:[a-f0-9]{24})?\n', reference) is None: fail()
    else:
        if source != task or git != marker or common != marker: fail()
        directory(marker, expected['git']); regular(os.path.join(marker, 'index'))
        if content(os.path.join(marker, 'HEAD')) != ('ref: refs/heads/' + feature + '\n').encode('utf-8'): fail()
        for name in ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']:
            if not missing(os.path.join(marker, name)): fail()
    object_format = 'sha1'
    for root in dict.fromkeys([git, common]):
        for name in ['config', 'config.worktree']:
            path = os.path.join(root, name)
            if missing(path): continue
            data = content(path)
            if len(data) > 65536: fail()
            check()
            parsed = subprocess.run(['/usr/bin/git', 'config', '--no-includes', '--file', '-', '--null', '--list'], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd='/', env={'PATH':'/usr/bin:/bin', 'HOME':'/nonexistent', 'GIT_CONFIG_SYSTEM':'/dev/null', 'GIT_CONFIG_GLOBAL':'/dev/null', 'GIT_CONFIG_NOSYSTEM':'1', 'GIT_NO_LAZY_FETCH':'1', 'GIT_NO_REPLACE_OBJECTS':'1', 'GIT_OPTIONAL_LOCKS':'0', 'GIT_TERMINAL_PROMPT':'0', 'GIT_ALTERNATE_OBJECT_DIRECTORIES':''}, timeout=max(.001, deadline_remaining()))
            check()
            if parsed.returncode != 0 or len(parsed.stdout) > 131072 or len(parsed.stderr) > 131072: fail()
            for setting in parsed.stdout.decode('utf-8', errors='replace').split('\x00'):
                if not setting: continue
                parts = setting.split('\n', 1); key = parts[0].lower(); value = parts[1] if len(parts) == 2 else None
                if re.match(r'^include(if)?\.', key): fail()
                if key.startswith('extensions.') and key not in ['extensions.objectformat', 'extensions.worktreeconfig']: fail()
                if key == 'core.bare' and (value if value is not None else 'true').lower() in ['true','yes','on','1']: fail()
                if key == 'extensions.objectformat':
                    if value not in ['sha1','sha256']: fail()
                    object_format = value
                if key == 'core.worktree' and (value is None or os.path.normpath(os.path.join(root, value)) != source): fail()
    if not linked:
        shallow = os.path.join(marker, 'shallow')
        if not missing(shallow):
            value = content(shallow)
            length = 64 if object_format == 'sha256' else 40
            if len(value) > 65536 or any(re.fullmatch('[a-f0-9]{' + str(length) + '}', oid) is None for oid in value.decode('utf-8').split('\n') if oid): fail()
        packed = os.path.join(common, 'packed-refs'); references = {}
        if not missing(packed):
            for line in trim(content(packed).decode('utf-8', errors='replace')).split('\n'):
                if not line or line.startswith('#') or line.startswith('^'): continue
                match = re.fullmatch(r'([a-f0-9]{40}(?:[a-f0-9]{24})?) (refs/[^\r\n\x00]+)', line)
                if match is None or not branch(match[2]) or match[2] in references: fail()
                references[match[2]] = match[1]
        name = 'HEAD'; seen = set()
        while True:
            if name in seen or len(seen) >= 16 or (name != 'HEAD' and (not name.startswith('refs/') or not branch(name))): fail()
            seen.add(name); path = os.path.join(git if name == 'HEAD' else common, name)
            value = trim(content(path).decode('utf-8', errors='replace')) if not missing(path) else references.get(name)
            if not value: fail()
            symbolic = re.fullmatch(r'ref: (refs/[^\r\n\x00]+)', value)
            if symbolic is not None: name = symbolic[1]; continue
            if re.fullmatch('[a-f0-9]{40}(?:[a-f0-9]{24})?', value) is None: fail()
            break
`;
