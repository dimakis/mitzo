// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionDocuments } from '../SessionDocuments';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const saved = {
  id: 'a'.repeat(32),
  sessionId: 'one',
  title: 'Report',
  filename: 'report.md',
  revision: 1,
  sha256: 'b'.repeat(64),
  size: 8,
  sourceKey: 'file:/task/report.md',
  sourcePath: '/task/report.md',
  createdAt: 1,
};
const catalog = {
  saved: [],
  workspace: [{ path: '/task/report.md', title: 'Report', evidence: 'created' }],
  telos: [],
  discoveryLimit: 100,
};
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
it('previews then keeps exact bytes, exposes saved versions and never treats a workspace link as saved', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/preview'))
      return json({
        path: '/task/report.md',
        filename: 'report.md',
        sha256: saved.sha256,
        size: 8,
        content: '# Report',
      });
    if (String(url).endsWith('/keep')) {
      expect(JSON.parse(init!.body as string)).toMatchObject({
        source: { kind: 'file', path: '/task/report.md', sha256: saved.sha256 },
      });
      return json({ document: saved });
    }
    return json(catalog);
  });
  render(<SessionDocuments sessionId="one" drafts={[]} refreshKey={0} />);
  await screen.findByRole('button', { name: 'Preview Report' });
  expect(screen.queryByText('Saved · version 1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview Report' }));
  await screen.findByText('# Report');
  fireEvent.click(screen.getByRole('button', { name: 'Keep a copy' }));
  await screen.findByText('Saved · version 1');
  expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to documents' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Preview Report' })),
  );
});
it('preserves the original retry identity after an uncertain save and leaves failures visible', async () => {
  const ids: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/preview'))
      return json({
        path: '/task/report.md',
        filename: 'report.md',
        sha256: saved.sha256,
        size: 8,
        content: '# Report',
      });
    if (String(url).endsWith('/keep')) {
      ids.push(JSON.parse(init!.body as string).requestId);
      if (ids.length === 1) throw Error('Connection interrupted');
      return json({ document: saved });
    }
    return json(catalog);
  });
  render(<SessionDocuments sessionId="one" drafts={[]} refreshKey={0} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview Report' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep a copy' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Keep a copy' }));
  await screen.findByText('Saved · version 1');
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});
it('discards late responses from a different conversation', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation((url) =>
    String(url).includes('/one/')
      ? new Promise((r) => {
          resolve = r;
        })
      : json({ ...catalog, workspace: [] }),
  );
  const view = render(<SessionDocuments sessionId="one" drafts={[]} refreshKey={0} />);
  view.rerender(<SessionDocuments sessionId="two" drafts={[]} refreshKey={0} />);
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(2));
  resolve(await json(catalog));
  await screen.findByText('No documents found yet.');
  expect(screen.queryByRole('button', { name: 'Preview Report' })).toBeNull();
});
it('loads older saved documents and earlier revisions without losing their selection', async () => {
  const latest = { ...saved, revision: 51 };
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/versions'))
      return json({
        versions: path.includes('before=2')
          ? [saved]
          : Array.from({ length: 50 }, (_, i) => ({ ...saved, revision: 51 - i })),
      });
    if (path.includes(`/saved/${saved.id}?`))
      return json({ document: path.includes('revision=1') ? saved : latest, content: '# Kept' });
    if (path.includes('/saved?'))
      return json({ documents: [latest], cursor: null, hasMore: false });
    return json({
      ...catalog,
      workspace: [],
      saved: [],
      savedCursor: { createdAt: 1, id: saved.id },
      savedHasMore: true,
    });
  });
  render(<SessionDocuments sessionId="one" drafts={[]} refreshKey={0} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load older saved documents' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Preview Report' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier versions' }));
  await screen.findByRole('option', { name: 'Version 1', exact: true });
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved version' }), {
    target: { value: '1' },
  });
  await screen.findByText('Saved · version 1');
  expect((screen.getByRole('combobox', { name: 'Saved version' }) as HTMLSelectElement).value).toBe(
    '1',
  );
});
it('pins the selected response while newer candidates arrive', async () => {
  const first = {
    content: 'First draft',
    source: { messageId: 'm1', blockId: 'b', messageEndSeq: 1, sha256: saved.sha256 },
  };
  const next = {
    content: 'Newer draft',
    source: { ...first.source, messageId: 'm2', messageEndSeq: 2 },
  };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/keep')) {
      expect(JSON.parse(init!.body as string).source.messageId).toBe('m1');
      return json({
        ...catalog,
        document: { ...saved, title: 'My draft', sourcePath: null, sourceKey: 'draft:m1:b' },
      });
    }
    return json({ ...catalog, workspace: [] });
  });
  const view = render(<SessionDocuments sessionId="one" drafts={[first]} refreshKey={0} />);
  fireEvent.click(screen.getByText('Keep a chat response'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Document title' }), {
    target: { value: 'My draft' },
  });
  view.rerender(<SessionDocuments sessionId="one" drafts={[next, first]} refreshKey={1} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep response' }));
  await screen.findByText('Saved · version 1');
});
it('retains an exact old selection when newer versions fill the first history page', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/versions'))
      return json({
        versions: path.includes('before=3')
          ? [{ ...saved, revision: 2 }, saved]
          : Array.from({ length: 50 }, (_, i) => ({ ...saved, revision: 52 - i })),
      });
    if (path.includes(`/saved/${saved.id}?`))
      return json({ document: saved, content: '# Original' });
    return json({ ...catalog, workspace: [], saved: [saved] });
  });
  render(<SessionDocuments sessionId="one" drafts={[]} refreshKey={0} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview Report' }));
  await screen.findByText('Saved · version 1');
  expect((screen.getByRole('combobox', { name: 'Saved version' }) as HTMLSelectElement).value).toBe(
    '1',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier versions' }));
  await screen.findByRole('option', { name: 'Version 2', exact: true });
});
