import { useSearchParams } from 'react-router-dom';
import { ConnectionsView } from './ConnectionsView';

/** Each destination owns its transient credentials and pending UI state. */
export function ConnectionsRoute() {
  const [params] = useSearchParams();
  const requested = params.get('manage');
  const mode =
    requested === 'service'
      ? 'manage'
      : requested === 'personal' ||
          requested === 'google' ||
          requested === 'legacy' ||
          requested === 'openai' ||
          requested === 'keychain'
        ? requested
        : 'add';
  const connectionId = params.get('connection') ?? undefined;
  return (
    <ConnectionsView
      key={`${mode}:${connectionId ?? ''}`}
      mode={mode}
      connectionId={connectionId}
    />
  );
}
