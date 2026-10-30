import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContextCompaction } from '@mitzo/protocol';
import { CompactionMarker } from '../../frontend/src/components/CompactionMarker';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';

const startedAt = Date.now() - 300000;
const active: ContextCompaction = {
  id: 'fixture-compaction',
  seq: 3,
  observedAt: startedAt,
  startedAt,
  endedAt: null,
  phase: 'compacting',
  afterMessageId: 'message',
  turnIndex: 15,
  beforeTokens: null,
  afterTokens: null,
  usageBefore: {
    tokens: 189054,
    observedAt: startedAt - 4,
    model: 'fixture-model-with-a-long-name-for-wrapping',
    contextCeiling: 258400,
  },
  usageAfter: null,
  condensedRange: null,
  summary: null,
  retainedProviderMessageIds: [],
};
function Fixture() {
  const [record, setRecord] = useState(active);
  useEffect(() => {
    const complete = () =>
      setRecord({
        ...active,
        phase: 'completed',
        observedAt: startedAt + 392669,
        endedAt: startedAt + 392669,
        usageAfter: {
          tokens: 28549,
          observedAt: startedAt + 401152,
          model: active.usageBefore!.model,
          contextCeiling: 258400,
        },
      });
    const interrupt = () =>
      setRecord({
        ...active,
        phase: 'interrupted',
        observedAt: startedAt + 300000,
        endedAt: startedAt + 300000,
      });
    window.addEventListener('fixture-complete', complete);
    window.addEventListener('fixture-interrupt', interrupt);
    return () => {
      window.removeEventListener('fixture-complete', complete);
      window.removeEventListener('fixture-interrupt', interrupt);
    };
  }, []);
  return (
    <main>
      <textarea aria-label="Draft" defaultValue="Keep my draft" />
      <CompactionMarker record={record} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
