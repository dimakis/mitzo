import { useState } from 'react';
import type { TokenState } from '../hooks/useTokenState';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

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

  // Don't render until we have data
  if (tokenState.turnIndex === 0) return null;

  const ceiling = tokenState.contextCeiling;
  const ratio = ceiling > 0 ? tokenState.agentContext / ceiling : 0;
  const color = getContextColor(ratio);

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
            <path d="M12 2a9 9 0 0 0-9 9c0 3.1 1.6 5.8 4 7.4V21h2v-2h6v2h2v-2.6c2.4-1.6 4-4.3 4-7.4a9 9 0 0 0-9-9zm-1 14h-1v-4h1v4zm1-6H9.5V8.5a2.5 2.5 0 0 1 5 0V10H12zm3 6h-1v-4h1v4z" />
          </svg>
          {formatTokens(tokenState.agentContext)}/{formatTokens(ceiling)}
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
              {tokenState.agentContext.toLocaleString()} / {ceiling.toLocaleString()}
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
