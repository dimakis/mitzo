import { useState, useEffect, useRef, useCallback } from 'react';

interface Props {
  permId: string;
  toolName: string;
  toolInput: string;
  onRespond: (permId: string, allowed: boolean) => void;
}

const TIMEOUT_SECONDS = 120;

export function PermissionBanner({
  permId,
  toolName,
  toolInput,
  onRespond,
}: Props) {
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const deny = useCallback(() => {
    onRespond(permId, false);
  }, [permId, onRespond]);

  useEffect(() => {
    setRemaining(TIMEOUT_SECONDS);

    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          deny();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [permId, deny]);

  function truncateInput(input: string, max = 200): string {
    if (input.length <= max) return input;
    return input.slice(0, max) + '...';
  }

  return (
    <div className="perm-banner">
      <div className="perm-banner-info">
        <span className="perm-banner-tool">{toolName}</span>
        <pre className="perm-banner-input">{truncateInput(toolInput)}</pre>
        <span className="perm-banner-timer">Auto-deny in {remaining}s</span>
      </div>
      <div className="perm-banner-actions">
        <button
          className="perm-banner-allow"
          onClick={() => onRespond(permId, true)}
        >
          Allow
        </button>
        <button className="perm-banner-deny" onClick={deny}>
          Deny
        </button>
      </div>
    </div>
  );
}
