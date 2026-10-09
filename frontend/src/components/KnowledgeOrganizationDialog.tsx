import { useEffect, useRef, useState } from 'react';
import { KnowledgeTree } from './KnowledgeTree';
export function KnowledgeOrganizationDialog({
  mode,
  directories,
  initialParent,
  source,
  busy,
  error,
  canChoose,
  onSubmit,
  onClose,
}: {
  mode: 'folder' | 'move';
  directories: string[];
  initialParent: string;
  source?: string;
  busy: boolean;
  error?: string;
  canChoose(path: string): boolean;
  onSubmit(path: string): boolean;
  onClose(): void;
}) {
  const [parent, setParent] = useState(initialParent);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const title = mode === 'folder' ? 'New folder' : 'Move document';
  const leaf = mode === 'folder' ? name.trim() : source!.split('/').pop()!;
  const destination = parent ? `${parent}/${leaf}` : '';
  const valid =
    !!parent &&
    !!leaf &&
    !leaf.includes('/') &&
    !leaf.includes('\\') &&
    leaf !== '.' &&
    leaf !== '..' &&
    canChoose(destination) &&
    destination !== source;
  const choices = directories.filter((directory) =>
    canChoose(`${directory}/${mode === 'move' ? leaf : 'new-folder'}`),
  );
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="knowledge-dialog-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="knowledge-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onClose();
          if (event.key === 'Tab') {
            const controls = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)',
            );
            if (!controls?.length) return;
            const first = controls[0],
              last = controls[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === ref.current)
            ) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2>{title}</h2>
        {source && <p className="workspace-muted">{source}</p>}
        <p>Choose {mode === 'folder' ? 'the parent folder' : 'a destination folder'}.</p>
        <KnowledgeTree
          documents={[]}
          directories={choices}
          folderChoices
          selectedFolder={parent}
          busy={busy}
          onFolder={setParent}
        />
        {!choices.length && <p className="workspace-muted">No eligible folders are available.</p>}
        <p className="knowledge-dialog-parent">
          {parent ? `Selected folder: ${parent}` : 'Select a folder to continue.'}
        </p>
        {mode === 'folder' && (
          <label>
            Folder name
            <input
              aria-label="Folder name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="knowledge-editor-actions">
          <button disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || !valid}
            onClick={() => {
              if (onSubmit(destination)) onClose();
            }}
          >
            {mode === 'folder' ? 'Create folder' : 'Move here'}
          </button>
        </div>
      </div>
    </div>
  );
}
