import { useRef, useEffect, useState } from 'react';
import type { TodoItem } from '../types/todo';
import { sourceIcon } from '../lib/todo-utils';
import { notifySuccess, impactLight } from '../lib/haptics';

interface TodoCardProps {
  item: TodoItem;
  depth?: number;
  onAck: (id: string) => void;
  onDone: (id: string) => void;
  onTap: (item: TodoItem) => void;
  onAddChild: (parentId: string) => void;
  onStar: (id: string) => void;
  onStartSession: (item: TodoItem) => void;
}

// ─── Urgency → color border ────────────────────────────────────────────────

function urgencyColor(urgency: number): string {
  if (urgency >= 0.8) return '#ff6d6d';
  if (urgency >= 0.5) return '#fbbf24';
  if (urgency >= 0.2) return '#b48cff';
  return 'transparent';
}

function urgencyWidth(urgency: number): number {
  if (urgency >= 0.8) return 4;
  if (urgency >= 0.5) return 3;
  if (urgency >= 0.2) return 2;
  return 0;
}

// ─── Status visuals ────────────────────────────────────────────────────────

function getStatusIcon(item: TodoItem): string {
  if (item.starred) return '\u2605'; // ★
  if (item.status === 'active') return '\u25CF'; // ●
  if (item.status === 'acknowledged') return '\u25D0'; // ◐
  if (item.status === 'completed') return '\u2713'; // ✓
  return '\u25CB'; // ○ (snoozed)
}

function getStatusColor(item: TodoItem): string {
  if (item.starred) return '#fbbf24';
  if (item.status === 'active') return '#b48cff';
  if (item.status === 'acknowledged') return '#60a5fa';
  if (item.status === 'completed') return '#4ade80';
  return '#888';
}

export function TodoCard({
  item,
  depth = 0,
  onAck,
  onDone,
  onTap,
  onAddChild,
  onStar,
  onStartSession,
}: TodoCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
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
    startY.current = e.touches[0].clientY;
    currentX.current = startX.current;
    swiping.current = true;
    tapped.current = true;
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;

    const dy = e.touches[0].clientY - startY.current;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) tapped.current = false;

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
      impactLight();
      timers.current.push(setTimeout(() => onAck(item.id), 200));
    } else if (dx < -100) {
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(-100%)';
      ref.current.style.opacity = '0';
      notifySuccess();
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
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const icon = getStatusIcon(item);
  const color = getStatusColor(item);
  const borderClr = urgencyColor(item.urgency);
  const borderW = urgencyWidth(item.urgency);

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
          style={{
            borderLeftColor: borderClr,
            borderLeftWidth: borderW > 0 ? `${borderW}px` : undefined,
            borderLeftStyle: borderW > 0 ? 'solid' : undefined,
          }}
        >
          {/* Line 1: icon + summary + star */}
          <div className="todo-card-line1">
            <span className="todo-card-icon" style={{ color }}>
              {icon}
            </span>
            <span className="todo-card-summary">{item.summary}</span>
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
            <button
              className="todo-card-star"
              onClick={(e) => {
                e.stopPropagation();
                onStar(item.id);
              }}
            >
              {item.starred ? '\u2B50' : '\u2606'}
            </button>
          </div>

          {/* Line 2: source + meta */}
          <div className="todo-card-line2">
            {source ? (
              <span className="todo-card-source">{sourceIcon(source.type)}</span>
            ) : (
              <span className="todo-card-source todo-card-source--manual">+</span>
            )}
            {source?.author && (
              <>
                <span className="todo-card-author">{source.author}</span>
                {' \u00B7 '}
              </>
            )}
            <span className="todo-card-age">{ageLabel}</span>
            {' \u00B7 '}
            <span className="todo-card-profile">{item.profile}</span>
            {hasChildren && (
              <>
                {' \u00B7 '}
                <span className="todo-card-progress">
                  {item.completedChildCount ?? 0}/{item.childCount ?? children.length}
                </span>
              </>
            )}
          </div>

          {/* Line 3: actions */}
          <div className="todo-card-line3">
            <button
              className="todo-card-add-child"
              onClick={(e) => {
                e.stopPropagation();
                onAddChild(item.id);
              }}
            >
              + sub-task
            </button>
            <button
              className="todo-card-session-btn"
              onClick={(e) => {
                e.stopPropagation();
                onStartSession(item);
              }}
            >
              Start Session
            </button>
          </div>
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
              onStar={onStar}
              onStartSession={onStartSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}
