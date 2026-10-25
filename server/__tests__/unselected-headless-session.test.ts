import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectUnselectedHeadlessSession } from '../unselected-headless-session.js';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
vi.mock('../chat.js', () => ({ sendToChat: vi.fn(), startChat: vi.fn() }));
import { sendToChat, startChat } from '../chat.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('blocks unselected legacy spawning visibly without allocation, dispatch or automatic retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-no-selection-'));
  roots.push(root);
  const store = new TaskStore(join(root, 'tasks.db'));
  try {
    const goal = store.create({ title: 'Workflow', description: '' });
    const task = store.create({
      title: 'Unselected work',
      description: '',
      parentId: goal.id,
      sessionPolicy: 'spawn',
    });
    const spawn = vi.fn(rejectUnselectedHeadlessSession);
    const loop = new TaskOrchestrator({
      store,
      getClientId: () => 'selected-reuse',
      setTaskContext: vi.fn(),
      clearTaskContext: vi.fn(),
      broadcastStatus: vi.fn(),
      broadcastTasks: vi.fn(),
      spawnSession: spawn,
    });
    loop.setSpawnEnabled(true);
    loop.start(goal.id, { clientId: 'selected-reuse' });
    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('blocked'));
    expect(store.get(task.id)?.annotations).toContain(
      'spawn_error: Headless task requires an explicit account, model and execution target. Use an explicitly selected Telos worker or the pinned conversation.',
    );
    expect(store.get(task.id)?.sessionId).toBeNull();
    loop.tick();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(startChat).not.toHaveBeenCalled();
    expect(sendToChat).not.toHaveBeenCalled();
    loop.stop();
  } finally {
    store.close();
  }
});

it('wires production spawning to the selected ordinary owner before runtime allocation', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toContain('bindOrdinaryTaskWorkerSession(');
  expect(source).not.toContain('spawnSession: rejectUnselectedHeadlessSession,');
});
