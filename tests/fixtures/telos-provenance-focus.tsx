import { createRoot } from 'react-dom/client';
import { App } from '../../frontend/src/App';
import { TelosChatList } from '../../frontend/src/components/TelosChatList';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';

const work = TelosWorkViewSchema.parse({
  itemId: 'focus-item',
  kind: 'work_item',
  parentId: null,
  revision: 'a'.repeat(64),
  sources: [],
  attempts: [],
  assignments: [],
  links: [
    {
      version: 1,
      linkId: 'origin',
      itemId: 'focus-item',
      role: 'origin',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
      linkedAt: '2026-10-16T10:00:00Z',
      linkedBy: 'operator:fixture',
      availability: 'available',
      attemptId: null,
    },
  ],
});
/** The browser spec replaces unrelated route/page owners only. App itself and
 * its actual capture handler, native details and Telos renderer are unchanged. */
export function FocusPage() {
  return (
    <main>
      <input aria-label="Retained draft" defaultValue="Keep this draft" />
      <TelosChatList work={work} title="Home studio" onOpen={() => {}} onNewChat={() => {}} />
      <input aria-label="Next keyboard field" />
      <button>Next ordinary action</button>
      <p>Conversation background</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
