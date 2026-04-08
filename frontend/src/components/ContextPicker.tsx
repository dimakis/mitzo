import { useState, useEffect, useRef } from 'react';

export interface ContextBlockEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

interface Props {
  /** Currently selected context block names */
  selected: string[];
  /** Called when a block is toggled on/off */
  onToggle: (name: string) => void;
  /** Called when the picker should close */
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${parseFloat(kb.toFixed(1))} KB`;
  return `${parseFloat((kb / 1024).toFixed(1))} MB`;
}

export function ContextPicker({ selected, onToggle, onClose }: Props) {
  const [blocks, setBlocks] = useState<ContextBlockEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Fetch available context blocks from /api/config
  useEffect(() => {
    fetch('/api/config', { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { contextBlocks?: Record<string, { path: string; sizeBytes: number }> }) => {
        const entries: ContextBlockEntry[] = [];
        if (data.contextBlocks && typeof data.contextBlocks === 'object') {
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

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (!loaded) return null;

  if (blocks.length === 0) {
    return (
      <div className="context-picker" ref={pickerRef}>
        <div className="context-picker-empty">No context blocks configured</div>
      </div>
    );
  }

  return (
    <div className="context-picker" ref={pickerRef}>
      <div className="context-picker-list">
        {blocks.map((block) => {
          const isSelected = selected.includes(block.name);
          return (
            <button
              key={block.name}
              className={`context-picker-item${isSelected ? ' context-picker-item--selected' : ''}`}
              onClick={() => onToggle(block.name)}
            >
              <span className="context-picker-check">{isSelected ? '✓' : ''}</span>
              <span className="context-picker-name">{block.name}</span>
              <span className="context-picker-size">{formatSize(block.sizeBytes)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
