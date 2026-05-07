import { InboxSection } from './InboxSection';
import { TelosSection } from './TelosSection';
import { TaskBoardSection } from './TaskBoardSection';

export interface CommandCenterProps {
  activeSessionId?: string;
}

export function CommandCenter({ activeSessionId }: CommandCenterProps) {
  return (
    <div className="command-center">
      <InboxSection />
      <TelosSection />
      <TaskBoardSection activeSessionId={activeSessionId} />
    </div>
  );
}
