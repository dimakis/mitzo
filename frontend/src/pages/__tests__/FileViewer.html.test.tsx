import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('path=prototype.html'), vi.fn()],
  useNavigate: () => vi.fn(),
}));

vi.mock('../../hooks/useFileNavigation', () => ({
  useFileNavigation: () => ({
    state: {
      content: '<!doctype html><h1>Prototype</h1>',
      ext: '.html',
      entries: [],
      currentDir: '',
      loading: false,
      error: '',
      gitInfo: null,
      roots: [],
      activeRoot: '',
      isViewing: true,
      filePath: 'prototype.html',
      dirPath: '',
    },
    setContent: vi.fn(),
    setError: vi.fn(),
    openEntry: vi.fn(),
    goUp: vi.fn(),
    handleBack: vi.fn(),
    handleRootChange: vi.fn(),
  }),
}));

vi.mock('../../hooks/useFileEditor', () => ({
  useFileEditor: () => ({
    dirty: false,
    editing: false,
    saving: false,
    editContent: '',
    editorRef: { current: null },
    resetEditor: vi.fn(),
    startEditing: vi.fn(),
    saveFile: vi.fn(),
    cancelEditing: vi.fn(),
    handleEditChange: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDocumentReader', () => ({
  useDocumentReader: () => ({ available: false, state: 'idle', read: vi.fn(), stop: vi.fn() }),
}));

import { FileViewer } from '../FileViewer';

describe('FileViewer HTML rendering', () => {
  it('previews an HTML file in a sandboxed iframe instead of showing source text', () => {
    const markup = renderToStaticMarkup(createElement(FileViewer));

    expect(markup).toContain('<iframe');
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain('viewer-code');
  });
});
