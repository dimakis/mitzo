import { InboxSection } from './InboxSection';
import { TelosSection } from './TelosSection';
import { TaskBoardSection } from './TaskBoardSection';

export function CommandCenter() {
  return (
    <div className="command-center">
      <InboxSection />
      <TelosSection />
      <TaskBoardSection />
    </div>
  );
}
