import { useState } from 'react';
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
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
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
