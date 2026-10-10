import React from 'react';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentEditor } from '../DocumentEditor';
import { EditorView } from '@codemirror/view';
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const originalRangeBounds = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect',
);
beforeEach(() => {
  localStorage.clear();
  // jsdom has no layout engine; CodeMirror measures selection ranges asynchronously.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ['getClientRects', originalRangeRects],
    ['getBoundingClientRect', originalRangeBounds],
  ] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
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
  it('groups view, key preferences and formatting with named icon actions', async () => {
    keyboardDevice();
    setup();
    await screen.findByRole('textbox', { name: 'Document source' });
    const views = screen.getByRole('group', { name: 'Editor view' });
    const keys = screen.getByRole('group', { name: 'Editing keys' });
    const history = screen.getByRole('group', { name: 'Edit history' });
    const formatting = screen.getByRole('group', { name: 'Markdown formatting' });
    expect(
      within(views)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Source', 'Preview', 'Split']);
    expect(within(keys).getByText('Keys')).toBeTruthy();
    expect(within(keys).getByRole('button', { name: 'Relative line numbers' })).toBeTruthy();
    expect(within(keys).queryByRole('button', { name: 'Undo' })).toBeNull();
    for (const name of ['Undo', 'Redo']) {
      const button = within(history).getByRole('button', { name });
      expect(button.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
      expect(button.textContent).toBe('');
      expect(button.getAttribute('title')).toContain(name);
    }
    for (const name of ['Bold', 'Italic', 'Inline code', 'Heading', 'List', 'Link']) {
      const button = within(formatting).getByRole('button', { name });
      expect(button.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
      expect(button.textContent).toBe('');
      expect(button.getAttribute('title')).toContain(name);
    }
    const fullscreen = screen.getByRole('button', { name: 'Fullscreen' });
    expect(fullscreen.querySelector('svg[data-icon="fullscreen"]')).toBeTruthy();
    fireEvent.click(fullscreen);
    expect(
      screen
        .getByRole('button', { name: 'Exit fullscreen' })
        .querySelector('svg[data-icon="fullscreenExit"]'),
    ).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.textContent).toBe('Save');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByRole('group', { name: 'Markdown formatting' })).toBeNull();
    expect(within(history).getByRole('button', { name: 'Undo' })).toBeTruthy();
  });
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

it('keeps Markdown formatting available with Vim keys on a narrow desktop', async () => {
  keyboardDevice();
  setup();
  expect((await screen.findByRole('textbox', { name: 'Document source' })).tagName).not.toBe(
    'TEXTAREA',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
  expect(screen.getByRole('status', { name: 'Vim mode' }).textContent).toBe('NORMAL');
  for (const view of ['Source', 'Split']) {
    fireEvent.click(screen.getByRole('button', { name: view }));
    for (const name of ['Bold', 'Italic', 'Inline code', 'Heading', 'List', 'Link'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
  }
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  for (const name of ['Bold', 'Italic', 'Inline code', 'Heading', 'List', 'Link'])
    expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.getByRole('button', { name: 'Vim' }).getAttribute('aria-pressed')).toBe('true');
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

it('keeps fullscreen source within the visual viewport when the touch keyboard opens', () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  const dialog = screen.getByRole('dialog', { name: 'Fullscreen document editor' });
  expect(dialog.style.height).toBe('700px');
  viewport.height = 350;
  viewport.offsetTop = 20;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect(dialog.style.height).toBe('350px');
  expect(dialog.style.top).toBe('20px');
  viewport.offsetTop = 35;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  expect(dialog.style.top).toBe('35px');
  fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
  expect(dialog.style.height).toBe('');
  expect(dialog.style.top).toBe('');
});

it('keeps fullscreen save and exit in a separate action group from scrolling controls', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  const actions = screen.getByRole('group', { name: 'Document actions' });
  expect(within(actions).getByRole('button', { name: 'Save' })).toBeTruthy();
  expect(within(actions).getByRole('button', { name: 'Exit fullscreen' })).toBeTruthy();
  expect(within(actions).queryByRole('button', { name: 'Split' })).toBeNull();
});

it('focuses keyboard source after Vim, view and fullscreen controls without moving selection', async () => {
  keyboardDevice();
  setup();
  const input = await screen.findByRole('textbox', { name: 'Document source' });
  const view = EditorView.findFromDOM(input)!;
  act(() => view.dispatch({ selection: { anchor: 1, head: 4 } }));
  const vim = screen.getByRole('button', { name: 'Vim' });
  vim.focus();
  fireEvent.click(vim);
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const split = screen.getByRole('button', { name: 'Split' });
  split.focus();
  fireEvent.click(split);
  expect(document.activeElement).toBe(input);
  const element = screen.getByRole('region', { name: 'Document editor' }).closest('dialog')!;
  Object.defineProperty(element, 'showModal', {
    value: () => screen.getByRole('button', { name: 'Source' }).focus(),
  });
  Object.defineProperty(element, 'close', { value: vi.fn() });
  const fullscreen = screen.getByRole('button', { name: 'Fullscreen' });
  fullscreen.focus();
  fireEvent.click(fullscreen);
  expect(document.activeElement).toBe(input);
  expect(view.state.selection.main.anchor).toBe(1);
  expect(view.state.selection.main.head).toBe(4);
  fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
  expect(document.activeElement).toBe(fullscreen);
});

it('contains long fullscreen feedback in the scrolling status area with accessible recovery actions', () => {
  const resolve = vi.fn();
  render(
    <DocumentEditor
      content="my draft"
      ext=".md"
      onChange={vi.fn()}
      saving={false}
      onSave={vi.fn()}
      undo={vi.fn()}
      redo={vi.fn()}
      canUndo={false}
      canRedo={false}
      fullscreenStatus={
        <section aria-label="Latest saved version">
          <pre>{'Latest saved document\n'.repeat(500)}</pre>
          <button onClick={resolve}>Keep my draft for next save</button>
        </section>
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  const feedback = screen.getByRole('region', { name: 'Latest saved version' });
  expect(feedback.parentElement?.className).toBe('document-editor-fullscreen-status');
  expect(screen.getByRole('textbox', { name: 'Document source' })).toBeTruthy();
  fireEvent.click(within(feedback).getByRole('button', { name: 'Keep my draft for next save' }));
  expect(resolve).toHaveBeenCalledOnce();
});

it('passes an explicit history reset through even when document content is unchanged', async () => {
  keyboardDevice();
  const props = {
    content: 'hello',
    ext: '.md',
    onChange: vi.fn(),
    saving: false,
    onSave: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    historyResetKey: 0,
  };
  const { rerender } = render(<DocumentEditor {...props} />);
  const input = await screen.findByRole('textbox', { name: 'Document source' });
  const view = EditorView.findFromDOM(input)!;
  act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
  rerender(<DocumentEditor {...props} content="**hello**" />);
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
  rerender(<DocumentEditor {...props} content="**hello**" historyResetKey={1} />);
  expect(view.state.doc.toString()).toBe('**hello**');
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['.html', '.txt'])('keeps Markdown controls hidden for %s with Vim keys', async (ext) => {
  keyboardDevice();
  setup(ext);
  await screen.findByRole('textbox', { name: 'Document source' });
  fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
  for (const view of ['Source', 'Split', 'Preview']) {
    fireEvent.click(screen.getByRole('button', { name: view }));
    for (const name of ['Bold', 'Italic', 'Inline code', 'Heading', 'List', 'Link'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  }
});

it.each(['NORMAL', 'INSERT'])(
  'formats the keyboard selection and shares Undo/Redo while Vim starts in %s',
  async (mode) => {
    keyboardDevice();
    const change = setup();
    const input = await screen.findByRole('textbox', { name: 'Document source' });
    const view = EditorView.findFromDOM(input)!;
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
    if (mode === 'INSERT') {
      fireEvent.keyDown(input, { key: 'i' });
      act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    }
    expect(screen.getByRole('status', { name: 'Vim mode' }).textContent).toBe(mode);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(view.state.doc.toString()).toBe('**hello**');
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(7);
    expect(change).toHaveBeenLastCalledWith('**hello**');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(view.state.doc.toString()).toBe('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(view.state.doc.toString()).toBe('**hello**');
    expect(screen.getByRole('button', { name: 'Vim' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status', { name: 'Vim mode' })).toBeTruthy();
  },
);

it('shows all Markdown formatting controls disabled while saving in Vim', async () => {
  keyboardDevice();
  const change = vi.fn();
  render(
    <DocumentEditor
      content="hello"
      ext=".md"
      onChange={change}
      saving
      onSave={vi.fn()}
      undo={vi.fn()}
      redo={vi.fn()}
      canUndo={false}
      canRedo={false}
    />,
  );
  const input = await screen.findByRole('textbox', { name: 'Document source' });
  const view = EditorView.findFromDOM(input)!;
  fireEvent.click(screen.getByRole('button', { name: 'Vim' }));
  for (const name of ['Bold', 'Italic', 'Inline code', 'Heading', 'List', 'Link']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(view.state.doc.toString()).toBe('hello');
  expect(change).not.toHaveBeenCalled();
});
