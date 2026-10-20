import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TaskNode } from '../../frontend/src/components/TaskNode';
import type { Task, TaskStatus } from '../../frontend/src/types/task';
import type { TaskDisplayMeta } from '../../frontend/src/hooks/useTaskBoard';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';

// Exact opaque working-file attribution from the retained S9 capture; no file read or API.
export const report =
  '{"kind":"worker-working-file","path":"/private/var/folders/y6/3pqs6vkj5wv1qkm5v1cq2n0r0000gn/T/mitzo-ordinary-native-5Ei8um/tasks/ordinary-b59f0cb9-245b-45bd-b766-c2010a341476/recording-review-report.md","sha256":"c441b505b586215cea00efb1ba5904d02229283d3c954ad65874a8077c7df287","sessionId":"05d53de8-4f5f-887f-9af4-46fceec8816d","taskId":"26c80140-7947-4a9b-beef-0bea07c755d1"}';
export const title = 'Record one acoustic sample';
export const summary =
  'Synthetic recording report submitted with attributed working-file evidence; task review remains explicit and the outcome is unverified.';
export const taskId = '26c80140-7947-4a9b-beef-0bea07c755d1';
export const sessionId = '05d53de8-4f5f-887f-9af4-46fceec8816d';
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    parentId: null,
    title,
    description: null,
    status: 'pending_review',
    sessionId,
    sessionPolicy: 'auto',
    priority: 0,
    depth: 0,
    annotations: [],
    summary,
    requiresApproval: true,
    tokenUsage: 0,
    claimedBy: null,
    claimedAt: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    stageType: null,
    gateConfig: null,
    artifacts: { report },
    retryCount: 0,
    maxRetries: 0,
    templateId: null,
    children: [],
    ...overrides,
  };
}
function Fixture() {
  const location = useLocation();
  const [events, setEvents] = useState<unknown[]>([]);
  const [task, setTask] = useState<Task | null>(() =>
    makeTask({
      children: [
        makeTask({
          id: 'review-child',
          parentId: taskId,
          depth: 1,
          title: 'Review supporting sample',
          summary: 'Keep the child criteria and review controls readable.',
          artifacts: null,
          status: 'pending',
          sessionId: null,
        }),
      ],
    }),
  );
  const record = (action: string, id: string, value?: unknown) =>
    setEvents((previous) => [...previous, { action, id, value }]);
  const change = (id: string, patch: Partial<Task>) =>
    setTask((current) => {
      function visit(value: Task): Task {
        const next = value.id === id ? { ...value, ...patch } : value;
        return { ...next, children: next.children.map(visit) };
      }
      return current && visit(current);
    });
  const remove = (id: string) =>
    setTask((current) => {
      function visit(value: Task): Task {
        return { ...value, children: value.children.filter((c) => c.id !== id).map(visit) };
      }
      return current && (current.id === id ? null : visit(current));
    });
  const meta = new Map<string, TaskDisplayMeta>([
    [
      taskId,
      {
        attendTier: 1,
        fadeOpacity: 1,
        sessionHash: 'worker-chat',
        completedAgo: 'just now',
      },
    ],
  ]);
  return (
    <>
      <main className="task-board-page">
        <div className="task-board-scroll">
          <div className="task-board-list">
            {task && (
              <TaskNode
                task={task}
                depth={0}
                displayMeta={meta}
                onStatusChange={(id: string, status: TaskStatus) => {
                  record('status', id, status);
                  change(id, { status });
                }}
                onApprove={(id) => {
                  record('approve', id);
                  change(id, { status: 'done', completedAt: 1 });
                }}
                onReject={(id, feedback) => record('reject', id, feedback)}
                onAddChild={(id) => {
                  record('add', id);
                  change(id, {
                    children: [
                      ...(task.children ?? []),
                      makeTask({
                        id: 'added-child',
                        parentId: id,
                        depth: 1,
                        title: 'Added child',
                        summary: null,
                        artifacts: null,
                        status: 'pending',
                        sessionId: null,
                      }),
                    ],
                  });
                }}
                onDelete={(id) => {
                  record('delete', id);
                  remove(id);
                }}
              />
            )}
          </div>
        </div>
      </main>
      <output hidden data-testid="actions">
        {JSON.stringify(events)}
      </output>
      <output hidden data-testid="location">
        {location.pathname}
      </output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/tasks']}>
    <Fixture />
  </MemoryRouter>,
);
