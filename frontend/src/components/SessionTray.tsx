import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BootContextMeta } from '@mitzo/client';
import type { FinishedMessage, ImageAttachment, StreamingMessage } from '../types/chat';
import {
  collectSessionResources,
  mergeSessionResources,
  type SessionResource,
} from '../lib/session-resources';
import { MAX_IMAGE_ATTACHMENTS } from '../lib/constants';
import { ContextPanel } from './ContextPanel';
import { SessionBanner } from './SessionBanner';

type TraySnap = 'peek' | 'half' | 'full';

interface Props {
  messages: FinishedMessage[];
  current?: StreamingMessage | null;
  bootContext?: BootContextMeta | null;
  sessionContext?: string | null;
  selectedContextBlocks: string[];
  draftImages: ImageAttachment[];
  onToggleContextBlock: (name: string) => void;
  onAddImages: () => void;
  onRemoveImage: (index: number) => void;
}

const SNAP_ORDER: TraySnap[] = ['peek', 'half', 'full'];
const SWIPE_THRESHOLD = 48;

function moveSnap(snap: TraySnap, direction: 1 | -1): TraySnap {
  const index = SNAP_ORDER.indexOf(snap);
  return SNAP_ORDER[Math.max(0, Math.min(SNAP_ORDER.length - 1, index + direction))];
}

function ResourceIcon({ kind }: { kind: SessionResource['kind'] }) {
  const icon = { context: '◇', image: '▧', tool: '⌘', link: '◎', file: '□' }[kind];
  return <span className="session-tray-resource-icon">{icon}</span>;
}

function ResourceRow({ resource }: { resource: SessionResource }) {
  const content = (
    <>
      {resource.preview ? (
        <img className="session-tray-thumb" src={resource.preview} alt="" />
      ) : resource.imageId ? (
        <img className="session-tray-thumb" src={`/api/images/${resource.imageId}`} alt="" />
      ) : (
        <ResourceIcon kind={resource.kind} />
      )}
      <span className="session-tray-resource-label">{resource.label}</span>
    </>
  );

  return resource.href ? (
    <a className="session-tray-resource" href={resource.href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className="session-tray-resource" title={resource.path}>
      {content}
    </div>
  );
}

export function SessionTray({
  messages,
  current,
  bootContext,
  sessionContext,
  selectedContextBlocks,
  draftImages,
  onToggleContextBlock,
  onAddImages,
  onRemoveImage,
}: Props) {
  const [snap, setSnap] = useState<TraySnap>('peek');
  const [dragOffset, setDragOffset] = useState(0);
  const pointerStart = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const draftImageKeys = useRef(new WeakMap<ImageAttachment, string>());
  const nextDraftImageKey = useRef(0);
  const finishedResources = useMemo(() => collectSessionResources(messages), [messages]);
  const currentResources = useMemo(() => collectSessionResources([], current), [current]);
  const resources = useMemo(
    () => mergeSessionResources(finishedResources, currentResources),
    [finishedResources, currentResources],
  );
  const resourceCount = resources.sources.length + resources.outputs.length + draftImages.length;
  const isOpen = snap !== 'peek';

  const keyForDraftImage = (image: ImageAttachment) => {
    let key = draftImageKeys.current.get(image);
    if (!key) {
      key = `draft:${nextDraftImageKey.current++}`;
      draftImageKeys.current.set(image, key);
    }
    return key;
  };

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSnap('peek');
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const finishPointer = (clientY: number) => {
    if (pointerStart.current === null) return;
    const delta = clientY - pointerStart.current;
    pointerStart.current = null;
    setDragOffset(0);
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 400);
    setSnap((value) => moveSnap(value, delta > 0 ? 1 : -1));
  };

  return (
    <>
      {isOpen && (
        <button
          className="session-tray-backdrop"
          aria-label="Dismiss session tray"
          onClick={() => setSnap('peek')}
        />
      )}
      <aside
        className="session-tray"
        data-testid="session-tray"
        data-snap={snap}
        style={{ '--session-tray-drag': `${dragOffset}px` } as CSSProperties}
      >
        <button
          className="session-tray-handle"
          aria-label={isOpen ? 'Close session tray' : 'Open session tray'}
          aria-expanded={isOpen}
          onClick={() => {
            if (suppressClick.current) return;
            setSnap((value) => (value === 'peek' ? 'half' : 'peek'));
          }}
          onPointerDown={(event) => {
            pointerStart.current = event.clientY;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (pointerStart.current !== null) setDragOffset(event.clientY - pointerStart.current);
          }}
          onPointerUp={(event) => finishPointer(event.clientY)}
          onPointerCancel={() => {
            pointerStart.current = null;
            setDragOffset(0);
          }}
        >
          <span className="session-tray-grabber" />
          <span className="session-tray-handle-label">Session</span>
          {resourceCount > 0 && <span className="session-tray-count">{resourceCount}</span>}
        </button>

        <div
          className="session-tray-content"
          data-testid="session-tray-content"
          aria-hidden={!isOpen}
        >
          <section className="session-tray-section">
            <div className="session-tray-section-header">
              <h2>Outputs</h2>
            </div>
            {resources.outputs.length > 0 ? (
              <div className="session-tray-resources">
                {resources.outputs.map((resource) => (
                  <ResourceRow key={resource.id} resource={resource} />
                ))}
              </div>
            ) : (
              <p className="session-tray-empty">Generated files and previews will appear here</p>
            )}
          </section>

          <section className="session-tray-section">
            <div className="session-tray-section-header">
              <h2>Sources</h2>
              <button
                className="session-tray-add"
                aria-label="Add source"
                disabled={draftImages.length >= MAX_IMAGE_ATTACHMENTS}
                onClick={onAddImages}
              >
                +
              </button>
            </div>
            <div className="session-tray-resources">
              {draftImages.map((image, index) => (
                <div className="session-tray-resource" key={keyForDraftImage(image)}>
                  <img className="session-tray-thumb" src={image.preview} alt="" />
                  <span className="session-tray-resource-label">Pasted image {index + 1}</span>
                  <button
                    className="session-tray-remove"
                    aria-label={`Remove pasted image ${index + 1}`}
                    onClick={() => onRemoveImage(index)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {resources.sources.map((resource) => (
                <ResourceRow key={resource.id} resource={resource} />
              ))}
            </div>

            {(bootContext || sessionContext) && (
              <SessionBanner bootContext={bootContext} sessionContext={sessionContext} />
            )}
            <ContextPanel selected={selectedContextBlocks} onToggle={onToggleContextBlock} />
          </section>
        </div>
      </aside>
    </>
  );
}
