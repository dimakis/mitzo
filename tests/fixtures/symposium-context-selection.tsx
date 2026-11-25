import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FinishedMessage } from '@mitzo/protocol';
import { ConversationContextSelection } from '../../frontend/src/components/ConversationContextSelection';
import { HomeDialog } from '../../frontend/src/components/HomeDialog';
import type { ConversationAgentSetup } from '../../frontend/src/lib/conversation-joining-review';
import type { ConversationContextMessageMetadata } from '../../frontend/src/lib/conversation-context-selection';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/motion.css';
import '../../frontend/src/components/ConversationAgents.css';

const messages: FinishedMessage[] = [
  {
    messageId: 'operator-message',
    role: 'user',
    timestamp: 1_800_000_000_000,
    blocks: [
      {
        blockId: 'operator-text',
        blockType: 'text',
        content: 'Review the source selector and preserve the current approval boundaries.',
      },
    ],
  },
  {
    messageId: 'reviewer-message',
    role: 'assistant',
    timestamp: 1_800_000_001_000,
    replyToMessageId: 'operator-message',
    blocks: [
      {
        blockId: 'reviewer-text',
        blockType: 'text',
        content:
          '# Source findings\n\n**Recorded evidence** remains readable at narrow widths.\n\n- Preserve exact selections.\n- Review the recorded artifact version.\n\n`/workspace/reports/source-selection-review-with-a-long-unbroken-name.md` is a path mention, not retained file content.\n\n[Local report](/workspace/reports/source-selection-review.md)\n\n![Remote image reference](https://unavailable.example.test/image.png)\n\n```text\nimmutable-message-id-and-artifact-revision-hash-are-never-rewritten-by-filtering\n```',
      },
    ],
  },
  {
    messageId: 'synthetic-progress',
    role: 'assistant',
    timestamp: 1_800_000_002_000,
    blocks: [
      {
        blockId: 'progress-text',
        blockType: 'text',
        content: 'Synthetic progress example: inspecting the recorded source boundaries.',
      },
    ],
  },
];

// Synthetic recorded metadata exercises the presentation contract. Ordinary
// FinishedMessage currently has no progress discriminator; this fixture is not
// evidence that an ordinary adapter supplies one.
const messageMetadata: Record<string, ConversationContextMessageMetadata> = {
  'reviewer-message': { authorId: 'reviewer', authorLabel: 'Astra reviewer', type: 'reply' },
  'synthetic-progress': { authorId: 'reviewer', authorLabel: 'Astra reviewer', type: 'progress' },
};
const artifacts = [
  {
    artifactId: 'retained-review',
    revision: 2,
    sha256: 'a'.repeat(64),
    title: 'Source selection review',
    filename: 'source-selection-review.md',
    available: true,
  },
  {
    artifactId: 'retained-review',
    revision: 3,
    sha256: 'b'.repeat(64),
    title: 'Source selection review',
    filename: 'source-selection-review.md',
    available: false,
  },
];

function Fixture() {
  const [open, setOpen] = useState(false);
  const [messageIds, setMessageIds] = useState<string[]>([]);
  const [selectedArtifacts, setSelectedArtifacts] = useState<ConversationAgentSetup['artifacts']>(
    [],
  );
  return (
    <>
      <button
        type="button"
        className="home-secondary"
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        Choose starting context
      </button>
      {open && (
        <HomeDialog
          title="Starting context"
          className="conversation-agents-dialog"
          onClose={() => setOpen(false)}
        >
          <div className="conversation-agents-body">
            <p>
              Offline fixture. Progress classification below is synthetic metadata, not a live
              adapter observation.
            </p>
            <ConversationContextSelection
              messages={messages}
              messageMetadata={messageMetadata}
              messageIds={messageIds}
              artifacts={artifacts}
              selectedArtifacts={selectedArtifacts}
              onMessagesChange={setMessageIds}
              onArtifactsChange={setSelectedArtifacts}
            />
          </div>
          <footer>
            <button type="button" className="home-secondary" onClick={() => setOpen(false)}>
              Done
            </button>
          </footer>
        </HomeDialog>
      )}
      <output hidden data-testid="selection">
        {JSON.stringify({ messageIds, artifacts: selectedArtifacts })}
      </output>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
