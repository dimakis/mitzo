import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  KnowledgePublicationBridge,
  KnowledgePublicationUnavailableError,
} from '../knowledge-publication-bridge.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
async function setup(
  policy: {
    optionalPaths?: string[];
    excludePaths?: string[];
    excludePathSegments?: string[];
    excludeHiddenPaths?: boolean;
  } = {},
  publishedPath = 'AGENTS.md',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-publication-')));
  roots.push(root);
  const source = {
    id: 'notes',
    url: 'https://example.com/notes.git',
    ref: 'refs/heads/main',
    paths: publishedPath.includes('/') ? ['memory/'] : ['AGENTS.md'],
    ...policy,
  };
  const revision = 'a'.repeat(40);
  const directory = join(root, 'notes', 'snapshot-' + revision);
  await mkdir(join(directory, 'source'), { recursive: true });
  const content = '# Accepted instructions';
  const context = '{}';
  await mkdir(join(directory, 'source', publishedPath, '..'), { recursive: true });
  await writeFile(join(directory, 'source', publishedPath), content);
  await writeFile(join(directory, 'context.json'), context);
  const manifest = {
    schema: 'contexgin-portable-v1',
    source: 'notes',
    acceptedRef: source.ref,
    sourceIdentity: hash(JSON.stringify(source)),
    revision,
    paths: source.paths,
    ...policy,
    files: [{ path: publishedPath, sha256: hash(content), bytes: Buffer.byteLength(content) }],
    contextSha256: hash(context),
  };
  const raw = JSON.stringify(manifest);
  await writeFile(join(directory, 'manifest.json'), raw);
  const selection = { directory, revision, manifestSha256: hash(raw) };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ current: selection }), { status: 200 }));
  const seed = join(root, 'bundle/mgmt');
  await mkdir(seed, { recursive: true });
  await mkdir(join(seed, publishedPath, '..'), { recursive: true });
  await writeFile(join(seed, publishedPath), content);
  await writeFile(
    join(seed, '..', 'baseline.json'),
    JSON.stringify({ files: { [publishedPath]: { sha256: hash(content), mode: '0644' } } }),
  );
  const adapt = vi
    .fn()
    .mockResolvedValue({ seed: join(root, 'bundle/mgmt'), sourceCommit: revision });
  const bridge = new KnowledgePublicationBridge(
    { publisherUrl: 'http://127.0.0.1:8643', publisherRoot: root, source, token: 'host-secret' },
    adapt,
    fetcher,
  );
  return { root, source, directory, selection, adapt, fetcher, bridge };
}
async function addPublished(s: Awaited<ReturnType<typeof setup>>, path: string) {
  const content = '# ' + path;
  await mkdir(join(s.directory, 'source', path, '..'), { recursive: true });
  await writeFile(join(s.directory, 'source', path), content);
  const seed = join(s.root, 'bundle/mgmt');
  await mkdir(join(seed, path, '..'), { recursive: true });
  await writeFile(join(seed, path), content);
  const baseline = JSON.parse(await readFile(join(seed, '..', 'baseline.json'), 'utf8'));
  baseline.files[path] = { sha256: hash(content), mode: '0644' };
  await writeFile(join(seed, '..', 'baseline.json'), JSON.stringify(baseline));
  const manifest = JSON.parse(await readFile(join(s.directory, 'manifest.json'), 'utf8'));
  manifest.files.push({ path, sha256: hash(content), bytes: Buffer.byteLength(content) });
  const raw = JSON.stringify(manifest);
  await writeFile(join(s.directory, 'manifest.json'), raw);
  s.fetcher.mockResolvedValue(
    new Response(JSON.stringify({ current: { ...s.selection, manifestSha256: hash(raw) } })),
  );
}
it('permits absent optional guidance paths', async () => {
  const s = await setup({
    optionalPaths: ['CLAUDE.md', 'context/', 'spoke/AGENTS.md', 'spoke/context/'],
  });
  await expect(s.bridge.reconcile(new AbortController().signal)).resolves.toHaveProperty(
    'sourceCommit',
    s.selection.revision,
  );
});
it.each(['CLAUDE.md', 'context/future.md', 'spoke/AGENTS.md', 'spoke/context/future.md'])(
  'admits matching optional Markdown %s',
  async (path) => {
    const s = await setup({
      optionalPaths: ['CLAUDE.md', 'context/', 'spoke/AGENTS.md', 'spoke/context/'],
    });
    await addPublished(s, path);
    await expect(s.bridge.reconcile(new AbortController().signal)).resolves.toHaveProperty(
      'sourceCommit',
      s.selection.revision,
    );
  },
);
it.each(['context/scripts/private.md', 'context/category/node_modules/private.md'])(
  'applies exclusion policy to optional path %s',
  async (path) => {
    const s = await setup({
      optionalPaths: ['context/'],
      excludePaths: ['context/scripts/'],
      excludePathSegments: ['node_modules'],
    });
    await addPublished(s, path);
    await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
      'Publication files differ from configured source paths',
    );
    expect(s.adapt).not.toHaveBeenCalled();
  },
);
it('uses authenticated canonical reconciliation and passes only a verified exact revision to the adapter', async () => {
  const s = await setup();
  const result = await s.bridge.reconcile(new AbortController().signal);
  expect(result.sourceCommit).toBe(s.selection.revision);
  expect(result).toHaveProperty(
    'baselineSha256',
    hash(await readFile(join(result.seed, '..', 'baseline.json'), 'utf8')),
  );
  expect(s.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8643/api/publications/notes/reconcile');
  expect(s.fetcher.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: { authorization: 'Bearer host-secret' },
  });
  expect(s.adapt.mock.calls[0][0]).toEqual(s.selection);
});
it('accepts the publisher optional exclusion policy for a complete matching adapter view', async () => {
  const s = await setup(
    { excludePaths: ['memory/scripts/', 'memory/manifest/', 'absent/'], excludeHiddenPaths: true },
    'memory/accepted.md',
  );
  await expect(s.bridge.reconcile(new AbortController().signal)).resolves.toHaveProperty(
    'sourceCommit',
    s.selection.revision,
  );
});
it.each([
  'memory/scripts/leak.md',
  'memory/manifest/leak.md',
  'memory/private.md',
  'memory/.hidden.md',
  'memory/.private/leak.md',
])('rejects excluded publisher path %s before adapting', async (path) => {
  const s = await setup(
    {
      excludePaths: ['memory/scripts/', 'memory/manifest/', 'memory/private.md'],
      excludeHiddenPaths: true,
    },
    path,
  );
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Publication files differ from configured source paths',
  );
  expect(s.adapt).not.toHaveBeenCalled();
});
it.each(['optionalPaths', 'excludePaths', 'excludePathSegments', 'excludeHiddenPaths'])(
  'rejects a changed manifest %s even when its files still match',
  async (field) => {
    const s = await setup({
      optionalPaths: ['missing.md'],
      excludePaths: ['absent/'],
      excludePathSegments: ['node_modules'],
      excludeHiddenPaths: true,
    });
    const manifest = JSON.parse(await readFile(join(s.directory, 'manifest.json'), 'utf8'));
    manifest[field] = field === 'excludeHiddenPaths' ? false : [];
    const raw = JSON.stringify(manifest);
    await writeFile(join(s.directory, 'manifest.json'), raw);
    s.fetcher.mockResolvedValue(
      new Response(JSON.stringify({ current: { ...s.selection, manifestSha256: hash(raw) } })),
    );
    await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
      'Publication provenance differs from configured source',
    );
    expect(s.adapt).not.toHaveBeenCalled();
  },
);
it('blocks admission on publisher failure without using an older publication', async () => {
  const s = await setup();
  s.fetcher.mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Fresh knowledge publication unavailable',
  );
  expect(s.adapt).not.toHaveBeenCalled();
});
it('stops reading and cancels an oversized publication response', async () => {
  const s = await setup();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel,
  });
  const response = new Response(body);
  const text = vi.spyOn(response, 'text');
  s.fetcher.mockResolvedValue(response);
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Publication response too large',
  );
  expect(text).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(s.adapt).not.toHaveBeenCalled();
});
it.each(['content', 'manifest', 'extra', 'symlink', 'foreign'])(
  'rejects %s tampering before adapter invocation',
  async (kind) => {
    const s = await setup();
    if (kind === 'content') await writeFile(join(s.directory, 'source/AGENTS.md'), 'corrupt');
    if (kind === 'manifest') await writeFile(join(s.directory, 'manifest.json'), '{}');
    if (kind === 'extra') await writeFile(join(s.directory, 'source/extra.md'), 'unaccepted');
    if (kind === 'symlink') {
      await rm(join(s.directory, 'source/AGENTS.md'));
      await symlink(join(s.directory, 'context.json'), join(s.directory, 'source/AGENTS.md'));
    }
    if (kind === 'foreign')
      s.fetcher.mockResolvedValue(
        new Response(JSON.stringify({ current: { ...s.selection, directory: s.root } })),
      );
    await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow();
    expect(s.adapt).not.toHaveBeenCalled();
  },
);
it('rejects a bundle from another revision', async () => {
  const s = await setup();
  s.adapt.mockResolvedValue({ seed: '/private/bundle/mgmt', sourceCommit: 'b'.repeat(40) });
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Bundle revision differs',
  );
});

