import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { waterfallFrame, waterfallParticle, type WaterfallParticle } from '../lib/waterfall';

/** Decorative only: never owns a draft, microphone, or dispatch lifecycle. */
export function ChatWelcome({ active }: { active: boolean }) {
  const root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null),
    tiles = useRef<Array<{ x: number; y: number }>>([]);
  const animation = useRef(0),
    wasActive = useRef(active),
    playing = useRef(false);
  const [visible, setVisible] = useState(active),
    [animating, setAnimating] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    const logo = new Image();
    image.current = logo;
    logo.src = '/mitzo-wordmark.png';
    logo.onload = () => {
      const stamp = document.createElement('canvas');
      stamp.width = 192;
      stamp.height = 70;
      const context = stamp.getContext('2d');
      if (!context) return;
      context.drawImage(logo, 0, 0, 192, 70);
      const data = context.getImageData(0, 0, 192, 70).data;
      const points = [];
      for (let y = 0; y < 70; y += 3)
        for (let x = 0; x < 192; x += 3) {
          let found = false;
          for (let dy = 0; dy < 3 && y + dy < 70 && !found; dy++)
            for (let dx = 0; dx < 3 && x + dx < 192; dx++)
              if (data[((y + dy) * 192 + x + dx) * 4 + 3] > 4) {
                found = true;
                break;
              }
          if (found) points.push({ x, y });
        }
      tiles.current = points;
    };
    return () => {
      logo.onload = null;
      cancelAnimationFrame(animation.current);
    };
  }, []);
  useLayoutEffect(() => {
    const element = root.current,
      chat = element?.closest('.workspace-chat');
    if (!element || !chat) return;
    const measure = () => {
      const area = chat.querySelector('.chat-messages'),
        composer = chat.querySelector('.chat-input-row');
      if (!area || !composer) return;
      const parent = chat.getBoundingClientRect(),
        box = area.getBoundingClientRect(),
        bottom = composer.getBoundingClientRect().top;
      element.style.top = `${box.top - parent.top}px`;
      element.style.left = `${box.left - parent.left}px`;
      element.style.width = `${box.width}px`;
      element.style.height = `${Math.max(0, bottom - box.top)}px`;
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(chat);
    const composer = chat.querySelector('.chat-input');
    if (composer) observer?.observe(composer);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, []);
  const run = useRef<(replay: boolean) => void>(() => {});
  run.current = (replay) => {
    const element = root.current,
      layer = canvas.current,
      logo = image.current;
    if (playing.current || !element || !layer) return;
    if (reduced || !logo?.complete || !tiles.current.length) {
      setVisible(replay);
      return;
    }
    const context = layer.getContext('2d');
    if (!context) {
      setVisible(replay);
      return;
    }
    const styles = getComputedStyle(document.documentElement);
    const timing = (name: string) => {
      const value = styles.getPropertyValue(name).trim();
      return parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
    };
    const fall = timing('--motion-duration-waterfall'),
      pause = timing('--motion-duration-waterfall-pause'),
      rise = timing('--motion-duration-waterfall-return');
    if (![fall, pause, rise].every((value) => Number.isFinite(value) && value > 0)) {
      setVisible(replay);
      return;
    }
    const width = element.clientWidth,
      height = element.clientHeight;
    if (!width || !height) {
      setVisible(replay);
      return;
    }
    const composer = element
      .closest('.workspace-chat')
      ?.querySelector('.chat-input-row')
      ?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const left = composer ? Math.max(0, composer.left - bounds.left) + 16 : 24;
    const right = composer ? Math.min(width, composer.right - bounds.left) - 16 : width - 24;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    layer.width = width * ratio;
    layer.height = height * ratio;
    context.scale(ratio, ratio);
    const stamp = document.createElement('canvas');
    stamp.width = 192;
    stamp.height = 70;
    const source = stamp.getContext('2d');
    if (!source) return;
    source.drawImage(logo, 0, 0, 192, 70);
    source.globalCompositeOperation = 'source-in';
    source.fillStyle = styles.getPropertyValue('--color-accent').trim();
    // Resolve var() through the themed element before drawing into canvas.
    source.fillStyle = getComputedStyle(element).color;
    source.fillRect(0, 0, 192, 70);
    const particles: WaterfallParticle[] = tiles.current.map((tile) =>
      waterfallParticle(tile.x, tile.y),
    );
    const started = performance.now();
    playing.current = true;
    setVisible(true);
    setAnimating(true);
    const draw = (progress: number) => {
      context.clearRect(0, 0, width, height);
      for (const tile of particles) {
        const frame = waterfallFrame(tile, progress, width, height, left, right);
        if (!frame.alpha) continue;
        context.globalAlpha = frame.alpha * 0.65;
        context.drawImage(stamp, tile.x, tile.y, 3, 3, frame.x, frame.y, 3, 3);
      }
      context.globalAlpha = 1;
    };
    const tick = (now: number) => {
      const elapsed = now - started;
      if (elapsed < fall) draw(elapsed / fall);
      else if (replay && elapsed < fall + pause) context.clearRect(0, 0, width, height);
      else if (replay && elapsed < fall + pause + rise) draw(1 - (elapsed - fall - pause) / rise);
      else {
        context.clearRect(0, 0, width, height);
        playing.current = false;
        setAnimating(false);
        setVisible(replay);
        return;
      }
      animation.current = requestAnimationFrame(tick);
    };
    animation.current = requestAnimationFrame(tick);
  };
  useEffect(() => {
    if (active && !wasActive.current) {
      cancelAnimationFrame(animation.current);
      playing.current = false;
      setAnimating(false);
      setVisible(true);
    } else if (!active && wasActive.current) {
      cancelAnimationFrame(animation.current);
      playing.current = false;
      run.current(false);
    }
    wasActive.current = active;
  }, [active]);
  useEffect(() => {
    if (reduced) {
      cancelAnimationFrame(animation.current);
      playing.current = false;
      setAnimating(false);
      setVisible(active);
    }
  }, [reduced, active]);
  const lastTap = useRef(0);
  return (
    <div ref={root} className="chat-welcome" hidden={!visible} aria-hidden={!active || undefined}>
      <canvas ref={canvas} hidden={!animating} aria-hidden="true" />
      <button
        type="button"
        className="chat-welcome-logo"
        hidden={animating}
        aria-label="Replay Mitzo waterfall"
        onDoubleClick={() => run.current(true)}
        onClick={(event) => {
          if (event.detail === 0) run.current(true);
        }}
        onPointerUp={(event) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (lastTap.current && now - lastTap.current < 350) {
            lastTap.current = 0;
            run.current(true);
          } else lastTap.current = now;
        }}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
