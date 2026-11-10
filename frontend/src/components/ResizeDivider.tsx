import { useRef } from 'react';
import './ResizeDivider.css';

interface ResizeDividerProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onReset: () => void;
  direction?: 1 | -1;
  step?: number;
  unit?: string;
  // Percentage panels convert pointer movement relative to their own container.
  pixelsToValue?: (pixels: number) => number;
  className?: string;
}
export function ResizeDivider({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
  direction = 1,
  step = 10,
  unit = 'px',
  pixelsToValue = (pixels) => pixels,
  className = '',
}: ResizeDividerProps) {
  const drag = useRef<{ id: number; x: number; value: number } | null>(null);
  const change = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return (
    <button
      type="button"
      role="separator"
      className={`resize-divider ${className}`}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)}${unit}`}
      title={`${label}. Drag or use arrow keys; double-click to reset.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { id: event.pointerId, x: event.clientX, value };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.id === event.pointerId)
          change(start.value + pixelsToValue(event.clientX - start.x) * direction);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        change(
          event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : value + (event.key === 'ArrowRight' ? 1 : -1) * direction * step,
        );
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}