it('blocks adapter Markdown outside the publisher path policy', async () => {
  const s = await setup();
  const seed = join(s.root, 'bundle/mgmt');
  await writeFile(join(seed, 'private.md'), 'unselected private information');
  await writeFile(
    join(seed, '..', 'baseline.json'),
    JSON.stringify({
      files: { 'private.md': { sha256: hash('unselected private information'), mode: '0644' } },
    }),
  );
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Bundle Markdown differs from published source policy',
  );
});
it('blocks an adapter bundle that omits published Markdown', async () => {
  const s = await setup();
  const seed = join(s.root, 'bundle/mgmt');
  await rm(join(seed, 'AGENTS.md'));
  await writeFile(join(seed, '..', 'baseline.json'), JSON.stringify({ files: {} }));
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Bundle Markdown differs from published source policy',
  );
});

it('rejects manifest files outside its configured source paths even with valid hashes', async () => {
  const s = await setup();
  const content = 'unselected private information';
  await writeFile(join(s.directory, 'source/private.md'), content);
  const context = '{}';
  const raw = JSON.stringify({
    schema: 'contexgin-portable-v1',
    source: s.source.id,
    acceptedRef: s.source.ref,
    sourceIdentity: hash(JSON.stringify(s.source)),
    revision: s.selection.revision,
    paths: s.source.paths,
    files: [{ path: 'private.md', sha256: hash(content), bytes: Buffer.byteLength(content) }],
    contextSha256: hash(context),
  });
  await rm(join(s.directory, 'source/AGENTS.md'));
  await writeFile(join(s.directory, 'manifest.json'), raw);
  s.fetcher.mockResolvedValue(
    new Response(JSON.stringify({ current: { ...s.selection, manifestSha256: hash(raw) } })),
  );
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Publication files differ from configured source paths',
  );
  expect(s.adapt).not.toHaveBeenCalled();
});

it('bounds publication transport diagnostics and never adopts stale knowledge', async () => {
  const s = await setup();
  for (const failure of [
    new Response('Bearer secret https://private.example', { status: 503 }),
    new Error('Bearer secret https://private.example'),
  ]) {
    if (failure instanceof Response) s.fetcher.mockResolvedValueOnce(failure);
    else s.fetcher.mockRejectedValueOnce(failure);
    await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toBeInstanceOf(
      KnowledgePublicationUnavailableError,
    );
    await expect(s.adapt).not.toHaveBeenCalled();
  }
});
