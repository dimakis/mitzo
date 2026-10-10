import React, { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import { remarkPlugins, rehypePlugins } from '../lib/markdown-config';
import { HtmlPreview } from './HtmlPreview';
import type { DocumentSourceEditorHandle } from './DocumentSourceEditor';
import { useDocumentEditorPreferences } from '../hooks/useDocumentEditorPreferences';
import { UiIcon } from './UiIcon';

const DocumentSourceEditor = lazy(async () => ({
  default: (await import('./DocumentSourceEditor')).DocumentSourceEditor,
}));

interface Props {
  saveLabel?: string;
  fullscreenStatus?: React.ReactNode;
  historyResetKey?: number;
  markdownComponents?: Components;
  urlTransform?: UrlTransform;
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
  const sourcePane = useRef<HTMLDivElement>(null);
  const source = useRef<DocumentSourceEditorHandle>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const modal = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const preferences = useDocumentEditorPreferences();
  // Once explicitly enabled on touch, retain the keyboard editor and its history
  // for this editing session even when returning to Standard.
  const [activatedKeyboard, setActivatedKeyboard] = useState(
    preferences.keyboard || preferences.vim,
  );
  const useKeyboard = activatedKeyboard || preferences.keyboard || preferences.vim;
  const [vimMode, setVimMode] = useState<'NORMAL' | 'INSERT' | 'VISUAL'>('NORMAL');
  const [sourceHistory, setSourceHistory] = useState({ canUndo: false, canRedo: false });

  useEffect(() => {
    const element = dialog.current;
    if (!element || typeof element.showModal !== 'function') return;
    if (fullscreen) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      element.close();
      element.showModal();
      modal.current = true;
      if (!sourcePane.current?.hidden) source.current?.focus();
    } else if (modal.current) {
      element.close();
      modal.current = false;
      element.setAttribute('open', '');
      restoreFocus.current?.focus();
    }
  }, [fullscreen]);

  useEffect(() => {
    const element = dialog.current;
    const viewport = window.visualViewport;
    if (!fullscreen || !element || !viewport) return;
    const resize = () => {
      element.style.height = `${viewport.height}px`;
      element.style.top = `${viewport.offsetTop}px`;
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
      element.style.height = '';
      element.style.top = '';
    };
  }, [fullscreen]);

  useEffect(() => {
    // Keyboard users can continue typing after choosing keys or a source view.
    // Do not open a software keyboard just because touch fullscreen was selected.
    if (mode !== 'preview') source.current?.focus();
  }, [mode, preferences.vim]);

  function selectVim(value: boolean) {
    if (value) setActivatedKeyboard(true);
    preferences.setVim(value);
  }
  function handleUndo() {
    if (saving) return;
    if (useKeyboard) source.current?.undo();
    else undo();
  }
  function handleRedo() {
    if (saving) return;
    if (useKeyboard) source.current?.redo();
    else redo();
  }
  const preview = useDeferredValue(content);
  const markdown = ['.md', '.mdx', '.markdown'].includes(ext);
  const html = ['.html', '.htm'].includes(ext);
  function insert(before: string, after = '', placeholder = 'text') {
    if (saving) return;
    if (useKeyboard) {
      source.current?.insert(before, after, placeholder);
      return;
    }
    const el = input.current;
    if (!el) return;
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
    <dialog
      ref={dialog}
      open
      className={`document-editor-dialog${fullscreen ? ' document-editor-dialog--fullscreen' : ''}`}
      role={fullscreen ? 'dialog' : 'none'}
      aria-label={fullscreen ? 'Fullscreen document editor' : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!preferences.vim) setFullscreen(false);
      }}
    >
      <section
        className={`document-editor document-editor--${mode}${fullscreen ? ' document-editor--fullscreen' : ''}${preferences.vim ? ' document-editor--vim' : ''}`}
        aria-label="Document editor"
      >
        <div className="document-editor-toolbar">
          <div className="document-editor-controls">
            <div
              className="document-editor-modes document-editor-views"
              role="group"
              aria-label="Editor view"
            >
              {(['source', 'preview', 'split'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="document-editor-control"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            <div className="document-editor-keys" role="group" aria-label="Editing keys">
              <span className="document-editor-label">Keys</span>
              <div className="document-editor-modes">
                <button
                  type="button"
                  className="document-editor-control"
                  aria-pressed={!preferences.vim}
                  onClick={() => selectVim(false)}
                >
                  Standard
                </button>
                <button
                  type="button"
                  className="document-editor-control"
                  aria-pressed={preferences.vim}
                  onClick={() => selectVim(true)}
                >
                  Vim
                </button>
              </div>
              {preferences.keyboard && (
                <button
                  type="button"
                  className="document-editor-control document-editor-relative-lines"
                  aria-label="Relative line numbers"
                  title="Relative line numbers"
                  aria-pressed={preferences.relativeLineNumbers}
                  onClick={() =>
                    preferences.setRelativeLineNumbers(!preferences.relativeLineNumbers)
                  }
                >
                  <span className="document-editor-toggle" aria-hidden="true">
                    {preferences.relativeLineNumbers && <UiIcon name="check" size={16} />}
                  </span>
                  Relative lines
                </button>
              )}
            </div>
          </div>
          <div className="document-editor-actions" role="group" aria-label="Document actions">
            <button
              type="button"
              className="document-editor-control document-editor-icon-control"
              onClick={() => setFullscreen(!fullscreen)}
              aria-pressed={fullscreen}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              <UiIcon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={16} />
            </button>
            {fullscreen && (
              <button
                type="button"
                className="document-editor-control document-editor-save"
                onClick={onSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : props.saveLabel || 'Save'}
              </button>
            )}
          </div>
        </div>
        <div className="document-editor-tools">
          <div className="document-editor-history" role="group" aria-label="Edit history">
            <button
              type="button"
              className="document-editor-control document-editor-icon-control"
              onClick={handleUndo}
              disabled={saving || !(useKeyboard ? sourceHistory.canUndo : canUndo)}
              title="Undo (⌘/Ctrl Z)"
              aria-label="Undo"
            >
              <UiIcon name="undo" size={16} />
            </button>
            <button
              type="button"
              className="document-editor-control document-editor-icon-control"
              onClick={handleRedo}
              disabled={saving || !(useKeyboard ? sourceHistory.canRedo : canRedo)}
              title="Redo (⌘/Ctrl Shift Z)"
              aria-label="Redo"
            >
              <UiIcon name="redo" size={16} />
            </button>
          </div>
          {markdown && mode !== 'preview' && (
            <div
              className="document-editor-formatting"
              role="group"
              aria-label="Markdown formatting"
            >
              <button
                type="button"
                className="document-editor-control document-editor-icon-control"
                disabled={saving}
                onClick={() => insert('**', '**')}
                aria-label="Bold"
                title="Bold (⌘/Ctrl B)"
              >
                <UiIcon name="bold" size={16} />
              </button>
              <button
                type="button"
                className="document-editor-control document-editor-icon-control"
                disabled={saving}
                onClick={() => insert('_', '_')}
                aria-label="Italic"
                title="Italic"
              >
                <UiIcon name="italic" size={16} />
              </button>
              <button
                type="button"
                className="document-editor-control document-editor-icon-control"
                disabled={saving}
                onClick={() => insert('`', '`')}
                aria-label="Inline code"
                title="Inline code"
              >
                <UiIcon name="code" size={16} />
              </button>
              <button
                type="button"
                className="document-editor-control document-editor-icon-control"
                disabled={saving}
                onClick={() => insert('## ', '', 'Heading')}
                aria-label="Heading"
                title="Heading"
              >
                <UiIcon name="heading" size={16} />
              </button>
              <button
                type="button"
                className="document-editor-control document-editor-icon-control"
                disabled={saving}
                onClick={() => insert('- ', '', 'List item')}
                aria-label="List"
                title="List"
              >
                <UiIcon name="list" size={16} />
              </button>
              <button
                type="button"
                className="document-editor-control document-editor-icon-control"
                disabled={saving}
                onClick={() => insert('[', '](https://)', 'Link text')}
                aria-label="Link"
                title="Link"
              >
                <UiIcon name="connections" size={16} />
              </button>
            </div>
          )}
        </div>
        {fullscreen && props.fullscreenStatus && (
          <div className="document-editor-fullscreen-status">{props.fullscreenStatus}</div>
        )}
        <div className="document-editor-panes">
          <div ref={sourcePane} className="document-editor-source" hidden={mode === 'preview'}>
            {useKeyboard ? (
              <Suspense fallback={<div role="status">Loading keyboard editor…</div>}>
                <DocumentSourceEditor
                  ref={source}
                  content={content}
                  historyResetKey={props.historyResetKey}
                  ext={ext}
                  onChange={onChange}
                  saving={saving}
                  onSave={onSave}
                  vim={preferences.vim}
                  relativeLineNumbers={preferences.keyboard && preferences.relativeLineNumbers}
                  onModeChange={setVimMode}
                  onHistoryChange={setSourceHistory}
                />
              </Suspense>
            ) : (
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
                    if (event.shiftKey) handleRedo();
                    else handleUndo();
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
          </div>
          {mode !== 'source' && (
            <div className="document-editor-preview" aria-label="Unsaved preview">
              {markdown ? (
                <div className="viewer-markdown">
                  <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    components={props.markdownComponents}
                    urlTransform={props.urlTransform}
                  >
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
          {preferences.vim && (
            <span className="document-editor-vim-mode" role="status" aria-label="Vim mode">
              {vimMode}
            </span>
          )}
          {content.split('\n').length} lines · {content.length.toLocaleString()} characters
        </div>
      </section>
    </dialog>
  );
}
