import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { FinishedBlock } from '../../frontend/src/types/chat';
import { ToolPill } from '../../frontend/src/components/ToolPill';
import { ToolGroup } from '../../frontend/src/components/ToolGroup';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/code-block.css';

const base: FinishedBlock = {
  blockId: 'call',
  blockType: 'tool_use',
  content: '',
  toolInput: 'Original request',
  toolResult: 'Original output\n'.repeat(80),
};
const examples: FinishedBlock[] = [
  { ...base, toolName: 'Bash', rawInput: { type: 'command', command: 'npm test' } },
  { ...base, toolName: 'Read', rawInput: { type: 'read', path: '/workspace/source.ts' } },
  {
    ...base,
    toolName: 'Write',
    rawInput: {
      type: 'write',
      path: '/workspace/source.ts',
      contents: 'export const answer = 42;',
    },
  },
  {
    ...base,
    toolName: 'Edit',
    rawInput: { type: 'diff', path: '/workspace/source.ts', old_string: '41', new_string: '42' },
  },
  { ...base, toolName: 'Agent', rawInput: { type: 'agent', prompt: 'Inspect the reviewed task.' } },
  ...['GitHubRead', 'TaskExecution', 'mcp__atlassian__search', 'AnUnknownFutureTool'].map(
    (toolName) => ({ ...base, toolName }),
  ),
  {
    ...base,
    toolName: 'AgentProposeTask',
    toolResult: JSON.stringify({
      proposalId: 'proposal',
      status: 'awaiting_user_review',
      taskId: 'task',
      expectedRevision: 3,
    }),
  },
];

function Fixture() {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const block = { ...examples[index], toolError: failed };
  return (
    <MemoryRouter initialEntries={['/chat/lead']}>
      <main className="fixture">
        <label>
          Tool example{' '}
          <select
            aria-label="Tool example"
            value={index}
            onChange={(event) => {
              setIndex(Number(event.target.value));
              setFailed(false);
            }}
          >
            {examples.map((example, i) => (
              <option key={example.toolName} value={i}>
                {example.toolName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={failed}
            onChange={(event) => setFailed(event.target.checked)}
          />
          Show failure
        </label>
        <label>
          <input
            type="checkbox"
            checked={grouped}
            onChange={(event) => setGrouped(event.target.checked)}
          />
          Group tool activity
        </label>
        {grouped ? (
          <ToolGroup tools={[examples[0], examples[9]]} sessionId="lead" />
        ) : (
          <ToolPill key={index} block={block} sessionId="lead" />
        )}
        <label>
          Draft
          <textarea aria-label="Draft" defaultValue="Keep this draft" />
        </label>
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
