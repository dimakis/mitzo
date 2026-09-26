import { useRef, type ReactNode, type TouchEvent } from 'react';

export type SymposiumPerspective = 'all' | string;

export function SymposiumPerspectiveTabs({
  seats,
  selected,
  onSelect,
  children,
}: {
  seats: { id: string; name: string }[];
  selected: SymposiumPerspective;
  onSelect: (next: SymposiumPerspective) => void;
  children?: ReactNode;
}) {
  const options = [{ id: 'all', name: 'All' }, ...seats];
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selected),
  );
  function chooseOffset(offset: number) {
    const next = options[selectedIndex + offset];
    if (next) onSelect(next.id);
  }
  function onStart(event: TouchEvent<HTMLDivElement>) {
    gesture.current = null;
    const touch = event.touches[0];
    if (!touch || touch.clientX <= 24 || touch.clientX >= window.innerWidth - 24) return;
    if (window.getSelection()?.toString()) return;
    const target = event.target as HTMLElement;
    if (
      target.closest('input, textarea, select, button, a, [contenteditable], [data-no-seat-swipe]')
    )
      return;
    for (
      let node: HTMLElement | null = target;
      node && node !== event.currentTarget;
      node = node.parentElement
    ) {
      const style = window.getComputedStyle(node);
      if (node.scrollWidth > node.clientWidth && ['auto', 'scroll'].includes(style.overflowX))
        return;
    }
    gesture.current = { x: touch.clientX, y: touch.clientY };
  }
  function onEnd(event: TouchEvent<HTMLDivElement>) {
    const start = gesture.current;
    gesture.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    chooseOffset(dx < 0 ? 1 : -1);
  }
  return (
    <div className="symposium-perspectives" onTouchStart={onStart} onTouchEnd={onEnd}>
      <div
        role="tablist"
        aria-label="Symposium conversations"
        className="symposium-perspective-tabs"
      >
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            id={`symposium-tab-${option.id}`}
            aria-selected={selected === option.id}
            aria-controls="symposium-perspective-panel"
            tabIndex={selected === option.id ? 0 : -1}
            onClick={() => onSelect(option.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                onSelect(options[Math.min(options.length - 1, index + 1)].id);
              }
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                onSelect(options[Math.max(0, index - 1)].id);
              }
              if (event.key === 'Home') {
                event.preventDefault();
                onSelect(options[0].id);
              }
              if (event.key === 'End') {
                event.preventDefault();
                onSelect(options[options.length - 1].id);
              }
            }}
          >
            {option.name}
          </button>
        ))}
      </div>
      <div
        id="symposium-perspective-panel"
        role="tabpanel"
        aria-labelledby={`symposium-tab-${selected}`}
      >
        {children}
      </div>
    </div>
  );
}
