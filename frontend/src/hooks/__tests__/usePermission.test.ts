// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockWsSend = vi.fn();

vi.mock('../../lib/ws-pool', () => ({
  wsSend: (...args: unknown[]) => mockWsSend(...args),
}));

import { usePermission } from '../usePermission';

describe('usePermission', () => {
  it('sends correct WS message', () => {
    mockWsSend.mockClear();
    const onClear = vi.fn();
    const { result } = renderHook(() => usePermission('key1', onClear));

    result.current.handlePermission('p1', 'once', 'Bash');
    expect(mockWsSend).toHaveBeenCalledWith('key1', {
      type: 'permission_response',
      permId: 'p1',
      decision: 'once',
      toolName: 'Bash',
    });
  });

  it('calls onClear after sending', () => {
    mockWsSend.mockClear();
    const onClear = vi.fn();
    const { result } = renderHook(() => usePermission('key1', onClear));

    result.current.handlePermission('p1', 'deny', 'Read');
    expect(onClear).toHaveBeenCalled();
  });
});
