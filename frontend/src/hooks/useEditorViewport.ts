import { useEffect, useRef } from 'react';

/** iOS Safari's keyboard shrinks the visual viewport while layout height can stay unchanged. */
export function useEditorViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const container = ref.current?.closest<HTMLElement>('.mobile-workspace-body');
    const resize = () => {
      const element = ref.current;
      if (!element) return;
      if (container) {
        // The mobile shell owns the masthead and tabs. Fit only the part of
        // its body still visible after the keyboard resizes or pans the view.
        const bounds = container.getBoundingClientRect();
        const top = Math.max(bounds.top, viewport.offsetTop);
        const bottom = Math.min(bounds.bottom, viewport.offsetTop + viewport.height);
        element.style.height = `${Math.max(0, bottom - top)}px`;
        element.style.top = `${top - bounds.top}px`;
      } else {
        element.style.height = `${viewport.height}px`;
        element.style.top = `${viewport.offsetTop}px`;
      }
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    const observer =
      container && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (container) observer?.observe(container);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
      observer?.disconnect();
    };
  }, []);
  return ref;
}
