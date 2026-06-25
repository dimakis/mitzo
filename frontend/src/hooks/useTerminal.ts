/**
 * useTerminal — manages a WebSocket connection to the terminal backend.
 *
 * Shares the same WS endpoint as chat (/ws/chat) but sends terminal-specific
 * message types (terminal_create, terminal_input, terminal_resize, terminal_destroy).
 * The v2 protocol dispatcher routes these to the terminal handlers.
 */

import { useRef, useCallback, useEffect, useState } from 'react';
import { getWsChatUrl } from '../lib/api-fetch';

export interface TerminalState {
  terminalId: string | null;
  connected: boolean;
  exited: boolean;
  exitCode?: number;
}

interface UseTerminalOptions {
  sessionId: string;
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onExit?: (exitCode: number, signal?: number) => void;
  onError?: (error: string) => void;
}

export function useTerminal({
  sessionId,
  cols = 80,
  rows = 24,
  onData,
  onExit,
  onError,
}: UseTerminalOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [state, setState] = useState<TerminalState>({
    terminalId: null,
    connected: false,
    exited: false,
  });

  // Store latest callbacks in refs to avoid reconnect churn
  const onDataRef = useRef(onData);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onExitRef.current = onExit;
  onErrorRef.current = onError;

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWsChatUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      // v2 handshake
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2 }));
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'welcome':
          // Handshake complete — create terminal
          send({
            type: 'terminal_create',
            sessionId,
            cols,
            rows,
          });
          setState((s) => ({ ...s, connected: true }));
          break;

        case 'terminal_created':
          terminalIdRef.current = msg.terminalId as string;
          setState((s) => ({
            ...s,
            terminalId: msg.terminalId as string,
          }));
          break;

        case 'terminal_output':
          if (msg.terminalId === terminalIdRef.current) {
            onDataRef.current(msg.data as string);
          }
          break;

        case 'terminal_exit':
          if (msg.terminalId === terminalIdRef.current) {
            setState((s) => ({
              ...s,
              exited: true,
              exitCode: msg.exitCode as number,
            }));
            onExitRef.current?.(msg.exitCode as number, msg.signal as number | undefined);
          }
          break;

        case 'terminal_error':
          onErrorRef.current?.(msg.error as string);
          break;
      }
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, connected: false }));
    };
  }, [sessionId, cols, rows, send]);

  const writeInput = useCallback(
    (data: string) => {
      if (!terminalIdRef.current) return;
      send({ type: 'terminal_input', terminalId: terminalIdRef.current, data });
    },
    [send],
  );

  const resize = useCallback(
    (newCols: number, newRows: number) => {
      if (!terminalIdRef.current) return;
      send({
        type: 'terminal_resize',
        terminalId: terminalIdRef.current,
        cols: newCols,
        rows: newRows,
      });
    },
    [send],
  );

  const destroy = useCallback(() => {
    if (terminalIdRef.current) {
      send({ type: 'terminal_destroy', terminalId: terminalIdRef.current });
    }
    wsRef.current?.close();
    wsRef.current = null;
    terminalIdRef.current = null;
    setState({ terminalId: null, connected: false, exited: false });
  }, [send]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (terminalIdRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: 'terminal_destroy', terminalId: terminalIdRef.current }),
        );
      }
      wsRef.current?.close();
    };
  }, []);

  return { state, connect, writeInput, resize, destroy };
}
