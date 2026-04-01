import { useState, useEffect, useRef, useCallback } from 'react';
import { truncate } from '../lib/truncate';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

interface Props {
  permId: string;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  displayName?: string;
  tier?: ToolTier;
  onRespond: (permId: string, decision: 'once' | 'always' | 'deny', toolName: string) => void;
}

const TIMEOUT_SECONDS = 120;

const TIER_LABELS: Record<ToolTier, string> = {
  safe: 'Safe',
  standard: 'File Edit',
  elevated: 'Shell Access',
  unknown: 'Unknown Tool',
};

export function PermissionBanner({
  permId,
  toolName,
  toolInput,
  title,
  description,
  displayName,
  tier,
  onRespond,
}: Props) {
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

  const tierClass =
    tier === 'elevated'
      ? ' perm-banner--elevated'
      : tier === 'unknown'
        ? ' perm-banner--unknown'
        : '';

  const heading = title || displayName || toolName;
  const detail = description || truncate(toolInput, 200);

  return (
    <div className={`perm-banner${tierClass}`}>
      <div className="perm-banner-info">
        {tier && (
          <span className={`perm-banner-tier perm-banner-tier--${tier}`}>{TIER_LABELS[tier]}</span>
        )}
        <span className="perm-banner-tool">{heading}</span>
        {detail && <pre className="perm-banner-input">{detail}</pre>}
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
