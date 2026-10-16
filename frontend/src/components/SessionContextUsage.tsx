import type { Session } from '../types/chat';
import { formatTokens } from '../lib/formatTokens';
import '../styles/session-library.css';

export function SessionContextUsage({ usage }: { usage?: Session['contextUsage'] }) {
  const used = usage?.used;
  if (used == null || !Number.isSafeInteger(used) || used <= 0)
    return <span className="session-context-usage">Context unavailable</span>;
  const limits = usage?.limits;
  const capacities = [limits?.contextWindow, limits?.inputTokenLimit].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  );
  const valid =
    limits &&
    limits.source !== 'unknown' &&
    !limits.stale &&
    (limits.expiresAt == null || limits.expiresAt > Date.now()) &&
    capacities.length > 0;
  const ceiling = valid ? Math.min(...capacities) : 0;
  const percentage = ceiling > 0 ? Math.min(100, Math.round((used / ceiling) * 100)) : null;
  return (
    <span className="session-context-usage">
      <span>Context</span>
      <span>
        {percentage == null
          ? `${formatTokens(used)} · limit not reported`
          : `${percentage}% · ${formatTokens(used)} / ${formatTokens(ceiling)}`}
      </span>
      {percentage != null && (
        <span
          className="session-context-meter"
          role="meter"
          aria-label="Context used"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percentage}%` }} />
        </span>
      )}
    </span>
  );
}
