import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { KnowledgePublicationBridge } from '../knowledge-publication-bridge.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-publication-')));
  roots.push(root);
  const source = {
    id: 'notes',
    url: 'https://example.com/notes.git',
    ref: 'refs/heads/main',
    paths: ['AGENTS.md'],
  };
  const revision = 'a'.repeat(40);
  const directory = join(root, 'notes', 'snapshot-' + revision);
  await mkdir(join(directory, 'source'), { recursive: true });
  const content = '# Accepted instructions';
  const context = '{}';
  await writeFile(join(directory, 'source/AGENTS.md'), content);
  await writeFile(join(directory, 'context.json'), context);
  const manifest = {
    schema: 'contexgin-portable-v1',
    source: 'notes',
    acceptedRef: source.ref,
    sourceIdentity: hash(JSON.stringify(source)),
    revision,
    paths: source.paths,
    files: [{ path: 'AGENTS.md', sha256: hash(content), bytes: Buffer.byteLength(content) }],
    contextSha256: hash(context),
  };
  const raw = JSON.stringify(manifest);
  await writeFile(join(directory, 'manifest.json'), raw);
  const selection = { directory, revision, manifestSha256: hash(raw) };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ current: selection }), { status: 200 }));
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
it('uses authenticated canonical reconciliation and passes only a verified exact revision to the adapter', async () => {
  const s = await setup();
  const result = await s.bridge.reconcile(new AbortController().signal);
  expect(result.sourceCommit).toBe(s.selection.revision);
  expect(s.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8643/api/publications/notes/reconcile');
  expect(s.fetcher.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: { authorization: 'Bearer host-secret' },
  });
  expect(s.adapt.mock.calls[0][0]).toEqual(s.selection);
});
it('blocks admission on publisher failure without using an older publication', async () => {
  const s = await setup();
  s.fetcher.mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(s.bridge.reconcile(new AbortController().signal)).rejects.toThrow(
    'Fresh knowledge publication unavailable',
  );
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
