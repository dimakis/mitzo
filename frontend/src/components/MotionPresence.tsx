import type { HTMLAttributes } from 'react';
import { useMotionPresence } from '../hooks/useMotionPresence';
import type { MotionKind } from '../lib/motion';

type Props = HTMLAttributes<HTMLDivElement> & {
  open: boolean;
  kind?: Exclude<MotionKind, 'page'>;
  appear?: boolean;
};

export function MotionPresence({
  open,
  kind = 'popover',
  appear = true,
  children,
  className = '',
  ...props
}: Props) {
  const { ref, present } = useMotionPresence(open, kind, appear);
  if (!present) return null;
  return (
    <div
      {...props}
      ref={ref}
      className={`motion-presence ${className}`}
      data-motion={kind}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      {children}
    </div>
  );
}
