import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SubagentCard } from '../../frontend/src/components/SubagentCard';
import { BackgroundTaskStopController } from '../../frontend/src/lib/background-task-stop';
import { parseServerMessage } from '../../packages/client/src/protocol-parser';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '../../packages/client/src/slices/messages';
import type { SubagentStatus } from '@mitzo/protocol';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/motion.css';

const execution = {
  sessionId: 'fixture-chat',
  processGeneration: 'fixture-generation',
  taskId: 'task',
  runId: 'run',
  parentToolId: 'launch',
  subagentMessageId: 'child',
};
let stops = 0;
// Explicit consumer fixture, not a production endpoint or authority assertion.
const control = new BackgroundTaskStopController(
  execution,
  {
    stop: async () => {
      stops++;
      throw new Error('Fixture lost response');
    },
    read: async (request) => ({ ...request, revision: 2, status: 'requested' }),
  },
  () => 'fixture-request',
  () => {},
);

function task(status: SubagentStatus, restart: boolean) {
  const events = [
    { type: 'message_start', messageId: 'parent' },
    { type: 'block_start', blockId: 'tool', blockType: 'tool_use', toolName: 'Agent' },
    {
      type: 'subagent_start',
      parentBlockId: 'tool',
      subagentMessageId: 'child',
      seq: 3,
      backgroundTask: {
        taskId: 'task',
        runId: 'run',
        processGeneration: 'fixture-generation',
        description: 'Inspect background task lifecycle and retain the latest output',
      },
    },
    {
      type: 'subagent_block_start',
      parentBlockId: 'tool',
      blockId: 'out',
      blockType: 'text',
      seq: 4,
    },
    {
      type: 'subagent_block_delta',
      parentBlockId: 'tool',
      blockId: 'out',
      delta: '<script>Never execute output</script>\n' + 'long-unbroken-output'.repeat(1200),
      seq: 5,
    },
    ...(status !== 'running'
      ? [
          {
            type: 'subagent_end',
            parentBlockId: 'tool',
            status,
            stopReason: restart ? 'process_restart' : undefined,
            seq: 6,
          },
        ]
      : []),
  ];
  const state = events
    .flatMap(
      (event) =>
        parseServerMessage(
          { v: 2, sessionId: 'fixture-chat', ...event } as never,
          { currentSessionId: 'fixture-chat' },
          { onSessionAssigned() {}, onSessionExpired() {} },
          'client',
        ).messagesActions,
    )
    .reduce(messagesReducer, INITIAL_MESSAGES_STATE);
  return state.current!.blocks.get('tool')!.subagent!;
}

function Fixture() {
  const [status, setStatus] = useState('running');
  const [adapter, setAdapter] = useState(false);
  const [visible, setVisible] = useState(true);
  const [draft, setDraft] = useState('Keep this draft');
  return (
    <main style={{ padding: 'var(--page-gutter)', maxWidth: '100%' }}>
      <p>Offline consumer fixture. Production task-only Stop is unavailable.</p>
      <label>
        Task evidence{' '}
        <select
          aria-label="Task evidence"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {['running', 'completed', 'failed', 'cancelled', 'unavailable', 'restart'].map(
            (value) => (
              <option key={value}>{value}</option>
            ),
          )}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={adapter}
          onChange={(event) => setAdapter(event.target.checked)}
        />
        Use fixture Stop adapter
      </label>
      <button type="button" className="home-secondary" onClick={() => setVisible(!visible)}>
        Toggle task view
      </button>
      {visible && (
        <SubagentCard
          subagent={task(
            status === 'restart' ? 'cancelled' : (status as SubagentStatus),
            status === 'restart',
          )}
          sessionId="fixture-chat"
          taskControl={adapter ? control : undefined}
        />
      )}
      <label>
        Composer draft{' '}
        <textarea
          aria-label="Composer draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="home-secondary"
        onClick={() => (document.getElementById('dispatches')!.textContent = String(stops))}
      >
        Inspect dispatch count
      </button>
      <output id="dispatches" aria-label="Dispatch count" />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
