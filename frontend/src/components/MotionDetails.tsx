import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMotionPresence } from '../hooks/useMotionPresence';

/** Native disclosure semantics with the shared interruptible height transition.
 * Keep form children mounted; closing immediately removes their input authority. */
export function MotionDetails({
  summary,
  children,
  className = '',
  summaryClassName,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  summaryClassName?: string;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const { ref, present } = useMotionPresence(expanded, 'disclosure', false);
  const summaryRef = useRef<HTMLElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!expanded && ref.current?.contains(document.activeElement))
      summaryRef.current?.focus({ preventScroll: true });
  }, [expanded, ref]);
  return (
    <details
      className={`motion-details ${className}`.trim()}
      open={expanded || present}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        summaryRef.current?.focus({ preventScroll: true });
      }}
    >
      <summary
        ref={summaryRef}
        className={summaryClassName}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('a, button, input, select, textarea')
          )
            return;
          event.preventDefault();
          setExpanded((previous) => !previous);
        }}
      >
        {summary}
      </summary>
      <div
        id={id}
        ref={ref}
        className="motion-disclosure"
        hidden={!present}
        inert={!expanded}
        aria-hidden={!expanded || undefined}
      >
        {children}
      </div>
    </details>
  );
}
