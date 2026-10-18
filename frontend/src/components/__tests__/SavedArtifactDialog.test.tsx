// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from '@testing-library/react';
import { SavedArtifactDialog } from '../SavedArtifactDialog';
import type { TodoOutput } from '../../types/todo';
import { apiFetch } from '../../lib/api-fetch';
import { installDialogStub } from './dialog-stub';
import { shareFile } from '../../lib/share-file';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/share-file', () => ({
  shareFile: vi.fn().mockResolvedValue(true),
  downloadFile: vi.fn().mockResolvedValue(true),
}));
function render(element: ReactElement) {
  return renderComponent(element, { wrapper: MemoryRouter });
}
const id = 'a'.repeat(32);
const version = (revision: number): TodoOutput => ({
  id,
  itemId: 'work',
  filename: 'plan.md',
  title: 'Plan',
  revision,
  sha256: String(revision).repeat(64),
  size: 40,
  url: `/api/telos/artifacts/${id}?revision=${revision}`,
  sessionId: 'gone-source',
  sourceKind: 'session_artifact',
  sourcePath: '/retained/plan.md',
  createdAt: '2026-10-17T10:00:00Z',
});
function response(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body } as Response;
}
function doc(revision: number) {
  return {
    path: version(revision).url,
    name: 'plan.md',
    ext: '.md',
    revision,
    content: `# Version ${revision}\n\nExact saved text ${revision}.`,
    editable: true,
    previewUnavailable: false,
  };
}
beforeEach(() => {
  installDialogStub();
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/versions')
      ? response({ artifacts: [version(3), version(2), version(1)], hasMore: false, cursor: null })
      : response(doc(Number(new URL(String(url), 'http://fixture').searchParams.get('revision')))),
  );
});
afterEach(cleanup);
it('opens the selected saved revision, changes versions explicitly and exports the older pinned URL', async () => {
  const user = userEvent.setup();
  await act(async () => {
    render(<SavedArtifactDialog artifact={version(2)} onClose={vi.fn()} />);
  });
  await screen.findByRole('heading', { name: 'Version 2' });
  const picker = screen.getByRole('combobox', { name: 'Version' });
  expect((picker as HTMLSelectElement).value).toBe('2');
  expect(screen.getByRole('option', { name: /Saved version 3/ })).toBeTruthy();
  await user.selectOptions(picker, '1');
  await screen.findByRole('heading', { name: 'Version 1' });
  await user.click(screen.getByRole('button', { name: 'File options' }));
  await user.click(screen.getByRole('button', { name: 'Share file' }));
  await waitFor(() => expect(shareFile).toHaveBeenCalledWith(version(1).url));
  expect(screen.queryByRole('button', { name: /Share saved version/ })).toBeNull();
});
it('never replaces the selected revision with the latest after a source chat is unavailable', async () => {
  render(<SavedArtifactDialog artifact={version(1)} onClose={vi.fn()} />);
  await screen.findByRole('heading', { name: 'Version 1' });
  expect(apiFetch).not.toHaveBeenCalledWith(
    expect.stringContaining('/sessions/'),
    expect.anything(),
  );
  expect(screen.getByText(/Saving under Work does not deliver/)).toBeTruthy();
  fireEvent.click(screen.getByText('Provenance'));
  expect(screen.getByText('gone-source')).toBeTruthy();
});
it('rejects a preview response for a different saved revision and preserves selection on retry', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/versions')
      ? response({ artifacts: [version(2), version(1)], hasMore: false, cursor: null })
      : response(doc(2)),
  );
  render(<SavedArtifactDialog artifact={version(1)} onClose={vi.fn()} />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: 'Version 2' })).toBeNull();
  expect((screen.getByRole('combobox', { name: 'Version' }) as HTMLSelectElement).value).toBe('1');
});
it('ignores a late old-version preview and keeps unavailable reads explicit', async () => {
  let resolveOld!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('/versions'))
      return response({ artifacts: [version(2), version(1)], hasMore: false, cursor: null });
    if (String(url).endsWith('revision=2'))
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    return response(doc(1));
  });
  render(<SavedArtifactDialog artifact={version(2)} onClose={vi.fn()} />);
  await screen.findByRole('option', { name: /Saved version 1/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
  await screen.findByRole('heading', { name: 'Version 1' });
  await act(async () => resolveOld(response(doc(2))));
  expect(screen.queryByRole('heading', { name: 'Version 2' })).toBeNull();
});

it('refreshes the newest history page on reopen without changing the selected older revision', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('/versions'))
      return String(url).includes('beforeRevision=2')
        ? response({ artifacts: [version(1)], cursor: null, hasMore: false })
        : response({ artifacts: [version(2)], cursor: 2, hasMore: true });
    return response(
      doc(Number(new URL(String(url), 'http://fixture').searchParams.get('revision'))),
    );
  });
  const close = vi.fn();
  function Controlled({ open }: { open: boolean }) {
    const [artifact, setArtifact] = useState<TodoOutput>(version(2));
    return (
      <SavedArtifactDialog
        artifact={artifact}
        onVersionChange={setArtifact}
        onClose={close}
        open={open}
      />
    );
  }
  const view = render(<Controlled open />);
  await screen.findByRole('button', { name: 'Earlier versions' });
  fireEvent.click(screen.getByRole('button', { name: 'Earlier versions' }));
  await screen.findByRole('option', { name: /Saved version 1/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
  await screen.findByRole('heading', { name: 'Version 1' });
  view.rerender(<Controlled open={false} />);
  view.rerender(<Controlled open />);
  await waitFor(() => {
    const historyCalls = vi
      .mocked(apiFetch)
      .mock.calls.filter(([url]) => String(url).includes('/versions'));
    expect(historyCalls.at(-1)?.[0]).toBe(`/api/telos/artifacts/${id}/versions`);
  });
  expect((screen.getByRole('combobox', { name: 'Version' }) as HTMLSelectElement).value).toBe('1');
});

it('refuses a changed hash for the selected saved revision before preview hydration', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/versions')
      ? response({
          artifacts: [{ ...version(1), sha256: '0'.repeat(64) }],
          cursor: null,
          hasMore: false,
        })
      : response(doc(1)),
  );
  render(<SavedArtifactDialog artifact={version(1)} onClose={vi.fn()} />);
  await screen.findByRole('alert');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/document'))).toBe(
    false,
  );
});

it('links only the actual retained Work item without creating an association', async () => {
  render(<SavedArtifactDialog artifact={version(1)} onClose={vi.fn()} />);
  await screen.findByRole('heading', { name: 'Version 1' });
  expect(screen.getByRole('link', { name: 'Open Work item' }).getAttribute('href')).toBe(
    '/todos/work',
  );
  expect(
    vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});
