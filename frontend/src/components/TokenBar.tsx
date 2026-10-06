import { useId, useState } from 'react';
import type { TokensState as TokenState } from '@mitzo/client';
import { formatTokens } from '../lib/formatTokens';

function getContextColor(ratio: number): string {
  if (ratio >= 0.95) return 'flashing';
  if (ratio >= 0.8) return 'red';
  if (ratio >= 0.5) return 'yellow';
  return 'green';
}

interface Props {
  tokenState: TokenState;
}

export function TokenBar({ tokenState }: Props) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();

  // Don't render until we have data
  if (tokenState.turnIndex === 0) return null;

  const ceiling = tokenState.contextCeiling ?? 0;
  const agentContext = tokenState.agentContext ?? 0;
  const sessionTotal = tokenState.sessionTotal ?? 0;
  const numCompactions = tokenState.numCompactions ?? 0;
  // Zero is also the initial/restored sentinel; it does not prove an empty window.
  const hasContext =
    Number.isFinite(agentContext) && agentContext > 0 && Number.isFinite(ceiling) && ceiling > 0;
  const ratio = hasContext ? Math.min(1, agentContext / ceiling) : 0;
  const color = hasContext ? getContextColor(ratio) : 'unknown';
  const summary = hasContext
    ? `Context ${formatTokens(agentContext)}/${formatTokens(ceiling)} (${Math.round(ratio * 100)}%)`
    : 'Context usage not reported';

  return (
    <div className="token-wheel-control">
      <button
        className={`token-bar token-bar--${color}`}
        onClick={() => setExpanded((v) => !v)}
        aria-label="Token usage"
        aria-expanded={expanded}
        aria-describedby={summaryId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setExpanded(false);
        }}
        title={`${summary} — tap for details`}
      >
        <svg className="token-wheel" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <circle
            className="token-wheel-track"
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          />
          {hasContext ? (
            <circle
              className="token-wheel-fill"
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - ratio * 100}
              transform="rotate(-90 12 12)"
              opacity={0.45 + ratio * 0.55}
            />
          ) : (
            <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="12">
              ?
            </text>
          )}
        </svg>
        <span id={summaryId} className="sr-only">
          {summary}
          {sessionTotal > 0 ? `; Session ${formatTokens(sessionTotal)}` : ''}
        </span>
      </button>
      {expanded && (
        <div className="token-bar-detail">
          <div className="token-bar-detail-row">
            <span>Agent context</span>
            <span>
              {hasContext
                ? `${agentContext.toLocaleString()} / ${ceiling.toLocaleString()}`
                : 'Not reported'}
            </span>
          </div>
          <div className="token-bar-detail-row">
            <span>Session tokens</span>
            <span>{sessionTotal.toLocaleString()}</span>
          </div>
          {tokenState.numTurns > 0 && (
            <div className="token-bar-detail-row">
              <span>Turns</span>
              <span>{tokenState.numTurns} turns</span>
            </div>
          )}
          {numCompactions > 0 && (
            <div className="token-bar-detail-row">
              <span>Compactions</span>
              <span>{numCompactions}</span>
            </div>
          )}
          <div className="token-bar-detail-row">
            <span>Agent #</span>
            <span>{tokenState.turnIndex}</span>
          </div>
        </div>
      )}
    </div>
  );
}
