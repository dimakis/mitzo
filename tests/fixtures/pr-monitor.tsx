import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionDetailsDialog } from '../../frontend/src/components/SessionDetailsDialog';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/motion.css';

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Session details
      </button>
      <label>
        Message draft
        <textarea defaultValue="Keep my draft" />
      </label>
      {open && (
        <SessionDetailsDialog
          session={{
            id: 'chat',
            summary: 'PR monitoring',
            cwd: '/workspace/project',
            lastModified: Date.now(),
            isActive: false,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
