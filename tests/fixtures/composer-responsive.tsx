import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../../frontend/src/components/ChatInput';
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
    cancelRecording: () => setRecording(false),
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
          sharedControl={{ label: 'selected agents', sourceSelected: false, sourceHandled: true }}
          responders={{ inline: true, members, selectedIds, onChange }}
          tokenParticipants={members.slice(0, 2)}
          collaboration={
            <button type="button" className="chat-input-btn" aria-label="Agents">
              Agents
            </button>
          }
        />
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
