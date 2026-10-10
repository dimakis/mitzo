import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { readTerminalStream } from '../lib/terminal-stream';
export interface TerminalConsoleHandle {
  send(data: string): Promise<void>;
  reviewOutput(): string;
  focus(): void;
}
export type TerminalStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'unavailable';
export const TerminalConsole = forwardRef<
  TerminalConsoleHandle,
  {
    terminalId: string;
    onStatus: (status: TerminalStatus) => void;
    onError: (error: string) => void;
  }
>(function TerminalConsole({ terminalId, onStatus, onError }, ref) {
  const element = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    send = useRef<(data: string) => Promise<void>>(async () => {
      throw Error('Terminal unavailable');
    });
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  useImperativeHandle(
    ref,
    () => ({
      send: (data) => send.current(data),
      focus: () => terminal.current?.focus(),
      reviewOutput: () => {
        const term = terminal.current;
        if (!term) return '';
        const selected = term.getSelection();
        if (selected) return selected.slice(-16384);
        const buffer = term.buffer.active,
          lines = [];
        for (let i = Math.max(0, buffer.length - 100); i < buffer.length; i++)
          lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        return lines.join('\n').slice(-16384);
      },
    }),
    [],
  );
  useEffect(() => {
    let disposed = false,
      connected = false,
      ended = false,
      queued = 0;
    let queue = Promise.resolve();
    const controller = new AbortController(),
      term = new Terminal({
        fontSize: 13,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
        cursorBlink: true,
        scrollback: 2000,
        allowProposedApi: false,
      });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current!);
    const status = (value: TerminalStatus) => {
      connected = value === 'connected';
      if (!disposed) callbacks.current.onStatus(value);
    };
    const error = () => {
      status('unavailable');
      callbacks.current.onError('Input was not acknowledged. Check the terminal before retrying.');
    };
    send.current = (data: string) => {
      if (!connected || disposed || queued + data.length > 65536)
        return Promise.reject(Error('Terminal unavailable'));
      queued += data.length;
      const operation = queue
        .then(async () => {
          if (!connected || disposed) throw Error('Terminal unavailable');
          const response = await apiFetch(
            `/api/terminals/${encodeURIComponent(terminalId)}/input`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data }),
              signal: controller.signal,
            },
          );
          if (!response.ok) throw Error('Terminal input unavailable');
        })
        .catch((cause) => {
          if (!disposed) error();
          throw cause;
        })
        .finally(() => {
          queued -= data.length;
        });
      queue = operation.catch(() => {});
      return operation;
    };
    const input = term.onData((data) => {
      void send.current(data).catch(() => {});
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        fit.fit();
        if (!connected) return;
        void apiFetch(`/api/terminals/${encodeURIComponent(terminalId)}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cols: Math.max(2, Math.min(500, term.cols)),
            rows: Math.max(2, Math.min(300, term.rows)),
          }),
          signal: controller.signal,
        }).catch(() => {});
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element.current!);
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: style.getPropertyValue('--color-bg').trim(),
        foreground: style.getPropertyValue('--color-text').trim(),
        cursor: style.getPropertyValue('--color-accent').trim(),
      };
    };
    theme();
    const appearance = new MutationObserver(theme);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'class'],
    });
    const lost = () => {
      controller.abort();
      status('unavailable');
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        controller.signal.addEventListener('abort', finish, { once: true });
      });
    async function connect() {
      let attempts = 0;
      while (!disposed && !controller.signal.aborted && !ended) {
        status(attempts ? 'reconnecting' : 'connecting');
        try {
          const response = await apiFetch(
            `/api/terminals/${encodeURIComponent(terminalId)}/events`,
            { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
          );
          if (!response.ok || !response.body) {
            status('unavailable');
            callbacks.current.onError('Terminal unavailable. Check the selected environment.');
            return;
          }
          let seq = -1;
          for await (const event of readTerminalStream(response.body)) {
            if (disposed || controller.signal.aborted) break;
            if (event.type === 'snapshot') {
              term.reset();
              term.write(event.data);
              seq = event.seq;
              status('connected');
              attempts = 0;
              resize();
            } else if (event.type === 'output' && event.seq > seq) {
              term.write(event.data);
              seq = event.seq;
            } else if (event.type === 'exit') {
              ended = true;
              status('ended');
              break;
            } else if (event.type === 'error') throw Error('Terminal stream unavailable');
          }
        } catch {
          if (controller.signal.aborted || disposed) return;
        }
        if (ended) return;
        status('reconnecting');
        await delay(Math.min(10000, 500 * 2 ** Math.min(attempts++, 5)));
      }
    }
    void connect();
    resize();
    return () => {
      disposed = true;
      connected = false;
      controller.abort();
      input.dispose();
      observer.disconnect();
      appearance.disconnect();
      clearTimeout(resizeTimer);
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      term.dispose();
      terminal.current = null;
    };
  }, [terminalId]);
  return <div className="terminal-console" ref={element} aria-label="Interactive terminal" />;
});
