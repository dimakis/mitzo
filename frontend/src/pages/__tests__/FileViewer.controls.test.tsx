// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../FileViewer';

const mocks = vi.hoisted(() => ({
  editor: {
    editing: false,
    dirty: false,
    saving: false,
    reviewing: false,
    error: '',
    draftStorageError: '',
    latestContent: null as string | null,
    editContent: '# Document',
    resetEditor: vi.fn(),
    startEditing: vi.fn(),
    saveFile: vi.fn(),
    cancelEditing: vi.fn(),
    reviewLatest: vi.fn(),
    resolveConflict: vi.fn(),
    handleEditChange: vi.fn(),
  },
  reader: {
    available: true,
    state: 'idle',
    read: vi.fn(),
    stop: vi.fn(),
  },
  nav: {
    state: {
      content: '# Document',
      filePath: '/repo/document.md',
      currentDir: '/repo',
      ext: '.md',
      sessionId: 'session-1',
      isViewing: true,
      canGoUp: false,
      gitInfo: {
        branch: 'main',
        repoPath: '/repo',
        worktreesLoaded: false,
        worktrees: [{ path: '/repo/feature', branch: 'feature', name: 'feature', age: 'today' }],
      },
      roots: [{ path: '/repo', label: 'Repository' }],
      activeRoot: '/repo',
      worktreesLoading: false,
      worktreesError: '',
      loading: false,
      error: '',
      entries: [],
    },
    setContent: vi.fn(),
    setError: vi.fn(),
    loadWorktrees: vi.fn(),
    handleBack: vi.fn(),
    handleRootChange: vi.fn(),
  },
}));

vi.mock('../../hooks/useFileNavigation', () => ({ useFileNavigation: () => mocks.nav }));
vi.mock('../../hooks/useFileEditor', () => ({ useFileEditor: () => mocks.editor }));
vi.mock('../../hooks/useDocumentReader', () => ({ useDocumentReader: () => mocks.reader }));
vi.mock('../../hooks/useEditorViewport', () => ({ useEditorViewport: () => ({ current: null }) }));
vi.mock('../../components/DocumentEditor', () => ({
  DocumentEditor: () => <div>Document editor</div>,
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.editor, {
    editing: false,
    dirty: false,
    saving: false,
    error: '',
    draftStorageError: '',
    latestContent: null,
  });
  mocks.reader.state = 'idle';
  Object.assign(mocks.nav.state, {
    isViewing: true,
    worktreesLoading: false,
    loading: false,
    error: '',
  });
});

function showViewer() {
  return render(
    <MemoryRouter initialEntries={['/files?path=document.md']}>
      <FileViewer />
    </MemoryRouter>,
  );
}

describe('FileViewer quiet controls', () => {
  it('groups viewing actions and accents only Edit while preserving Read and Share', () => {
    showViewer();
    const actions = screen.getByRole('group', { name: 'File actions' });
    const edit = within(actions).getByRole('button', { name: 'Edit' });
    expect(edit.className).toContain('viewer-header-action--primary');
    expect(within(actions).getByRole('button', { name: 'Read' }).className).not.toContain(
      '--primary',
    );
    expect(within(actions).getByRole('button', { name: 'Share file' })).toBeDefined();
    expect(within(actions).getByRole('button', { name: 'Download file' })).toBeDefined();
    fireEvent.click(edit);
    fireEvent.click(within(actions).getByRole('button', { name: 'Read' }));
    expect(mocks.editor.startEditing).toHaveBeenCalledOnce();
    expect(mocks.reader.read).toHaveBeenCalledWith('# Document');
  });

  it('keeps Stop and loading feedback accessible', () => {
    mocks.reader.state = 'playing';
    const view = showViewer();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stop);
    expect(mocks.reader.stop).toHaveBeenCalledOnce();
    mocks.reader.state = 'loading';
    view.rerender(
      <MemoryRouter>
        <FileViewer />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Loading...' }).hasAttribute('disabled')).toBe(true);
  });

  it('labels dirty Discard as destructive and keeps clean Done neutral', () => {
    mocks.editor.editing = true;
    mocks.editor.dirty = true;
    const view = showViewer();
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(discard.className).toContain('viewer-header-action--danger');
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('--primary');
    fireEvent.click(discard);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.editor.cancelEditing).toHaveBeenCalledOnce();
    expect(mocks.editor.saveFile).toHaveBeenCalledWith(mocks.nav.setContent);
    mocks.editor.dirty = false;
    view.rerender(
      <MemoryRouter>
        <FileViewer />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Done' }).className).not.toContain('--danger');
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('blocks header actions during save without losing draft or conflict feedback', () => {
    Object.assign(mocks.editor, {
      editing: true,
      dirty: true,
      saving: true,
      error: 'Changed on disk',
      latestContent: '# Latest',
    });
    showViewer();
    expect(screen.getByRole('button', { name: 'Saving...' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Changed on disk');
    expect(screen.getByRole('region', { name: 'Latest saved version' }).textContent).toContain(
      '# Latest',
    );
    expect(screen.queryByRole('button', { name: 'Share file' })).toBeNull();
  });

  it('exposes selected workspace state and keeps worktree discovery usable', () => {
    mocks.nav.state.isViewing = false;
    showViewer();
    const choices = screen.getByRole('group', { name: 'Workspace roots and worktrees' });
    const root = within(choices).getByRole('button', { name: 'Repository' });
    const branch = within(choices).getByRole('button', { name: 'feature' });
    expect(root.getAttribute('aria-pressed')).toBe('true');
    expect(branch.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(branch);
    fireEvent.click(screen.getByRole('button', { name: 'Worktrees' }));
    expect(mocks.nav.handleRootChange).toHaveBeenCalledWith('/repo/feature', false);
    expect(mocks.nav.loadWorktrees).toHaveBeenCalledOnce();
  });
});
