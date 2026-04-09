import { useState, useEffect } from 'react';
import type { ContextBlockEntry } from './ContextPicker';

export interface ContextPanelProps {
  selected: string[];
  onToggle: (name: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function ContextPanel({ selected, onToggle }: ContextPanelProps) {
  const [blocks, setBlocks] = useState<ContextBlockEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/config', { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { contextBlocks?: Record<string, { path: string; sizeBytes: number }> }) => {
        const entries: ContextBlockEntry[] = [];
        if (data.contextBlocks) {
          for (const [name, info] of Object.entries(data.contextBlocks)) {
            entries.push({ name, path: info.path, sizeBytes: info.sizeBytes });
          }
        }
        setBlocks(entries);
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
      });
  }, []);

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
