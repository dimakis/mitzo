import { useRef, useEffect, useState } from 'react';
import type { TodoItem } from '../types/todo';

interface TodoCardProps {
  item: TodoItem;
  depth?: number;
  onAck: (id: string) => void;
  onDone: (id: string) => void;
  onTap: (item: TodoItem) => void;
  onAddChild: (parentId: string) => void;
}

function urgencyBar(urgency: number): string {
  if (urgency >= 0.8) return '\u2593\u2593\u2593';
  if (urgency >= 0.5) return '\u2593\u2593\u2591';
  if (urgency >= 0.2) return '\u2593\u2591\u2591';
  return '\u2591\u2591\u2591';
}

function sourceIcon(type: string): string {
  switch (type) {
    case 'github':
      return 'GH';
    case 'jira':
      return 'JR';
    case 'gmail':
      return 'GM';
    case 'gdocs':
      return 'GD';
    default:
      return type.slice(0, 2).toUpperCase();
  }
}

export function TodoCard({ item, depth = 0, onAck, onDone, onTap, onAddChild }: TodoCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const tapped = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  function handleTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0].clientX;
    currentX.current = startX.current;
    swiping.current = true;
    tapped.current = true;
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;

    if (Math.abs(dx) > 10) tapped.current = false;

    ref.current.style.transform = `translateX(${dx}px)`;
    ref.current.style.opacity = `${Math.max(0, 1 - Math.abs(dx) / 200)}`;
  }

  function handleTouchEnd() {
    if (!swiping.current || !ref.current) return;
    swiping.current = false;
    const dx = currentX.current - startX.current;

    if (tapped.current) {
      onTap(item);
      return;
    }

    if (dx > 100) {
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(100%)';
      ref.current.style.opacity = '0';
      timers.current.push(setTimeout(() => onAck(item.id), 200));
    } else if (dx < -100) {
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(-100%)';
      ref.current.style.opacity = '0';
      timers.current.push(setTimeout(() => onDone(item.id), 200));
    } else {
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(0)';
      ref.current.style.opacity = '1';
      timers.current.push(
        setTimeout(() => {
          if (ref.current) ref.current.style.transition = '';
        }, 200),
      );
    }
  }

  const source = item.sources[0];
  const ageLabel = item.ageDays === 0 ? 'new' : `${item.ageDays}d`;
  const statusIcon = item.status === 'active' ? '\u25CF' : '\u25D0';
  const children = item.children ?? [];
  const hasChildren = children.length > 0;

  return (
    <div className={`todo-card-tree-node ${depth > 0 ? 'todo-card-tree-node--child' : ''}`}>
      <div className="todo-card-wrapper">
        <div className="todo-card-actions-bg">
          <span className="todo-action-label todo-action-ack">Seen</span>
          <span className="todo-action-label todo-action-done">Done</span>
        </div>
        <div
          ref={ref}
          className="todo-card"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="todo-card-header">
            {hasChildren && (
              <button
                className="todo-card-expand"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
              >
                {expanded ? '\u25BC' : '\u25B6'}
              </button>
            )}
            <span className="todo-card-status">{statusIcon}</span>
            <span className="todo-card-urgency">{urgencyBar(item.urgency)}</span>
            {source ? (
              <span className="todo-card-source">{sourceIcon(source.type)}</span>
            ) : (
              <span className="todo-card-source todo-card-source--manual">+</span>
            )}
            <span className="todo-card-age">{ageLabel}</span>
            {hasChildren && (
              <span className="todo-card-progress">
                {item.completedChildCount ?? 0}/{item.childCount ?? children.length}
              </span>
            )}
          </div>
          <div className="todo-card-summary">{item.summary}</div>
          {source && (
            <div className="todo-card-meta">
              <span className="todo-card-author">{source.author}</span>
            </div>
          )}
          <button
            className="todo-card-add-child"
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(item.id);
            }}
          >
            + sub-task
          </button>
        </div>
      </div>

      {hasChildren && expanded && (
        <div className="todo-card-children">
          {children.map((child) => (
            <TodoCard
              key={child.id}
              item={child}
              depth={depth + 1}
              onAck={onAck}
              onDone={onDone}
              onTap={onTap}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
  );
}
