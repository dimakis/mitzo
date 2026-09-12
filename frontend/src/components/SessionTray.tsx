import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
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

function pendingAttachmentLabel(imageCount: number, contextCount: number): string {
  const parts = [];
  if (imageCount > 0) parts.push(`${imageCount} draft image${imageCount === 1 ? '' : 's'}`);
  if (contextCount > 0) parts.push(`${contextCount} context block${contextCount === 1 ? '' : 's'}`);
  return `${parts.join(' and ')} attached`;
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
  const contentId = useId();
  const outputsContentId = useId();
  const sourcesContentId = useId();
  const [snap, setSnap] = useState<TraySnap>('peek');
  const [outputsExpanded, setOutputsExpanded] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
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
  const outputsCount = resources.outputs.length;
  const sourcesCount = resources.sources.length + draftImages.length;
  const resourceCount = sourcesCount + outputsCount;
  const pendingAttachmentCount = draftImages.length + selectedContextBlocks.length;
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
          type="button"
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
          type="button"
          className="session-tray-handle"
          aria-label={isOpen ? 'Close session tray' : 'Open session tray'}
          aria-expanded={isOpen}
          aria-controls={contentId}
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
          <span className="session-tray-handle-label">Session · Outputs / Sources</span>
          {resourceCount > 0 && <span className="session-tray-count">{resourceCount}</span>}
          {pendingAttachmentCount > 0 && (
            <span
              className="session-tray-pending-count"
              aria-label={pendingAttachmentLabel(draftImages.length, selectedContextBlocks.length)}
            >
              {pendingAttachmentCount}
            </span>
          )}
        </button>

        <div
          id={contentId}
          className="session-tray-content"
          data-testid="session-tray-content"
          aria-hidden={!isOpen}
        >
          {isOpen && (
            <div className="session-tray-size-controls">
              <button
                type="button"
                onClick={() => setSnap(snap === 'full' ? 'half' : 'full')}
                aria-label={snap === 'full' ? 'Reduce session tray' : 'Expand session tray'}
              >
                {snap === 'full' ? 'Half height' : 'Full height'}
              </button>
            </div>
          )}
          <div className="session-tray-columns">
            <section className="session-tray-section">
              <div className="session-tray-section-header">
                <h2>
                  <button
                    type="button"
                    className="session-tray-section-toggle"
                    aria-label={`Outputs ${outputsCount}`}
                    aria-expanded={outputsExpanded}
                    aria-controls={outputsContentId}
                    onClick={() => setOutputsExpanded((expanded) => !expanded)}
                  >
                    <span>Outputs</span>
                    <span className="session-tray-section-count">{outputsCount}</span>
                    <span className="session-tray-section-chevron" aria-hidden="true">
                      {outputsExpanded ? '▾' : '▸'}
                    </span>
                  </button>
                </h2>
              </div>
              {outputsExpanded && (
                <div id={outputsContentId}>
                  {resources.outputs.length > 0 ? (
                    <div className="session-tray-resources">
                      {resources.outputs.map((resource) => (
                        <ResourceRow key={resource.id} resource={resource} />
                      ))}
                    </div>
                  ) : (
                    <p className="session-tray-empty">Generated files and previews will appear here</p>
                  )}
                </div>
              )}
            </section>

            <section className="session-tray-section">
              <div className="session-tray-section-header">
                <h2>
                  <button
                    type="button"
                    className="session-tray-section-toggle"
                    aria-label={`Sources ${sourcesCount}`}
                    aria-expanded={sourcesExpanded}
                    aria-controls={sourcesContentId}
                    onClick={() => setSourcesExpanded((expanded) => !expanded)}
                  >
                    <span>Sources</span>
                    <span className="session-tray-section-count">{sourcesCount}</span>
                    <span className="session-tray-section-chevron" aria-hidden="true">
                      {sourcesExpanded ? '▾' : '▸'}
                    </span>
                  </button>
                </h2>
                <button
                  type="button"
                  className="session-tray-add"
                  aria-label="Add source"
                  disabled={draftImages.length >= MAX_IMAGE_ATTACHMENTS}
                  onClick={onAddImages}
                >
                  +
                </button>
              </div>
              {sourcesExpanded && (
                <div id={sourcesContentId}>
                  <div className="session-tray-resources">
                    {draftImages.map((image, index) => (
                      <div className="session-tray-resource" key={keyForDraftImage(image)}>
                        <img className="session-tray-thumb" src={image.preview} alt="" />
                        <span className="session-tray-resource-label">Pasted image {index + 1}</span>
                        <button
                          type="button"
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
                </div>
              )}
            </section>
          </div>
        </div>
      </aside>
    </>
  );
}
