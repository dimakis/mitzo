import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap } from '@codemirror/search';
import { getCM, Vim, vim as vimExtension } from '@replit/codemirror-vim';
import './DocumentSourceEditor.css';

export type VimMode = 'NORMAL' | 'INSERT' | 'VISUAL';
export interface EditorHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}
export interface DocumentSourceEditorHandle {
  focus(): void;
  insert(before: string, after?: string, placeholder?: string): void;
  undo(): void;
  redo(): void;
}
interface Props {
  content: string;
  ext: string;
  onChange(content: string): void;
  saving: boolean;
  onSave(): void;
  vim: boolean;
  relativeLineNumbers: boolean;
  onModeChange?(mode: VimMode): void;
  onHistoryChange?(history: EditorHistoryState): void;
}

// Vim's Ex registry is shared. Route saves through the actual view rather than
// registering a closure for whichever document happened to mount last.
const saves = new WeakMap<EditorView, () => void>();
Vim.defineEx('write', 'w', (cm) => saves.get(cm.cm6)?.());

export const DocumentSourceEditor = forwardRef<DocumentSourceEditorHandle, Props>(
  function DocumentSourceEditor(props, ref) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const settings = useRef(new Compartment());
    const attachMode = useRef<(() => void) | null>(null);
    const resetState = useRef<((content: string) => void) | null>(null);

    function insert(before: string, after = '', placeholder = 'text') {
      const editor = view.current;
      if (!editor || latest.current.saving) return;
      const { from, to } = editor.state.selection.main;
      const selected = editor.state.sliceDoc(from, to) || placeholder;
      editor.dispatch({
        changes: { from, to, insert: before + selected + after },
        selection: EditorSelection.single(
          from + before.length,
          from + before.length + selected.length,
        ),
        annotations: isolateHistory.of('full'),
        userEvent: 'input',
      });
      editor.focus();
    }
    function moveHistory(command: typeof undo) {
      const editor = view.current;
      if (!editor || latest.current.saving) return;
      const cm = getCM(editor);
      const normal = cm?.state.vim && !cm.state.vim.insertMode && !cm.state.vim.visualMode;
      command(editor);
      // Restoring an old selection can make the Vim adapter enter Visual mode.
      // Toolbar history must retain a caller's Normal mode like Vim's u/C-r.
      if (normal && cm?.state.vim?.visualMode) {
        Vim.exitVisualMode(cm as Parameters<typeof Vim.exitVisualMode>[0]);
      }
    }
    useImperativeHandle(ref, () => ({
      focus: () => view.current?.focus(),
      insert,
      undo: () => moveHistory(undo),
      redo: () => moveHistory(redo),
    }));

    useLayoutEffect(() => {
      const compartment = settings.current;
      function historyChanged(editor: EditorView) {
        latest.current.onHistoryChange?.({
          canUndo: undoDepth(editor.state) > 0,
          canRedo: redoDepth(editor.state) > 0,
        });
      }
      function preferences() {
        const current = latest.current;
        return [
          current.vim ? vimExtension() : [],
          EditorState.readOnly.of(current.saving),
          EditorView.editable.of(!current.saving),
          EditorView.contentAttributes.of({
            'aria-label': 'Document source',
            'aria-readonly': String(current.saving),
            autocapitalize: 'off',
            autocorrect: 'off',
            spellcheck: 'false',
          }),
          lineNumbers({
            formatNumber: (line, state) => {
              const active = state.doc.lineAt(state.selection.main.head).number;
              return String(
                current.relativeLineNumbers && line !== active ? Math.abs(line - active) : line,
              );
            },
          }),
          ['.md', '.mdx', '.markdown'].includes(current.ext) ? markdown() : [],
        ];
      }
      const extensions = [
        history(),
        drawSelection(),
        highlightActiveLineGutter(),
        EditorView.lineWrapping,
        syntaxHighlighting(defaultHighlightStyle),
        // A facet alone does not block programmatic undo/redo. Protect all
        // document-changing transactions while the save request is in flight.
        EditorState.transactionFilter.of((transaction) =>
          transaction.docChanged && latest.current.saving ? [] : transaction,
        ),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                if (!latest.current.saving) latest.current.onSave();
                return true;
              },
            },
            {
              key: 'Mod-z',
              run: () => {
                moveHistory(undo);
                return true;
              },
            },
            {
              key: 'Mod-Shift-z',
              run: () => {
                moveHistory(redo);
                return true;
              },
            },
            {
              key: 'Mod-y',
              run: () => {
                moveHistory(redo);
                return true;
              },
            },
            {
              key: 'Mod-b',
              run: () => {
                if (
                  latest.current.vim ||
                  !['.md', '.mdx', '.markdown'].includes(latest.current.ext)
                )
                  return false;
                insert('**', '**');
                return true;
              },
            },
            {
              key: 'Tab',
              run: () => {
                const cm = view.current && getCM(view.current);
                if (latest.current.vim && !cm?.state.vim?.insertMode) return false;
                insert('  ', '', '');
                return true;
              },
            },
            ...historyKeymap,
          ]),
        ),
        keymap.of([...defaultKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          historyChanged(update.view);
        }),
        compartment.of(preferences()),
      ];
      const editor = new EditorView({
        state: EditorState.create({ doc: latest.current.content, extensions }),
        parent: host.current!,
      });
      view.current = editor;
      saves.set(editor, () => {
        if (!latest.current.saving) latest.current.onSave();
      });
      let unsubscribe = () => {};
      function listenMode() {
        unsubscribe();
        const cm = getCM(editor);
        if (!cm) {
          latest.current.onModeChange?.('NORMAL');
          return;
        }
        const changed = () => {
          const state = cm.state.vim;
          latest.current.onModeChange?.(
            state?.visualMode ? 'VISUAL' : state?.insertMode ? 'INSERT' : 'NORMAL',
          );
        };
        cm.on('vim-mode-change', changed);
        unsubscribe = () => cm.off('vim-mode-change', changed);
        changed();
      }
      attachMode.current = () => {
        editor.dispatch({ effects: compartment.reconfigure(preferences()) });
        listenMode();
      };
      resetState.current = (content) => {
        const selection = editor.state.selection.main;
        editor.setState(
          EditorState.create({
            doc: content,
            selection: EditorSelection.single(
              Math.min(selection.anchor, content.length),
              Math.min(selection.head, content.length),
            ),
            extensions,
          }),
        );
        // The old settings extension is retained in the factory; reconfigure
        // it to the latest props after resetting a conflict/reload replacement.
        attachMode.current?.();
        historyChanged(editor);
      };
      listenMode();
      historyChanged(editor);
      editor.focus();
      return () => {
        unsubscribe();
        saves.delete(editor);
        editor.destroy();
        view.current = null;
        attachMode.current = null;
        resetState.current = null;
      };
    }, []);

    useLayoutEffect(() => {
      attachMode.current?.();
    }, [props.vim, props.relativeLineNumbers, props.saving, props.ext]);

    useLayoutEffect(() => {
      if (view.current && props.content !== view.current.state.doc.toString()) {
        resetState.current?.(props.content);
      }
    }, [props.content]);

    return <div ref={host} className="document-source-editor" />;
  },
);
