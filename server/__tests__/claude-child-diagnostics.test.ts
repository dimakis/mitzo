import { expect, it, vi } from 'vitest';
import {
  bindClaudeChildDiagnostic,
  reportClaudeChildDiagnostic,
} from '../claude-child-diagnostics.js';

it('binds child feedback to the exact runtime owner and lifetime', () => {
  const owner = {};
  const otherOwner = {};
  const first = vi.fn();
  const second = vi.fn();
  const issue = { code: 'claude_child_stop_failed' as const, correlationId: 'reference' };
  const unbind = bindClaudeChildDiagnostic(owner, first);
  expect(reportClaudeChildDiagnostic(otherOwner, 'task', 'tool', issue)).toBe(false);
  expect(reportClaudeChildDiagnostic(owner, 'task', 'tool', issue)).toBe(true);
  expect(first).toHaveBeenCalledWith('task', 'tool', issue);
  const unbindSecond = bindClaudeChildDiagnostic(owner, second);
  unbind();
  expect(reportClaudeChildDiagnostic(owner, 'task', 'tool', issue)).toBe(true);
  expect(second).toHaveBeenCalledOnce();
  unbindSecond();
  expect(reportClaudeChildDiagnostic(owner, 'task', 'tool', issue)).toBe(false);
});
