export const displayBranch = 'auto/session-memory-20260704-094957';
export function compactDisplayResponse(path: string, search: URLSearchParams): unknown {
  if (path === '/api/sessions') return { sessions: [], hasMore: false };
  if (path === '/api/sessions/search') return { results: [] };
  if (path === '/api/git/info')
    return { branch: displayBranch, repoPath: '/workspace', worktrees: [], worktreesLoaded: true };
  if (path === '/api/files/read')
    return {
      path: search.get('path'),
      ext: '.md',
      content:
        '# Give the next thought a place to wait.\n\nA small follow-up queue across accounts and runtimes.\n\n' +
        'Readable document content.\n\n'.repeat(60) +
        'Last paragraph.',
    };
  if (path === '/api/service-health')
    return { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 1 };
  if (path === '/api/config') return { contextBlocks: [] };
  return {};
}
