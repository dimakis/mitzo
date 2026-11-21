import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ChatInputHost } from '../../frontend/src/components/ChatInputHost';
import type { UseVoiceReturn } from '../../frontend/src/hooks/useVoice';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import './queue-status.css';

function Fixture() {
  const [sessionId, setSessionId] = useState('one');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  useEffect(() => {
    const switchChat = () => setSessionId('two');
    window.addEventListener('fixture-switch-chat', switchChat);
    return () => window.removeEventListener('fixture-switch-chat', switchChat);
  }, []);
  const voice: UseVoiceReturn = {
    available: true,
    recording,
    transcribing,
    micBlocked: false,
    error: null,
    partialTranscript: recording ? 'Recording fixture speech' : '',
    startRecording: async () => {
      setRecording(true);
    },
    stopRecording: () => {
      setRecording(false);
      setTranscribing(true);
      return new Promise((resolve) =>
        window.addEventListener(
          'fixture-transcribed',
          () => {
            setTranscribing(false);
            resolve('Offline transcription');
          },
          { once: true },
        ),
      );
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
      <ChatInputHost sessionId={sessionId}>
        <main className="queue-status-fixture">
          <div className="queue-status-composer">
            <ChatInput
              sessionId={sessionId}
              running={false}
              onSend={() => false}
              onStop={() => {}}
              initialText="Keep my draft"
              voice={voice}
              tokenState={{
                agentContext: 0,
                contextCeiling: 0,
                sessionTotal: 0,
                numTurns: 0,
                turnIndex: 0,
                numCompactions: 0,
                tokenLimits: null,
              }}
            />
          </div>
        </main>
      </ChatInputHost>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
