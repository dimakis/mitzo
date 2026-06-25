/** TerminalView — full-page interactive shell terminal. */

import { useRef, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Terminal } from '../components/Terminal';
import { useTerminal } from '../hooks/useTerminal';

export function TerminalView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const termRef = useRef<{ write: (data: string) => void } | null>(null);

  const resolvedSessionId = sessionId || `terminal-${Date.now()}`;

  const { state, connect, writeInput, resize, destroy } = useTerminal({
    sessionId: resolvedSessionId,
    onData: useCallback((data: string) => {
      termRef.current?.write(data);
    }, []),
    onExit: useCallback((_exitCode: number) => {
      termRef.current?.write('\r\n\x1b[90m[Process exited — press any key to restart]\x1b[0m\r\n');
    }, []),
    onError: useCallback((error: string) => {
      termRef.current?.write(`\r\n\x1b[31mError: ${error}\x1b[0m\r\n`);
    }, []),
  });

  // Connect on mount
  useEffect(() => {
    connect();
    return () => destroy();
  }, [connect, destroy]);

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <button className="terminal-back-btn" onClick={() => navigate(-1)}>
          ‹ Back
        </button>
        <span className="terminal-title">
          Terminal
          {state.connected && !state.exited && (
            <span className="terminal-status terminal-status--live" />
          )}
          {state.exited && <span className="terminal-status-text"> (exited)</span>}
          {!state.connected && !state.exited && (
            <span className="terminal-status-text"> (connecting...)</span>
          )}
        </span>
        <div className="terminal-header-spacer" />
      </div>
      <Terminal onData={writeInput} onResize={resize} termRef={termRef} />
    </div>
  );
}
