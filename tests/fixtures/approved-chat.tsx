import { useEffect, useRef, useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ChatWelcome } from '../../frontend/src/components/ChatWelcome';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { AgentSettingsFields } from '../../frontend/src/components/AgentSettingsPicker';
import { SessionAccess } from '../../frontend/src/components/SessionAccess';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { QuickSettingsField } from '../../frontend/src/components/QuickChatSettings';
import { RuntimeBrandMark, ModelBrandMark } from '../../frontend/src/components/SettingsBrandMark';
import type { SettingsPage } from '../../frontend/src/lib/quick-settings-context';
import { UiIcon } from '../../frontend/src/components/UiIcon';
import type { UseVoiceReturn } from '../../frontend/src/hooks/useVoice';
import type { ContextCompaction, FinishedMessage } from '@mitzo/protocol';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

const records: ContextCompaction[] = [
  {
    id: 'compact-example',
    seq: 41,
    observedAt: 1700000000000,
    phase: 'completed',
    afterMessageId: 'a1',
    turnIndex: 12,
    beforeTokens: 112000,
    afterTokens: 48000,
    condensedRange: null,
    summary: null,
    retainedProviderMessageIds: [],
  },
];
const messages: FinishedMessage[] = [
  {
    messageId: 'u1',
    role: 'user',
    blocks: [{ blockId: 'u', blockType: 'text', content: 'Please review the layout.' }],
  },
  {
    messageId: 'a1',
    role: 'assistant',
    blocks: [
      {
        blockId: 'a',
        blockType: 'text',
        content:
          'The layout review is ready. https://github.com/acme/widgets/pull/12\n' +
          Array.from({ length: 264 }, (_, i) => `https://site${i % 112}.example/page${i}`).join(
            '\n',
          ),
      },
    ],
  },
];
const field = (name: string, values: string[]) => (
  <QuickSettingsField
    page={name.toLowerCase() as SettingsPage}
    title={name}
    value={values[0]}
    mark={name === 'Model' ? <ModelBrandMark model="gpt-luna-fixture" /> : undefined}
  >
    <label>
      {name}
      <select aria-label={name}>
        {values.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
    </label>
  </QuickSettingsField>
);
function Surface() {
  const [sends, setSends] = useState(0),
    [recording, setRecording] = useState(false),
    [partial, setPartial] = useState('');
  const latest = useRef(partial);
  latest.current = partial;
  useEffect(() => {
    const change = (event: Event) => setPartial((event as CustomEvent<string>).detail);
    window.addEventListener('fixture-transcript', change);
    return () => window.removeEventListener('fixture-transcript', change);
  }, []);
  const voiceCallbacks = useMemo(
    () => ({
      startRecording: async () => {
        setPartial('');
        setRecording(true);
      },
      stopRecording: async () => {
        setRecording(false);
        return latest.current;
      },
      cancelRecording: () => setRecording(false),
      speak: async () => {},
      stopSpeaking: () => {},
      setVoice: () => {},
    }),
    [],
  );
  const voice: UseVoiceReturn = {
    available: true,
    recording,
    transcribing: false,
    partialTranscript: partial,
    micBlocked: false,
    error: null,
    ttsAvailable: false,
    speaking: false,
    voices: [],
    selectedVoice: 'fixture',
    ...voiceCallbacks,
  };
  const desktop = window.matchMedia('(min-width:768px)').matches;
  const center = (
    <div
      className={`${desktop ? 'desktop-chat-center' : 'chat-page'} workspace-chat${!sends ? ' chat-page--new' : ''}`}
    >
      <WorkspaceControls
        status="Ready"
        agent="Default Mitzo"
        summary={{ profile: 'Work account', model: 'Luna', thinking: 'High' }}
        leading={
          !desktop ? (
            <button className="chat-top-action" aria-label="Back to chats">
              <UiIcon name="back" />
            </button>
          ) : undefined
        }
        trailing={
          <button className="chat-top-action" aria-label="New chat" onClick={() => setSends(0)}>
            <UiIcon name="edit" />
          </button>
        }
        actions={<SessionAccess selection={{ accountId: 'work', model: 'luna' }} />}
        settings={
          <AgentSettingsFields
            accountModel={
              <>
                {field('Account', ['Work account', 'Personal'])}
                {field('Model', ['Luna', 'Other model'])}
                {field('Thinking', ['High', 'Medium', 'Low'])}
              </>
            }
            agent={field('Agent', ['Default Mitzo', 'Researcher'])}
            repository={
              <QuickSettingsField page="repository" title="Repository" value="Add repository">
                <details className="chat-settings-advanced">
                  <summary>
                    <span>Repository</span>
                    <UiIcon name="down" size={16} />
                  </summary>
                  <p>Choose from repositories available to this account.</p>
                </details>
              </QuickSettingsField>
            }
            execution={
              <QuickSettingsField
                page="execution"
                title="Run on"
                value="OpenShell"
                mark={<RuntimeBrandMark location="openshell" />}
              >
                <div className="agent-execution-settings">
                  <strong>Run on</strong>
                  <button type="button">
                    <span className="openshell-brand" aria-hidden="true" />
                    OpenShell
                  </button>
                  <button type="button">Local Mac</button>
                </div>
              </QuickSettingsField>
            }
          />
        }
      >
        <p>Session controls</p>
      </WorkspaceControls>
      <ChatWelcome active={sends === 0} />
      <ChatArea
        sessionId="fixture"
        messages={
          sends
            ? messages.map((message) =>
                message.role === 'assistant'
                  ? {
                      ...message,
                      blocks: [
                        {
                          blockId: 'a',
                          blockType: 'text' as const,
                          content: 'The revised layout is ready.',
                        },
                      ],
                    }
                  : message,
              )
            : []
        }
        current={null}
        running={false}
        permission={null}
        onPermissionRespond={() => {}}
        compactions={sends ? records : []}
      />
      <div className={`conversation-composer${!sends ? ' conversation-composer--new' : ''}`}>
        <ChatInput
          messages={messages}
          compactions={records}
          voice={voice}
          running={false}
          sendLabel="Send message"
          onSend={() => {
            setSends((value) => value + 1);
            return true;
          }}
          onStop={() => {}}
          tokenState={{
            agentContext: 48000,
            contextCeiling: 128000,
            sessionTotal: 640000,
            numTurns: 18,
            turnIndex: 18,
            numCompactions: 1,
            tokenLimits: { model: 'Luna', source: 'runtime', contextWindow: 128000, stale: false },
          }}
          bootContext={{
            source: 'contexgin',
            sourceCount: 4,
            tokenCount: 6200,
            tokenBudget: 8000,
            sources: [],
            included: [],
            trimmed: [],
            fullMarkdown:
              '# Injected boot context\nPreserve the approved composer and scoped permissions.',
          }}
        />
      </div>
      <output data-testid="sent-count" hidden>
        {sends}
      </output>
    </div>
  );
  return (
    <>
      {desktop ? <DesktopShell center={center} rightDefaultCollapsed /> : center}
      {!desktop && (
        <nav className="workspace-tabs" aria-label="Main navigation">
          Today · Chats · Inbox · Work · More
        </nav>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Surface />
  </MemoryRouter>,
);
