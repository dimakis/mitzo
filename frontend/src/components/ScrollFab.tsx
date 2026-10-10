import { UiIcon } from './UiIcon';
import { useCallback, useEffect, useState } from 'react';

const THRESHOLD = 200; // px from edge to show button

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export function ScrollFab({ scrollRef }: Props) {
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function update() {
      const { scrollTop, scrollHeight, clientHeight } = el!;
      const canScroll = scrollHeight > clientHeight;
      setShowTop(canScroll && scrollTop > THRESHOLD);
      setShowBottom(canScroll && scrollHeight - scrollTop - clientHeight > THRESHOLD);
    }

    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => el.removeEventListener('scroll', update);
  }, [scrollRef]);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [scrollRef]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [scrollRef]);

  if (!showTop && !showBottom) return null;

  return (
    <div className="scroll-fab-container">
      {showTop && (
        <button
          className="scroll-fab scroll-fab--up"
          onClick={scrollToTop}
          aria-label="Scroll to top"
        >
          <UiIcon name="send" />
        </button>
      )}
      {showBottom && (
        <button
          className="scroll-fab scroll-fab--down"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
        >
          <UiIcon name="arrowDown" />
        </button>
      )}
    </div>
  );
}
