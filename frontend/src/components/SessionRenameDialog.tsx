import { useEffect, useRef, useState } from 'react';
import type { Session } from '../types/chat';
import { HomeDialog } from './HomeDialog';
export function SessionRenameDialog({
  session,
  onSave,
  onClose,
}: {
  session: Session;
  onSave: (id: string, title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(session.summary);
  const input = useRef<HTMLInputElement>(null);
  // The native dialog opens in its effect, after React's initial autofocus.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <HomeDialog title="Rename conversation" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onSave(session.id, title.trim());
          onClose();
        }}
      >
        <label className="home-search">
          Conversation name
          <input
            ref={input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <footer>
          <button type="button" className="home-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="home-secondary" disabled={!title.trim()}>
            Save name
          </button>
        </footer>
      </form>
    </HomeDialog>
  );
}
