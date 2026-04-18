import { useState, useEffect } from 'react';
import type { ContextBlockEntry } from './ContextPicker';
import { apiFetch } from '../lib/api-fetch';

export interface ContextPanelProps {
  selected: string[];
  onToggle: (name: string) => void;
  blocks?: ContextBlockEntry[];
  loaded?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function ContextPanel({
  selected,
  onToggle,
  blocks: externalBlocks,
  loaded: externalLoaded,
}: ContextPanelProps) {
  const [selfBlocks, setSelfBlocks] = useState<ContextBlockEntry[]>([]);
  const [selfLoaded, setSelfLoaded] = useState(false);

  // Self-fetch config only when not provided via props (standalone usage)
  useEffect(() => {
    if (externalBlocks !== undefined) return;
    apiFetch('/api/config')
      .then((r) => r.json())
      .then((data: { contextBlocks?: Record<string, { path: string; sizeBytes: number }> }) => {
        const entries: ContextBlockEntry[] = [];
        if (data.contextBlocks) {
          for (const [name, info] of Object.entries(data.contextBlocks)) {
            entries.push({ name, path: info.path, sizeBytes: info.sizeBytes });
          }
        }
        setSelfBlocks(entries);
        setSelfLoaded(true);
      })
      .catch(() => setSelfLoaded(true));
  }, [externalBlocks]);

  const blocks = externalBlocks ?? selfBlocks;
  const loaded = externalLoaded ?? selfLoaded;

  if (!loaded) return null;

  return (
    <div className="context-panel">
      <div className="context-panel-header">Context</div>
      {blocks.length === 0 ? (
        <p className="context-panel-empty">No context blocks</p>
      ) : (
        <div className="context-panel-list">
          {blocks.map((block) => {
            const isSelected = selected.includes(block.name);
            return (
              <button
                key={block.name}
                className={`context-panel-item${isSelected ? ' context-panel-item--selected' : ''}`}
                onClick={() => onToggle(block.name)}
              >
                <span className="context-panel-check">{isSelected ? '✓' : ''}</span>
                <span className="context-panel-name">{block.name}</span>
                <span className="context-panel-size">{formatSize(block.sizeBytes)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
