import { useState } from 'react';
import type { TokenState } from '../hooks/useTokenState';

const CONTEXT_CEILING = 200_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function getContextColor(tokens: number): string {
  if (tokens >= 190_000) return 'flashing';
  if (tokens >= 160_000) return 'red';
  if (tokens >= 100_000) return 'yellow';
  return 'green';
}

interface Props {
  tokenState: TokenState;
}

export function TokenBar({ tokenState }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Don't render until we have data
  if (tokenState.turnIndex === 0) return null;

  const color = getContextColor(tokenState.agentContext);

  return (
    <>
      <button
        className={`token-bar token-bar--${color}`}
        onClick={() => setExpanded((v) => !v)}
        aria-label="Token usage"
        title="Token usage — tap for details"
      >
        <span className="token-bar-agent">
          <svg
            className="token-bar-icon"
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="currentColor"
          >
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-14h2v6h-2zm0 8h2v2h-2z" />
            <path d="M15.5 7.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zM8.5 7.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zM12 17.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
          </svg>
          {formatTokens(tokenState.agentContext)}/{formatTokens(CONTEXT_CEILING)}
        </span>
        {tokenState.sessionTotal > 0 && (
          <span className="token-bar-session">
            <span className="token-bar-sigma">Σ</span>
            {formatTokens(tokenState.sessionTotal)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="token-bar-detail">
          <div className="token-bar-detail-row">
            <span>Agent context</span>
            <span>
              {tokenState.agentContext.toLocaleString()} / {CONTEXT_CEILING.toLocaleString()}
            </span>
          </div>
          <div className="token-bar-detail-row">
            <span>Session tokens</span>
            <span>{tokenState.sessionTotal.toLocaleString()}</span>
          </div>
          {tokenState.costUsd > 0 && (
            <div className="token-bar-detail-row">
              <span>Cost</span>
              <span>~${tokenState.costUsd.toFixed(2)}</span>
            </div>
          )}
          {tokenState.numTurns > 0 && (
            <div className="token-bar-detail-row">
              <span>Turns</span>
              <span>{tokenState.numTurns} turns</span>
            </div>
          )}
          <div className="token-bar-detail-row">
            <span>Agent #</span>
            <span>{tokenState.turnIndex}</span>
          </div>
        </div>
      )}
    </>
  );
}
