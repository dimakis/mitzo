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
  canChooseParent,
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
  canChooseParent?(path: string): boolean;
  onSubmit(path: string): boolean | Promise<boolean>;
  onClose(): void;
}) {
  const [parent, setParent] = useState(initialParent);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const working = busy || submitting;
  const title = mode === 'folder' ? 'New folder' : 'Move document';
  const leaf = mode === 'folder' ? name.trim() : source!.split('/').pop()!;
  const destination = parent ? `${parent}/${leaf}` : '';
  const valid =
    !!parent &&
    (mode !== 'folder' || (canChooseParent?.(parent) ?? true)) &&
    !!leaf &&
    !leaf.includes('/') &&
    !leaf.includes('\\') &&
    leaf !== '.' &&
    leaf !== '..' &&
    canChoose(destination) &&
    destination !== source;
  const eligibleParent = (directory: string) =>
    mode === 'folder' ? (canChooseParent?.(directory) ?? true) : canChoose(`${directory}/${leaf}`);
  const choices = directories.filter(eligibleParent);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="knowledge-dialog-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
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
          if (event.key === 'Escape' && !working) onClose();
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
          canSelectFolder={eligibleParent}
          selectedFolder={parent}
          busy={working}
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
              disabled={working}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
            />
          </label>
        )}
        {(error || submitError) && <p role="alert">{error || submitError}</p>}
        <div className="knowledge-editor-actions">
          <button disabled={working} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={working || !valid}
            onClick={async () => {
              if (working || submittingRef.current || !valid) return;
              submittingRef.current = true;
              setSubmitting(true);
              setSubmitError('');
              try {
                if (await onSubmit(destination)) onClose();
              } catch (error: unknown) {
                setSubmitError(
                  error instanceof Error
                    ? error.message
                    : 'The change could not be completed. Please try again.',
                );
              } finally {
                submittingRef.current = false;
                setSubmitting(false);
              }
            }}
          >
            {mode === 'folder' ? 'Create folder' : 'Move here'}
          </button>
        </div>
      </div>
    </div>
  );
}
