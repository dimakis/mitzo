import { useState } from 'react';
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

  // Don't render until we have data
  if (tokenState.turnIndex === 0) return null;

  const ceiling = tokenState.contextCeiling ?? 0;
  const agentContext = tokenState.agentContext ?? 0;
  const sessionTotal = tokenState.sessionTotal ?? 0;
  const numCompactions = tokenState.numCompactions ?? 0;
  const ratio = ceiling > 0 ? agentContext / ceiling : 0;
  const color = getContextColor(ratio);
  // Completed sessions have agentContext=0 but sessionTotal>0 (hydrated from event store).
  // Show only session total in that case — the agent context bar is meaningless.
  const isCompleted = agentContext === 0 && sessionTotal > 0;

  if (tokenState.compacting) {
    return (
      <div className="token-bar token-bar--compacting" aria-label="Compacting context">
        <span className="token-bar-compacting-label">COMPACTING</span>
      </div>
    );
  }

  return (
    <>
      <button
        className={`token-bar token-bar--${isCompleted ? 'green' : color}`}
        onClick={() => setExpanded((v) => !v)}
        aria-label="Token usage"
        title="Token usage — tap for details"
      >
        {!isCompleted && (
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
            {formatTokens(agentContext)}/{formatTokens(ceiling)}
          </span>
        )}
        {sessionTotal > 0 && (
          <span className="token-bar-session">
            <span className="token-bar-sigma">Σ</span>
            {formatTokens(sessionTotal)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="token-bar-detail">
          <div className="token-bar-detail-row">
            <span>Agent context</span>
            <span>
              {agentContext.toLocaleString()} / {ceiling.toLocaleString()}
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
    </>
  );
}
