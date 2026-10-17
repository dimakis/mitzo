import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { liquidFrame, type LiquidPoint } from '../lib/liquid-logo';
import { motionDuration } from '../lib/motion';

export function LiquidLogo() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [formed, setFormed] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const layer = canvas.current;
    const context = layer?.getContext('2d');
    if (!layer || !context) {
      setFormed(true);
      return;
    }
    let frame = 0,
      cancelled = false;
    const logo = new Image();
    logo.onload = () => {
      if (cancelled) return;
      const stamp = document.createElement('canvas');
      stamp.width = 256;
      stamp.height = 94;
      const source = stamp.getContext('2d');
      if (!source) return;
      source.drawImage(logo, 0, 0, 256, 94);
      const data = source.getImageData(0, 0, 256, 94).data;
      const points: LiquidPoint[] = [];
      for (let y = 0; y < 94; y += 4)
        for (let x = 0; x < 256; x += 4) {
          if (data[(y * 256 + x) * 4 + 3] > 32)
            points.push({ x: x / 256, y: y / 94, seed: Math.random() });
        }
      const width = layer.clientWidth,
        height = layer.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      layer.width = width * ratio;
      layer.height = height * ratio;
      context.scale(ratio, ratio);
      const color = getComputedStyle(layer).color;
      const duration = motionDuration('liquid');
      if (!duration || !points.length) {
        setFormed(true);
        return;
      }
      const started = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        context.clearRect(0, 0, width, height);
        context.fillStyle = color;
        context.beginPath();
        for (const point of points) {
          const p = liquidFrame(point, progress, width, height);
          context.moveTo(p.x + p.radius, p.y);
          context.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        }
        context.fill();
        if (progress < 1) frame = requestAnimationFrame(tick);
        else setFormed(true);
      };
      frame = requestAnimationFrame(tick);
    };
    logo.onerror = () => {
      if (!cancelled) setFormed(true);
    };
    logo.src = '/mitzo-wordmark.png';
    const settle = () => {
      cancelAnimationFrame(frame);
      setFormed(true);
    };
    window.addEventListener('resize', settle);
    const visibility = () => {
      if (document.hidden) settle();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelled = true;
      logo.onload = null;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', settle);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [reduced]);
  return (
    <div className="startup-liquid" aria-hidden="true">
      <canvas ref={canvas} hidden={formed || reduced} />
      <span className="startup-wordmark" hidden={!formed && !reduced} />
    </div>
  );
}
