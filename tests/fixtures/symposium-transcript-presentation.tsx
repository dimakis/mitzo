import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createCollaborationProjection } from '@mitzo/client';
import { CollaborationTranscript } from '../../frontend/src/components/CollaborationTranscript';
import {
  sharedConversationView,
  sharedPrompt,
  sharedReply,
  uuid,
} from './symposium-shared-conversation-data';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';

function Fixture() {
  const [complete, setComplete] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [reload, setReload] = useState(0);
  const view = sharedConversationView();
  view.seatOrder = ['architect', 'reviewer', 'reader'];
  view.messages = [
    {
      ...sharedPrompt,
      origin: { sessionId: 'reader', requestId: uuid(900) },
      recordedAt: 1794814800000,
    },
  ];
  if (complete) view.messages.push(sharedReply);
  if (removed) view.participantSessionIds = ['architect', 'reader'];
  const text = { blockId: 'text', blockType: 'text' as const, content: sharedReply.text };
  return (
    <MemoryRouter>
      <nav aria-label="Fixture transitions">
        <button type="button" className="home-secondary" onClick={() => setComplete(true)}>
          Complete reply
        </button>
        <button type="button" className="home-secondary" onClick={() => setRemoved(true)}>
          Remove reviewer
        </button>
        <button
          type="button"
          className="home-secondary"
          onClick={() => setReload((value) => value + 1)}
        >
          Reload transcript
        </button>
      </nav>
      <CollaborationTranscript
        key={reload}
        projection={createCollaborationProjection(view)}
        names={{
          architect: 'Architect with a long readable name',
          reviewer: 'Reviewer',
          reader: 'Lead agent',
        }}
        ordinary={{
          sessionId: 'architect',
          messages: [
            {
              messageId: 'activity',
              replyToMessageId: 'ordinary-architect',
              startedSeq: 10,
              role: 'assistant',
              blocks: [
                {
                  blockId: 'tool',
                  blockType: 'tool_use',
                  content: '',
                  toolName: 'mcp__mitzo__TaskExecution',
                  toolInput:
                    '{"operation":"run","command":"npm test","grantId":"technical-reference"}',
                  toolResult: 'Focused checks passed',
                },
              ],
            },
            ...(complete
              ? [
                  {
                    messageId: 'final-answer',
                    replyToMessageId: 'ordinary-architect',
                    startedSeq: 20,
                    role: 'assistant' as const,
                    blocks: [text],
                  },
                ]
              : []),
          ],
          current: complete
            ? null
            : {
                messageId: 'final-answer',
                startedSeq: 20,
                replyToMessageId: 'ordinary-architect',
                blocks: new Map([['text', { ...text, done: false }]]),
                blockOrder: ['text'],
              },
          running: !complete,
          permission: null,
          onPermissionRespond: () => {},
        }}
      />
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
