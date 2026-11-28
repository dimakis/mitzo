import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { UiIcon } from '../../frontend/src/components/UiIcon';
import type { UseVoiceReturn } from '../../frontend/src/hooks/useVoice';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';

const members = Array.from({ length: 8 }, (_, n) => ({
  id: `agent-${n}`,
  name: `Agent ${n} with a very long recipient name that must remain readable`,
}));
function Surface() {
  const [running, setRunning] = useState(false);
  const [selectedIds, onChange] = useState(['agent-0', 'agent-1']);
  const [stops, setStops] = useState(0);
  const [recording, setRecording] = useState(false);
  // An ordinary chat has no recipients or shared control above the toolbar.
  const ordinary = new URLSearchParams(location.search).has('ordinary');
  // Match useVoice: ChatInput cancels recording whenever this callback changes.
  const cancelRecording = useCallback(() => setRecording(false), []);
  const voice: UseVoiceReturn = {
    available: true,
    recording,
    transcribing: false,
    micBlocked: false,
    error: null,
    partialTranscript: '',
    startRecording: async () => setRecording(true),
    stopRecording: async () => {
      setRecording(false);
      return '';
    },
    cancelRecording,
    ttsAvailable: false,
    speaking: false,
    voices: [],
    selectedVoice: '',
    speak: async () => {},
    stopSpeaking: () => {},
    setVoice: () => {},
  };
  return (
    <MemoryRouter>
      <main className="chat-page workspace-chat">
        <div className="chat-messages">
          <button onClick={() => setRunning((v) => !v)}>Toggle running</button>
          <output aria-label="Stop count">{stops}</output>
          <output aria-label="Selected recipients">{selectedIds.join(',')}</output>
        </div>
        <ChatInput
          running={running}
          initialText="Keep this unsent draft"
          onSend={() => false}
          onInterrupt={() => {}}
          onStop={() => setStops((n) => n + 1)}
          sourceStop={
            new URLSearchParams(location.search).has('sourceStop')
              ? () => setStops((n) => n + 1)
              : undefined
          }
          voice={voice}
          sharedControl={
            ordinary
              ? undefined
              : { label: 'selected agents', sourceSelected: false, sourceHandled: true }
          }
          responders={ordinary ? undefined : { inline: true, members, selectedIds, onChange }}
          tokenParticipants={ordinary ? undefined : members.slice(0, 2)}
          tokenState={
            ordinary
              ? {
                  agentContext: 0,
                  contextCeiling: 0,
                  sessionTotal: 0,
                  numTurns: 0,
                  turnIndex: 0,
                  numCompactions: 0,
                  tokenLimits: null,
                }
              : undefined
          }
          collaboration={
            <button type="button" className="chat-input-btn" aria-label="Agents">
              <UiIcon name="agents" />
            </button>
          }
        />
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
