/**
 * Terminal — xterm.js wrapper with mobile keyboard toolbar.
 *
 * Renders a full-screen terminal emulator using xterm.js, connected to a
 * server-side PTY via the useTerminal hook. Includes a touch-friendly toolbar
 * with special keys (Tab, Ctrl, arrows, Esc) for mobile use.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Ref callback — parent calls write() to push PTY output into the terminal. */
  termRef: React.MutableRefObject<{ write: (data: string) => void } | null>;
}

export function Terminal({ onData, onResize, termRef }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ctrlActive, setCtrlActive] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3a3a5e',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#74c0fc',
        magenta: '#cc5de8',
        cyan: '#66d9e8',
        white: '#e0e0e0',
        brightBlack: '#4a4a6e',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#91d5ff',
        brightMagenta: '#da77f2',
        brightCyan: '#99e9f2',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon());

    xterm.open(containerRef.current);

    // Delay fit to ensure container has layout dimensions
    requestAnimationFrame(() => {
      fit.fit();
      onResize(xterm.cols, xterm.rows);
    });

    xterm.onData((data) => {
      onData(data);
    });

    // Expose write method to parent
    termRef.current = {
      write: (data: string) => xterm.write(data),
    };

    xtermRef.current = xterm;

    const handleResize = () => {
      fit.fit();
      onResize(xterm.cols, xterm.rows);
    };

    window.addEventListener('resize', handleResize);

    // Also re-fit when keyboard opens/closes on mobile
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fit.fit();
        onResize(xterm.cols, xterm.rows);
      });
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      termRef.current = null;
      xterm.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendKey = useCallback(
    (key: string) => {
      if (ctrlActive) {
        // Convert to control character (Ctrl+A = \x01, Ctrl+C = \x03, etc.)
        const code = key.toUpperCase().charCodeAt(0) - 64;
        if (code > 0 && code < 32) {
          onData(String.fromCharCode(code));
        }
        setCtrlActive(false);
      } else {
        onData(key);
      }
      xtermRef.current?.focus();
    },
    [ctrlActive, onData],
  );

  const toolbarKeys = [
    { label: 'Esc', key: '\x1b' },
    { label: 'Tab', key: '\t' },
    { label: 'Ctrl', key: '__ctrl__' },
    { label: '\u2191', key: '\x1b[A' },
    { label: '\u2193', key: '\x1b[B' },
    { label: '\u2190', key: '\x1b[D' },
    { label: '\u2192', key: '\x1b[C' },
    { label: '|', key: '|' },
    { label: '/', key: '/' },
    { label: '~', key: '~' },
  ];

  return (
    <div className="terminal-container">
      <div className="terminal-xterm" ref={containerRef} />
      <div className="terminal-toolbar">
        {toolbarKeys.map((tk) => (
          <button
            key={tk.label}
            className={`terminal-toolbar-key${tk.key === '__ctrl__' && ctrlActive ? ' terminal-toolbar-key--active' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault(); // Don't steal focus from xterm
              if (tk.key === '__ctrl__') {
                setCtrlActive((v) => !v);
              } else {
                sendKey(tk.key);
              }
            }}
          >
            {tk.label}
          </button>
        ))}
      </div>
    </div>
  );
}
