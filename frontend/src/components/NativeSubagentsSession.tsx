import { useState, type ReactNode } from 'react';
import { NativeSubagentDialogContext } from '../lib/native-subagent-dialog-context';
import { NativeSubagents } from './NativeSubagents';

/** One dialog/draft owner shared by transcript links and the persistent control. */
export function NativeSubagentsSession({
  sessionId,
  children,
  footer,
  enabled = true,
}: {
  sessionId: string;
  children: ReactNode;
  footer?: ReactNode;
  enabled?: boolean;
}) {
  const [selection, setSelection] = useState<{
    selectedId?: string;
    origin?: 'transcript' | 'launcher';
  }>({});
  return (
    <NativeSubagentDialogContext.Provider
      value={{
        ...selection,
        open: (selectedId, origin) =>
          setSelection((previous) => ({ selectedId, origin: origin ?? previous.origin })),
      }}
    >
      {children}
      {enabled && <NativeSubagents sessionId={sessionId} floating />}
      {footer}
    </NativeSubagentDialogContext.Provider>
  );
}
