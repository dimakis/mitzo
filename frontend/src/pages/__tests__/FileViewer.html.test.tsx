import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('path=prototype.html'), vi.fn()],
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/files', search: '?path=prototype.html' }),
}));

let content = '<!doctype html><h1>Prototype</h1>';
let ext = '.html';
let filePath = 'prototype.html';

vi.mock('../../hooks/useFileNavigation', () => ({
  useFileNavigation: () => ({
    state: {
      content,
      ext,
      entries: [],
      currentDir: '',
      canGoUp: false,
      loading: false,
      error: '',
      gitInfo: null,
      roots: [],
      activeRoot: '',
      isViewing: true,
      filePath,
      dirPath: '',
      sessionId: 'session-1',
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
    content = '<!doctype html><h1>Prototype</h1>';
    ext = '.html';
    filePath = 'prototype.html';
    const markup = renderToStaticMarkup(createElement(FileViewer));

    expect(markup).toContain('<iframe');
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain('viewer-code');
  });

  it('routes relative Markdown links through the session-scoped Files viewer', () => {
    content = '[details](details.html)';
    ext = '.md';
    filePath = 'outputs/report.md';
    const markup = renderToStaticMarkup(createElement(FileViewer));
    expect(markup).toContain('path=outputs%2Fdetails.html');
    expect(markup).toContain('sessionId=session-1');
    expect(markup).not.toContain('href="details.html"');
  });

  it('preserves internal artifact links in Markdown', () => {
    content = '[details](file-path://%2Fsession-workspace%2Fdetails.html)';
    ext = '.md';
    filePath = 'outputs/report.md';
    const markup = renderToStaticMarkup(createElement(FileViewer));
    expect(markup).toContain('path=%2Fsession-workspace%2Fdetails.html');
    expect(markup).toContain('sessionId=session-1');
  });
});
