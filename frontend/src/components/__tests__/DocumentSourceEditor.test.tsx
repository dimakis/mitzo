// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCM, Vim } from '@replit/codemirror-vim';
import { DocumentSourceEditor, type DocumentSourceEditorHandle } from '../DocumentSourceEditor';

afterEach(cleanup);
function setup(vim = false) {
  const ref = createRef<DocumentSourceEditorHandle>();
  const onChange = vi.fn();
  const onSave = vi.fn();
  const onModeChange = vi.fn();
  const onHistoryChange = vi.fn();
  const props = {
    content: 'hello\nworld',
    ext: '.md',
    saving: false,
    vim,
    relativeLineNumbers: false,
    onChange,
    onSave,
    onModeChange,
    onHistoryChange,
  };
  const rendered = render(<DocumentSourceEditor ref={ref} {...props} />);
  const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Document source' }))!;
  return { ...rendered, ref, view, props, onChange, onSave, onModeChange, onHistoryChange };
}
function key(view: EditorView, value: string) {
  const control = /^<C-(.)>$/.exec(value);
  fireEvent.keyDown(view.contentDOM, {
    key: value === '<Esc>' ? 'Escape' : control?.[1] || value,
    ctrlKey: !!control,
  });
}

describe('document source engine', () => {
  it('uses semantic Markdown token classes so syntax follows the active app theme', () => {
    const { ref, props, rerender, container } = setup();
    rerender(
      <DocumentSourceEditor
        ref={ref}
        {...props}
        content={'# Heading\n\n[Related](https://example.test)\n\n**Strong** and `code`'}
      />,
    );
    expect(
      [...container.querySelectorAll('.cm-source-heading')]
        .map((token) => token.textContent)
        .join(''),
    ).toContain('Heading');
    expect(
      [...container.querySelectorAll('.cm-source-link')].map((token) => token.textContent).join(''),
    ).toContain('Related');
    expect(
      [...container.querySelectorAll('.cm-source-strong')]
        .map((token) => token.textContent)
        .join(''),
    ).toContain('Strong');
    expect(
      [...container.querySelectorAll('.cm-source-code')].map((token) => token.textContent).join(''),
    ).toContain('code');
  });

  it('formats the selection and shares one undo/redo history with toolbar and keyboard', () => {
    const { view, ref, onChange, onHistoryChange } = setup();
    act(() => view.dispatch({ selection: EditorSelection.single(0, 5) }));
    act(() => ref.current!.insert('**', '**'));
    expect(view.state.doc.toString()).toBe('**hello**\nworld');
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(7);
    expect(onChange).toHaveBeenLastCalledWith('**hello**\nworld');
    expect(onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    fireEvent.keyDown(view.contentDOM, { key: 'z', ctrlKey: true });
    expect(view.state.doc.toString()).toBe('hello\nworld');
    act(() => ref.current!.redo());
    expect(view.state.doc.toString()).toBe('**hello**\nworld');
  });

  it('keeps selection and history across preference changes and controlled content echoes', () => {
    const { view, ref, props, rerender } = setup();
    act(() => view.dispatch({ selection: EditorSelection.single(1, 4) }));
    act(() => ref.current!.insert('_', '_'));
    rerender(
      <DocumentSourceEditor
        ref={ref}
        {...props}
        content={'h_ell_o\nworld'}
        vim
        relativeLineNumbers
      />,
    );
    expect(EditorView.findFromDOM(screen.getByRole('textbox'))).toBe(view);
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(5);
    act(() => ref.current!.undo());
    expect(view.state.doc.toString()).toBe('hello\nworld');
  });

  it('supports Vim modes, motion, operator, visual selection, undo and redo', () => {
    const { view, ref, onModeChange } = setup(true);
    expect(onModeChange).toHaveBeenLastCalledWith('NORMAL');
    key(view, 'l');
    expect(view.state.selection.main.head).toBe(1);
    key(view, 'v');
    key(view, 'l');
    expect(onModeChange).toHaveBeenLastCalledWith('VISUAL');
    expect(view.state.selection.main.empty).toBe(false);
    key(view, '<Esc>');
    key(view, 'd');
    key(view, 'd');
    expect(view.state.doc.toString()).toBe('world');
    act(() => ref.current!.undo());
    expect(view.state.doc.toString()).toBe('hello\nworld');
    expect(onModeChange).toHaveBeenLastCalledWith('NORMAL');
    key(view, '<C-r>');
    expect(view.state.doc.toString()).toBe('world');
    key(view, 'u');
    expect(view.state.doc.toString()).toBe('hello\nworld');
    key(view, 'i');
    expect(onModeChange).toHaveBeenLastCalledWith('INSERT');
    key(view, '<Esc>');
    expect(onModeChange).toHaveBeenLastCalledWith('NORMAL');
  });

  it('updates relative line numbers when only the cursor changes', async () => {
    const { view, ref, props, rerender, container } = setup(true);
    rerender(<DocumentSourceEditor ref={ref} {...props} relativeLineNumbers />);
    act(() => view.dispatch({ selection: EditorSelection.cursor(6) }));
    await waitFor(() => {
      const labels = [...container.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
        .filter((element) => !(element as HTMLElement).style.visibility)
        .map((element) => element.textContent);
      expect(labels).toEqual(['1', '2']);
    });
    act(() => view.dispatch({ selection: EditorSelection.cursor(0) }));
    await waitFor(() => {
      const labels = [...container.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
        .filter((element) => !(element as HTMLElement).style.visibility)
        .map((element) => element.textContent);
      expect(labels).toEqual(['1', '1']);
    });
  });

  it('leaves Vim Normal-mode Control-b and Tab available to Vim commands', () => {
    const { view, onChange } = setup(true);
    fireEvent.keyDown(view.contentDOM, { key: 'b', ctrlKey: true });
    fireEvent.keyDown(view.contentDOM, { key: 'Tab' });
    expect(view.state.doc.toString()).toBe('hello\nworld');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses the latest save callback for :w and the save shortcut', () => {
    const { view, ref, props, rerender } = setup(true);
    const latestSave = vi.fn();
    rerender(<DocumentSourceEditor ref={ref} {...props} onSave={latestSave} />);
    act(() => Vim.handleEx(getCM(view)! as Parameters<typeof Vim.handleEx>[0], 'w'));
    expect(latestSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true });
    expect(latestSave).toHaveBeenCalledTimes(2);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('blocks every document mutation while saving, including Vim, toolbar and native undo', () => {
    const { view, ref, props, rerender, onChange } = setup(true);
    act(() => ref.current!.insert('**', '**'));
    const original = view.state.doc.toString();
    onChange.mockClear();
    rerender(<DocumentSourceEditor ref={ref} {...props} content={original} saving />);
    act(() => ref.current!.undo());
    act(() => ref.current!.insert('_', '_'));
    key(view, 'u');
    key(view, 'd');
    key(view, 'd');
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'bad' } }));
    expect(view.state.doc.toString()).toBe(original);
    expect(onChange).not.toHaveBeenCalled();
    expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true');
  });

  it('reconciles external replacements without echoing or preserving obsolete undo history', () => {
    const { view, ref, props, rerender, onChange, onHistoryChange } = setup();
    act(() => ref.current!.insert('**', '**'));
    onChange.mockClear();
    rerender(<DocumentSourceEditor ref={ref} {...props} content="latest version" />);
    expect(view.state.doc.toString()).toBe('latest version');
    expect(onChange).not.toHaveBeenCalled();
    expect(onHistoryChange).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });
    act(() => ref.current!.undo());
    expect(view.state.doc.toString()).toBe('latest version');
  });
});
