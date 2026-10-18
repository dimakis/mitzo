import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { SavedArtifactVersion } from '../types/retained-artifact';
import {
  readSavedArtifactLocation,
  savedArtifactLocationUrl,
  withoutSavedArtifactLocation,
} from '../lib/saved-artifact-location';
import { readSavedArtifactVersion } from '../lib/retained-artifact-api';
import { SavedArtifactDialog } from './SavedArtifactDialog';

/** Route data is an exact selector, never a stored-content or access grant. */
export function SavedArtifactRouteDialog({ itemId }: { itemId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const selection = useMemo(() => readSavedArtifactLocation(location.search), [location.search]);
  const key =
    selection && selection !== 'invalid' ? JSON.stringify([itemId, selection]) : String(selection);
  const [ready, setReady] = useState<{ key: string; artifact: SavedArtifactVersion } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!selection || selection === 'invalid' || ready?.key === key) return;
    const controller = new AbortController();
    setError(null);
    readSavedArtifactVersion({ id: selection.id, itemId }, selection, controller.signal)
      .then((artifact) => {
        if (!controller.signal.aborted) setReady({ key, artifact });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError({
            key,
            message: error instanceof Error ? error.message : 'Saved version unavailable.',
          });
      });
    return () => controller.abort();
  }, [selection, itemId, key, ready?.key, retry]);
  const current = ready?.key === key ? ready.artifact : undefined;
  return (
    <SavedArtifactDialog
      artifact={current}
      open={selection !== null}
      error={
        selection === 'invalid'
          ? 'The saved version link is invalid.'
          : error?.key === key
            ? error.message
            : undefined
      }
      onRetry={() => setRetry((value) => value + 1)}
      onClose={() =>
        navigate(withoutSavedArtifactLocation(location.pathname + location.search), {
          replace: true,
        })
      }
      onVersionChange={(artifact) => {
        const url = savedArtifactLocationUrl(location.pathname + location.search, artifact);
        const pin = readSavedArtifactLocation(new URL(url, 'http://local.invalid').search);
        setReady({ key: JSON.stringify([itemId, pin]), artifact });
        navigate(url, { replace: true });
      }}
    />
  );
}
