import { useCallback } from 'react';
import { wsSend } from '../lib/ws-pool';

export function usePermission(poolKey: string, onClear: () => void) {
  const handlePermission = useCallback(
    (permId: string, decision: 'once' | 'always' | 'deny', toolName: string) => {
      wsSend(poolKey, { type: 'permission_response', permId, decision, toolName });
      onClear();
    },
    [poolKey, onClear],
  );

  return { handlePermission };
}
