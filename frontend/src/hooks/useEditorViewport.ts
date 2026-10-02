import { useEffect, useRef } from 'react';

/** iOS Safari's keyboard shrinks the visual viewport while layout height can stay unchanged. */
export function useEditorViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      if (!ref.current) return;
      ref.current.style.height = `${viewport.height}px`;
      ref.current.style.top = `${viewport.offsetTop}px`;
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
    };
  }, []);
  return ref;
}
