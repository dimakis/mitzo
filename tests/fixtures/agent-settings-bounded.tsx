import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AgentTaskEditor } from '../../frontend/src/components/AgentTaskEditor';
import { useAgentTasks } from '../../frontend/src/hooks/useAgentTasks';
import {
  createAgentTaskWorkingCopy,
  saveAgentTaskWorkingCopy,
} from '../../frontend/src/lib/agent-task-working-copy';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/agent-library.css';
import '../../frontend/src/styles/appearance.css';
import '../../frontend/src/styles/motion.css';

// The editor, task state/save owner, settings controls and layout are production.
// Only configuration and task HTTP responses are intercepted by the browser spec.
const profile = {
  profileId: 'bob',
  revision: 3,
  contentHash: 'a'.repeat(64),
  definition: {
    name: 'Bob',
    role: 'agent',
    instructions: 'Review evidence',
    expectedOutput: 'Brief',
    acceptanceCriteria: ['Cite sources'],
    modelPolicyRole: 'agent',
  },
};
saveAgentTaskWorkingCopy({
  ...createAgentTaskWorkingCopy(profile),
  name: 'Morning review',
  objective: 'Review accepted evidence.',
});
function Editor() {
  const task = useAgentTasks();
  return (
    <main>
      {task.copy && (
        <AgentTaskEditor
          copy={task.copy}
          versions={[profile]}
          update={task.update}
          save={() => void task.save()}
          busy={task.busy}
        />
      )}
      {(task.error || task.notice) && <p role="status">{task.error || task.notice}</p>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Editor />
  </MemoryRouter>,
);
