import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { readLaunchQuote } from '../lib/launch-quote';
import { chooseStartupPhrase } from '../lib/startup-phrases';
import { animateQuoteHandoff, motionDuration } from '../lib/motion';
import { LiquidLogo } from './LiquidLogo';
import '../styles/startup.css';

type StartupState = 'loading' | 'unavailable' | 'ready';
export function StartupScreen({ state, onRetry }: { state: StartupState; onRetry: () => void }) {
  const [phrase] = useState(chooseStartupPhrase);
  const [quote] = useState(() => readLaunchQuote());
  const [visible, setVisible] = useState(state !== 'ready');
  const [quoteReady, setQuoteReady] = useState(false);
  const glyph = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const timer = setTimeout(() => setQuoteReady(true), motionDuration('quote'));
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (state !== 'ready') {
      setVisible(true);
      return;
    }
    const source = glyph.current;
    const origin = source?.getBoundingClientRect();
    // Authentication and page rendering never wait for decoration to finish.
    setVisible(false);
    if (!source || !origin || reduced || !quoteReady) return;
    let cancelFlight: (() => void) | null = null;
    const observer = new MutationObserver(fly);
    const deadline = setTimeout(() => observer.disconnect(), 1_000);
    function fly() {
      const target = document.querySelector<HTMLElement>('.home-daily-quote > span');
      if (!target || !source) return;
      observer.disconnect();
      clearTimeout(deadline);
      cancelFlight = animateQuoteHandoff(source, target, origin);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    fly();
    return () => {
      observer.disconnect();
      clearTimeout(deadline);
      cancelFlight?.();
    };
  }, [state, reduced, quoteReady]);
  if (!visible) return null;
  const showQuote = Boolean(quote && (quoteReady || reduced));
  return createPortal(
    <section
      className={`startup-screen${showQuote ? ' startup-screen--quote' : ''}`}
      data-testid="startup-screen"
      aria-label="Opening Mitzo"
    >
      <LiquidLogo />
      <div className="startup-content">
        <p className="startup-phrase" data-testid="startup-phrase">
          {phrase}
        </p>
        {showQuote && quote && (
          <blockquote className="startup-quote" role="blockquote">
            <span ref={glyph} className="startup-quote-mark" aria-hidden="true">
              “
            </span>
            <p>{quote.quote.text}</p>
            <footer>
              {quote.quote.author}
              <cite>{quote.quote.work}</cite>
            </footer>
          </blockquote>
        )}
        {state === 'unavailable' ? (
          <div className="startup-recovery" role="alert">
            <p>Mitzo could not be reached. Check your connection and try again.</p>
            <button className="btn-primary" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : (
          <p className={showQuote ? 'startup-connection' : 'sr-only'} role="status">
            Connecting to Mitzo…
          </p>
        )}
      </div>
    </section>,
    document.body,
  );
}
