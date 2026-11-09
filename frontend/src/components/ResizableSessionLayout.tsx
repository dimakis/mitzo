import { useRef, type CSSProperties, type ReactNode } from 'react';
import { ResizeDivider } from './ResizeDivider';
import { layoutStorageNotice, useLayoutPreference } from '../hooks/useLayoutPreference';
const clamp = (value: number) => Math.max(26, Math.min(52, value));
function decodeWidth(raw: string) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error('InvalidLayoutPreference');
  return clamp(value);
}
export function ResizableSessionLayout({
  children,
  preview,
}: {
  children: ReactNode;
  preview?: ReactNode;
}) {
  const layout = useRef<HTMLDivElement>(null);
  const [width, save, unavailable] = useLayoutPreference(
    'mitzo-session-preview-width',
    36,
    decodeWidth,
    String,
  );
  return (
    <>
      {unavailable && (
        <p role="status" className="layout-storage-notice">
          {layoutStorageNotice}
        </p>
      )}
      <div
        ref={layout}
        className={`session-library-body${preview ? ' session-library-body--split' : ''}`}
        style={{ '--session-preview-width': `${width}%` } as CSSProperties}
      >
        {children}
        {preview && (
          <>
            <ResizeDivider
              label="Resize conversation preview"
              className="session-preview-divider"
              value={width}
              min={26}
              max={52}
              unit="%"
              step={2}
              direction={-1}
              onChange={save}
              onReset={() => save(36)}
              pixelsToValue={(pixels) => {
                const bounds = layout.current?.getBoundingClientRect();
                return bounds?.width ? (pixels / bounds.width) * 100 : 0;
              }}
            />
            {preview}
          </>
        )}
      </div>
    </>
  );
}
