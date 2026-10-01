import React, { useDeferredValue, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins } from '../lib/markdown-config';
import { HtmlPreview } from './HtmlPreview';

interface Props {
  content: string;
  ext: string;
  onChange(value: string): void;
  saving: boolean;
  onSave(): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
}
export function DocumentEditor(props: Props) {
  const { content, ext, onChange, saving, onSave, undo, redo, canUndo, canRedo } = props;
  const [mode, setMode] = useState<'source' | 'preview' | 'split'>('source');
  const input = useRef<HTMLTextAreaElement>(null);
  const preview = useDeferredValue(content);
  const markdown = ['.md', '.mdx', '.markdown'].includes(ext);
  const html = ['.html', '.htm'].includes(ext);
  function insert(before: string, after = '', placeholder = 'text') {
    const el = input.current;
    if (!el || saving) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    onChange(content.slice(0, start) + before + selected + after + content.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }
  return (
    <section className={`document-editor document-editor--${mode}`} aria-label="Document editor">
      <div className="document-editor-toolbar">
        <div className="document-editor-modes" aria-label="Editor view">
          {(['source', 'preview', 'split'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <button type="button" onClick={undo} disabled={saving || !canUndo} title="Undo (⌘/Ctrl Z)">
          Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={saving || !canRedo}
          title="Redo (⌘/Ctrl Shift Z)"
        >
          Redo
        </button>
        {markdown && mode !== 'preview' && (
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() => insert('**', '**')}
              aria-label="Bold"
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => insert('_', '_')}
              aria-label="Italic"
            >
              <em>I</em>
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => insert('`', '`')}
              aria-label="Inline code"
            >
              Code
            </button>
            <button type="button" disabled={saving} onClick={() => insert('## ', '', 'Heading')}>
              Heading
            </button>
            <button type="button" disabled={saving} onClick={() => insert('- ', '', 'List item')}>
              List
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => insert('[', '](https://)', 'Link text')}
            >
              Link
            </button>
          </>
        )}
      </div>
      <div className="document-editor-panes">
        {mode !== 'preview' && (
          <textarea
            ref={input}
            aria-label="Document source"
            className="viewer-editor"
            value={content}
            onChange={(event) => onChange(event.target.value)}
            readOnly={saving}
            autoFocus
            spellCheck={markdown}
            autoCapitalize="off"
            autoCorrect="off"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                onSave();
              } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
              } else if (
                (event.metaKey || event.ctrlKey) &&
                markdown &&
                event.key.toLowerCase() === 'b'
              ) {
                event.preventDefault();
                insert('**', '**');
              } else if (event.key === 'Tab') {
                event.preventDefault();
                insert('  ', '', '');
              }
            }}
          />
        )}
        {mode !== 'source' && (
          <div className="document-editor-preview" aria-label="Unsaved preview">
            {markdown ? (
              <div className="viewer-markdown">
                <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
                  {preview}
                </ReactMarkdown>
              </div>
            ) : html ? (
              <HtmlPreview html={preview} title="Document preview" />
            ) : (
              <pre className="viewer-code">{preview}</pre>
            )}
          </div>
        )}
      </div>
      <div className="document-editor-footer">
        {content.split('\n').length} lines · {content.length.toLocaleString()} characters
      </div>
    </section>
  );
}
