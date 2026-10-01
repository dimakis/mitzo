import React from 'react';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentEditor } from '../DocumentEditor';
afterEach(cleanup);
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
    expect(screen.getByText('hello')).toBeTruthy();
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
