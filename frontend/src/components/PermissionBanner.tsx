import { useState, useEffect, useRef, useCallback } from 'react';
import { truncate } from '../lib/truncate';

interface Props {
  permId: string;
  toolName: string;
  toolInput: string;
  onRespond: (permId: string, decision: 'once' | 'always' | 'deny', toolName: string) => void;
}

const TIMEOUT_SECONDS = 120;

export function PermissionBanner({ permId, toolName, toolInput, onRespond }: Props) {
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const deny = useCallback(() => {
    onRespond(permId, 'deny', toolName);
  }, [permId, toolName, onRespond]);

  useEffect(() => {
    setRemaining(TIMEOUT_SECONDS);
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          deny();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [permId, deny]);

  return (
    <div className="perm-banner">
      <div className="perm-banner-info">
        <span className="perm-banner-tool">{toolName}</span>
        <pre className="perm-banner-input">{truncate(toolInput, 200)}</pre>
        <span className="perm-banner-timer">Auto-deny in {remaining}s</span>
      </div>
      <div className="perm-banner-actions">
        <button
          className="perm-banner-btn perm-banner-btn--once"
          onClick={() => onRespond(permId, 'once', toolName)}
        >
          Allow Once
        </button>
        <button
          className="perm-banner-btn perm-banner-btn--always"
          onClick={() => onRespond(permId, 'always', toolName)}
        >
          Always Allow
        </button>
        <button className="perm-banner-btn perm-banner-btn--deny" onClick={deny}>
          Deny
        </button>
      </div>
    </div>
  );
}
