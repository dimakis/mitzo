import { useRef, useState, type CSSProperties, type ReactNode, type PointerEvent } from 'react';
const KEY = 'mitzo-session-preview-width';
function clamp(value: number) {
  return Math.max(26, Math.min(52, value));
}
function readWidth() {
  try {
    const value = Number(localStorage.getItem(KEY));
    return value > 0 && Number.isFinite(value) ? clamp(value) : 36;
  } catch {
    return 36;
  }
}
export function ResizableSessionLayout({
  children,
  preview,
}: {
  children: ReactNode;
  preview?: ReactNode;
}) {
  const layout = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readWidth);
  const dragging = useRef(false);
  function save(value: number) {
    try {
      localStorage.setItem(KEY, String(value));
    } catch {
      /* Resize remains available when device storage is unavailable. */
    }
  }
  function resize(event: PointerEvent<HTMLButtonElement>) {
    const bounds = layout.current?.getBoundingClientRect();
    if (bounds?.width) {
      const next = clamp(((bounds.right - event.clientX) / bounds.width) * 100);
      setWidth(next);
      save(next);
    }
  }
  return (
    <div
      ref={layout}
      className={`session-library-body${preview ? ' session-library-body--split' : ''}`}
      style={{ '--session-preview-width': `${width}%` } as CSSProperties}
    >
      {children}
      {preview && (
        <>
          <button
            type="button"
            className="session-preview-divider"
            role="separator"
            aria-label="Resize conversation preview"
            aria-orientation="vertical"
            aria-valuemin={26}
            aria-valuemax={52}
            aria-valuenow={Math.round(width)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              dragging.current = true;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              resize(event);
            }}
            onPointerMove={(event) => {
              if (dragging.current) resize(event);
            }}
            onPointerUp={(event) => {
              dragging.current = false;
              if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
            onLostPointerCapture={() => {
              dragging.current = false;
            }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 26
                  : event.key === 'End'
                    ? 52
                    : clamp(width + (event.key === 'ArrowLeft' ? 2 : -2));
              setWidth(next);
              save(next);
            }}
          >
            <span aria-hidden="true" />
          </button>
          {preview}
        </>
      )}
    </div>
  );
}
