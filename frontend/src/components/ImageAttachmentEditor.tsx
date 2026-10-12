import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ImageAttachment } from '../types/chat';
import {
  exportImageMarkup,
  imageMarkupLineWidth,
  normalizedImagePoint,
  type ImageMarkupStroke,
} from '../lib/image-markup';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import '../styles/image-attachment-editor.css';

const pens = [
  { name: 'Accent', color: 'var(--color-accent)' },
  { name: 'Red', color: 'var(--color-danger)' },
  { name: 'Blue', color: 'var(--color-info)' },
  { name: 'Green', color: 'var(--color-success)' },
];

export function ImageAttachmentEditor({
  image,
  onSave,
  onClose,
  title = 'Image preview',
}: {
  image: ImageAttachment;
  onSave: (updated: ImageAttachment) => void;
  onClose: () => void;
  title?: string;
}) {
  const original = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const active = useRef<{ pointerId: number; strokeIndex: number } | null>(null);
  const strokesRef = useRef<ImageMarkupStroke[]>([]);
  const alive = useRef(true);
  const exporting = useRef(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [strokes, setStrokes] = useState<ImageMarkupStroke[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [pen, setPen] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    alive.current = true;
    const element = stage.current!;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setAvailable({ width, height });
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      alive.current = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const replaceStrokes = (next: ImageMarkupStroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  };
  const loaded = dimensions.width > 0 && dimensions.height > 0;
  const scale =
    loaded && available.width && available.height
      ? Math.min(available.width / dimensions.width, available.height / dimensions.height)
      : 0;
  const lineWidth = imageMarkupLineWidth(dimensions.width, dimensions.height);
  const close = () => {
    alive.current = false;
    onClose();
  };

  function beginStroke(event: PointerEvent<HTMLDivElement>) {
    if (
      !drawing ||
      !loaded ||
      saving ||
      active.current ||
      event.button !== 0 ||
      event.isPrimary === false
    )
      return;
    const point = normalizedImagePoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    active.current = { pointerId: event.pointerId, strokeIndex: strokesRef.current.length };
    replaceStrokes([
      ...strokesRef.current,
      { color: getComputedStyle(event.currentTarget).color, points: [point] },
    ]);
  }
  function continueStroke(event: PointerEvent<HTMLDivElement>) {
    if (active.current?.pointerId !== event.pointerId || !active.current) return;
    event.preventDefault();
    const point = normalizedImagePoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    if (!point) return;
    const index = active.current.strokeIndex;
    const current = strokesRef.current[index];
    const last = current.points.at(-1)!;
    if (last.x === point.x && last.y === point.y) return;
    const next = [...strokesRef.current];
    next[index] = { ...current, points: [...current.points, point] };
    replaceStrokes(next);
  }
  function endStroke(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    if (!active.current || active.current.pointerId !== event.pointerId) return;
    if (cancelled) replaceStrokes(strokesRef.current.slice(0, active.current.strokeIndex));
    else continueStroke(event);
    active.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function save() {
    if (!loaded || exporting.current || active.current || !alive.current) return;
    exporting.current = true;
    setSaving(true);
    setError('');
    try {
      const updated = strokesRef.current.length
        ? await exportImageMarkup(original.current!, strokesRef.current)
        : image;
      if (alive.current) onSave(updated);
    } catch {
      if (alive.current)
        setError(
          'Could not save the drawing. Your original image is unchanged. Try again or Cancel.',
        );
    } finally {
      exporting.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return (
    <HomeDialog title={title} className="image-attachment-editor" onClose={close}>
      <div className="image-editor-tools" role="toolbar" aria-label="Image drawing tools">
        <button
          type="button"
          className="home-secondary"
          aria-pressed={drawing}
          disabled={!loaded || saving}
          onClick={() => setDrawing(!drawing)}
        >
          <UiIcon name="edit" size={16} /> Draw
        </button>
        <div className="image-editor-pens" role="group" aria-label="Pen color">
          {pens.map((item, index) => (
            <button
              key={item.name}
              type="button"
              className="home-secondary image-editor-pen"
              style={{ color: item.color }}
              aria-label={`${item.name} pen`}
              aria-pressed={index === pen}
              disabled={saving}
              onClick={() => setPen(index)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="home-secondary"
          disabled={!strokes.length || saving}
          onClick={() => {
            active.current = null;
            replaceStrokes(strokesRef.current.slice(0, -1));
          }}
        >
          <UiIcon name="undo" size={16} /> Undo
        </button>
        <button
          type="button"
          className="home-secondary"
          aria-label="Clear drawing"
          disabled={!strokes.length || saving}
          onClick={() => {
            active.current = null;
            replaceStrokes([]);
          }}
        >
          <UiIcon name="trash" size={16} /> Clear
        </button>
      </div>
      <div className="image-editor-stage" ref={stage}>
        <div
          className={`image-editor-frame${drawing ? ' image-editor-frame--drawing' : ''}`}
          aria-label="Image drawing surface"
          style={{
            color: pens[pen].color,
            width: scale ? dimensions.width * scale : undefined,
            height: scale ? dimensions.height * scale : undefined,
          }}
          onPointerDown={beginStroke}
          onPointerMove={continueStroke}
          onPointerUp={(event) => endStroke(event)}
          onPointerCancel={(event) => endStroke(event, true)}
          onLostPointerCapture={(event) => {
            if (active.current?.pointerId === event.pointerId) active.current = null;
          }}
        >
          <img
            ref={original}
            src={`data:${image.mediaType};base64,${image.data}`}
            alt="Attached image"
            draggable={false}
            onLoad={() => {
              if (original.current?.naturalWidth && original.current.naturalHeight) {
                setDimensions({
                  width: original.current.naturalWidth,
                  height: original.current.naturalHeight,
                });
                setError('');
              }
            }}
            onError={() => {
              setDimensions({ width: 0, height: 0 });
              setError('Could not load this image. Close the preview and try attaching it again.');
            }}
          />
          {loaded && (
            <svg
              className="image-editor-markup"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
              aria-hidden="true"
            >
              {strokes.map((stroke, index) =>
                stroke.points.length === 1 ? (
                  <circle
                    key={index}
                    data-markup-stroke=""
                    cx={stroke.points[0].x * dimensions.width}
                    cy={stroke.points[0].y * dimensions.height}
                    r={lineWidth / 2}
                    fill={stroke.color}
                  />
                ) : (
                  <polyline
                    key={index}
                    data-markup-stroke=""
                    points={stroke.points
                      .map(
                        (point) => `${point.x * dimensions.width},${point.y * dimensions.height}`,
                      )
                      .join(' ')}
                    fill="none"
                    stroke={stroke.color}
                    strokeWidth={lineWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ),
              )}
            </svg>
          )}
        </div>
      </div>
      <div className="image-editor-status" aria-live="polite">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>
            {!loaded
              ? 'Loading image…'
              : drawing
                ? 'Draw on the image with your finger or mouse. Save image applies your drawing.'
                : 'Preview your attachment, or choose Draw to mark it up.'}
          </p>
        )}
      </div>
      <footer>
        <button type="button" className="home-secondary" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="image-editor-save"
          disabled={!loaded || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving image…' : 'Save image'}
        </button>
      </footer>
    </HomeDialog>
  );
}
