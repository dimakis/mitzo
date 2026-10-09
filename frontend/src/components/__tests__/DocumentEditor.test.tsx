import React from 'react';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentEditor } from '../DocumentEditor';
import { EditorView } from '@codemirror/view';
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function keyboardDevice() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}
function setup(ext = '.md') {
  const change = vi.fn();
  render(
    <DocumentEditor
      content="hello"
      ext={ext}
      onChange={change}
      saving={false}
      onSave={vi.fn()}
      undo={vi.fn()}
      redo={vi.fn()}
      canUndo={false}
      canRedo={false}
    />,
  );
  return change;
}
describe('document editor', () => {
  it('formats the selected Markdown and preserves selection', () => {
    const change = setup();
    const input = screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement;
    input.setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(change).toHaveBeenCalledWith('**hello**');
  });
  it('previews unsaved Markdown and returns to source', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(within(screen.getByLabelText('Unsaved preview')).getByText('hello')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
  it('previews unsaved HTML in the sandboxed preview', () => {
    setup('.html');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTitle('Document preview').getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
  });
});

it('uses the viewer link policy in unsaved Markdown previews', () => {
  render(
    <DocumentEditor
      content="[Notes](notes.md)"
      ext=".md"
      onChange={vi.fn()}
      saving={false}
      onSave={vi.fn()}
      undo={vi.fn()}
      redo={vi.fn()}
      canUndo={false}
      canRedo={false}
      markdownComponents={{
        a: ({ children }) => <a href="/files?path=notes.md&sessionId=original">{children}</a>,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.getByRole('link', { name: 'Notes' }).getAttribute('href')).toBe(
    '/files?path=notes.md&sessionId=original',
  );
});

it('offers remembered Vim and fullscreen while keeping split view available', () => {
  setup();
  expect(screen.getByRole('button', { name: 'Standard' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  expect(
    screen
      .getByRole('region', { name: 'Document editor' })
      .classList.contains('document-editor--fullscreen'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Split' }));
  expect(screen.getByRole('textbox', { name: 'Document source' })).toBeTruthy();
  expect(screen.getByLabelText('Unsaved preview')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
  expect(
    screen
      .getByRole('region', { name: 'Document editor' })
      .classList.contains('document-editor--fullscreen'),
  ).toBe(false);
});

it('keeps the touch source mounted and its selection through preview', () => {
  setup();
  const input = screen.getByRole('textbox', { name: 'Document source' }) as HTMLTextAreaElement;
  input.setSelectionRange(1, 4);
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByRole('textbox', { name: 'Document source' })).toBe(input);
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(4);
});

it('blocks touch keyboard undo and redo while saving', () => {
  const undo = vi.fn();
  const redo = vi.fn();
  render(
    <DocumentEditor
      content="hello"
      ext=".md"
      onChange={vi.fn()}
      saving
      onSave={vi.fn()}
      undo={undo}
      redo={redo}
      canUndo
      canRedo
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Document source' });
  fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
  fireEvent.keyDown(input, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(undo).not.toHaveBeenCalled();
  expect(redo).not.toHaveBeenCalled();
});

it('uses a keyboard editor and quiet Vim toolbar on a narrow desktop', async () => {
  keyboardDevice();
  setup();
  expect((await screen.findByRole('textbox', { name: 'Document source' })).tagName).not.toBe(
    'TEXTAREA',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
  expect(screen.getByRole('status', { name: 'Vim mode' }).textContent).toBe('NORMAL');
  expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Relative line numbers' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
});

it('lets a touch user explicitly enable Vim and return to Standard', async () => {
  setup();
  expect(screen.getByRole('textbox', { name: 'Document source' }).tagName).toBe('TEXTAREA');
  fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
  expect(screen.getByRole('status', { name: 'Vim mode' }).textContent).toBe('NORMAL');
  await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.click(screen.getByRole('button', { name: 'Standard' }));
  expect(screen.queryByRole('status', { name: 'Vim mode' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Document source' }).textContent).toBe('hello');
});

it('shows save feedback and recovery controls inside fullscreen', () => {
  render(
    <DocumentEditor
      content="hello"
      ext=".md"
      onChange={vi.fn()}
      saving={false}
      onSave={vi.fn()}
      undo={vi.fn()}
      redo={vi.fn()}
      canUndo={false}
      canRedo={false}
      fullscreenStatus={
        <div role="alert">
          Save failed — your draft is preserved<button>Review latest version</button>
        </div>
      }
    />,
  );
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  expect(screen.getByRole('alert').textContent).toContain('Save failed');
  expect(screen.getByRole('button', { name: 'Review latest version' })).toBeTruthy();
});

it('shares keyboard source history with toolbar undo after preview and Vim switches', async () => {
  keyboardDevice();
  const change = setup();
  const input = await screen.findByRole('textbox', { name: 'Document source' });
  const view = EditorView.findFromDOM(input)!;
  act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
  expect(view.state.doc.toString()).toBe('**hello**');
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(change).toHaveBeenLastCalledWith('hello');
  fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
  expect(change).toHaveBeenLastCalledWith('**hello**');
  expect(screen.getByRole('textbox', { name: 'Document source' })).toBe(input);
});
