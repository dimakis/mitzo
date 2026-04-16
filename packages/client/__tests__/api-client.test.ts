import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MitzoApiClient } from '../src/api-client.js';
import type { ApiFetch } from '../src/api-client.js';

function mockFetch(data: unknown = {}, text?: string): ApiFetch {
  return vi.fn().mockResolvedValue({
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(text ?? JSON.stringify(data)),
    ok: true,
  });
}

describe('MitzoApiClient', () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  let client: MitzoApiClient;

  beforeEach(() => {
    fetchFn = mockFetch() as ReturnType<typeof vi.fn>;
    client = new MitzoApiClient(fetchFn);
  });

  // ── Auth ─────────────────────────────────────────────────────────────────

  it('checkAuth calls /api/auth/check', async () => {
    await client.checkAuth();
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/check', expect.objectContaining({ credentials: 'include' }));
  });

  it('login sends passphrase', async () => {
    await client.login('secret');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ passphrase: 'secret' }),
      }),
    );
  });

  // ── Sessions ─────────────────────────────────────────────────────────────

  it('listSessions without offset', async () => {
    await client.listSessions();
    expect(fetchFn).toHaveBeenCalledWith('/api/sessions', expect.any(Object));
  });

  it('listSessions with offset', async () => {
    await client.listSessions(10);
    expect(fetchFn).toHaveBeenCalledWith('/api/sessions?offset=10', expect.any(Object));
  });

  it('getSessionMessages with abort signal', async () => {
    const controller = new AbortController();
    await client.getSessionMessages('sid-1', controller.signal);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/sessions/sid-1/messages',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('deleteSession sends DELETE', async () => {
    await client.deleteSession('sid-1');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/sessions/sid-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('renameSession sends PUT with title', async () => {
    await client.renameSession('sid-1', 'New Name');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/sessions/sid-1/rename',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ title: 'New Name' }),
      }),
    );
  });

  // ── Tasks ────────────────────────────────────────────────────────────────

  it('createTask sends POST with body', async () => {
    await client.createTask({ title: 'Test task' });
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Test task' }),
      }),
    );
  });

  it('updateTask sends PATCH', async () => {
    await client.updateTask('t1', { title: 'Updated' });
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/tasks/t1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated' }),
      }),
    );
  });

  it('approveTask sends POST', async () => {
    await client.approveTask('t1');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/tasks/t1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejectTask sends feedback', async () => {
    await client.rejectTask('t1', 'Not good enough');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/tasks/t1/reject',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ feedback: 'Not good enough' }),
      }),
    );
  });

  it('startLoop sends goalId and specMode', async () => {
    await client.startLoop('g1', true);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/loop/start',
      expect.objectContaining({
        body: JSON.stringify({ goalId: 'g1', specMode: true }),
      }),
    );
  });

  // ── Todos ────────────────────────────────────────────────────────────────

  it('getTodos without profile', async () => {
    await client.getTodos();
    expect(fetchFn).toHaveBeenCalledWith('/api/todos', expect.any(Object));
  });

  it('getTodos with profile', async () => {
    await client.getTodos('work');
    expect(fetchFn).toHaveBeenCalledWith('/api/todos?profile=work', expect.any(Object));
  });

  it('createTodo sends summary, profile, parentId', async () => {
    await client.createTodo('Fix bug', 'work', 'parent-1');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/todos',
      expect.objectContaining({
        body: JSON.stringify({ summary: 'Fix bug', profile: 'work', parentId: 'parent-1' }),
      }),
    );
  });

  it('todoAction sends action and optional days', async () => {
    await client.todoAction('td-1', 'snooze', 3);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/todos/td-1/action',
      expect.objectContaining({
        body: JSON.stringify({ action: 'snooze', days: 3 }),
      }),
    );
  });

  // ── Calendar ─────────────────────────────────────────────────────────────

  it('getCalendar passes date and days params', async () => {
    await client.getCalendar('2026-04-16', 7);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/calendar?'),
      expect.any(Object),
    );
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain('date=2026-04-16');
    expect(url).toContain('days=7');
  });

  // ── Inbox ────────────────────────────────────────────────────────────────

  it('getInbox calls /api/inbox', async () => {
    await client.getInbox();
    expect(fetchFn).toHaveBeenCalledWith('/api/inbox', expect.any(Object));
  });

  it('approveInboxItem sends POST', async () => {
    await client.approveInboxItem('item.md');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/inbox/item.md/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteInboxItem sends DELETE', async () => {
    await client.deleteInboxItem('item.md');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/inbox/item.md',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  // ── Skills ───────────────────────────────────────────────────────────────

  it('getSkills without cwd', async () => {
    await client.getSkills();
    expect(fetchFn).toHaveBeenCalledWith('/api/skills', expect.any(Object));
  });

  it('getSkills with cwd', async () => {
    await client.getSkills('/tmp/project');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/skills?cwd=%2Ftmp%2Fproject',
      expect.any(Object),
    );
  });

  // ── Files ────────────────────────────────────────────────────────────────

  it('listDirectory with root param', async () => {
    await client.listDirectory('/src', '/project');
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain('dir=%2Fsrc');
    expect(url).toContain('root=%2Fproject');
  });

  it('writeFile sends path and content', async () => {
    await client.writeFile('/tmp/test.ts', 'console.log("hi")');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/files/write',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ path: '/tmp/test.ts', content: 'console.log("hi")' }),
      }),
    );
  });
});
