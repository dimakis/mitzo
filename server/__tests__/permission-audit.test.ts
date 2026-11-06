import { expect, it, vi } from 'vitest';
import { recordPermissionAudit } from '@mitzo/harness';
import { persistPermissionAudit } from '../permission-audit.js';
it('persists the common approval audit independently of the UI response transport', () => {
  const events = { append: vi.fn(() => 1) };
  const release = persistPermissionAudit(events);
  try {
    for (const toolName of ['Bash', 'NativeCommandApproval', 'mcp__atlassian__read']) {
      recordPermissionAudit({
        phase: 'resolved',
        time: Date.now(),
        sessionId: 'chat',
        permId: toolName,
        toolName,
        outcome: 'allowed',
        decision: 'always',
        waitMs: 4,
      });
    }
    expect(events.append).toHaveBeenCalledTimes(3);
    expect(events.append).toHaveBeenCalledWith(
      'chat',
      'permission_audit',
      expect.objectContaining({ decision: 'always', outcome: 'allowed' }),
    );
  } finally {
    release();
  }
});
