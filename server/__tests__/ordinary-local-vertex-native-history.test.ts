import { expect, it, vi, afterEach } from 'vitest';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { assertOrdinaryLocalVertexHistory } from '../ordinary-local-vertex-native-history.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
it('requires original SDK UUID, exact project directory and retained messages without searching other projects', async () => {
  vi.mocked(getSessionInfo).mockResolvedValue({
    sessionId: 'original',
    cwd: '/task',
    summary: 'offline',
    lastModified: 1,
  } as never);
  vi.mocked(getSessionMessages).mockResolvedValue([{ uuid: 'input' }] as never);
  await expect(assertOrdinaryLocalVertexHistory('original', '/task')).resolves.toBeUndefined();
  expect(getSessionInfo).toHaveBeenCalledWith('original', { dir: '/task' });
  expect(getSessionMessages).toHaveBeenCalledWith('original', { dir: '/task', limit: 1 });
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: 'other', cwd: '/task' } as never);
  await expect(assertOrdinaryLocalVertexHistory('original', '/task')).rejects.toThrow();
  expect(getSessionMessages).toHaveBeenCalledTimes(1);
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: 'original', cwd: '/other' } as never);
  await expect(assertOrdinaryLocalVertexHistory('original', '/task')).rejects.toThrow();
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: 'original', cwd: '/task' } as never);
  vi.mocked(getSessionMessages).mockResolvedValue([]);
  await expect(assertOrdinaryLocalVertexHistory('original', '/task')).rejects.toThrow();
});
