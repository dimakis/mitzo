export interface LiquidPoint {
  x: number;
  y: number;
  seed: number;
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Sampled logo points share one fall, spread on contact, then gather into their glyph. */
export function liquidFrame(point: LiquidPoint, time: number, width: number, height: number) {
  const scale = Math.min(1, width / 320);
  const center = width / 2;
  const floor = height * 0.9;
  const targetX = center + (point.x - 0.5) * 256 * scale;
  const targetY = height * 0.42 + (point.y - 0.5) * 94 * scale;
  if (time >= 1) return { x: targetX, y: targetY, radius: 2.2 * scale };
  if (time < 0.3) {
    const p = time / 0.3;
    return {
      x: center - 28 * scale + (point.x - 0.5) * 16 * scale + Math.sin(p * Math.PI) * 12,
      y: mix(-70, floor, p * p) + (point.y - 0.5) * 24 * scale,
      radius: 5 * scale,
    };
  }
  const spread = center + (point.x - 0.5) * 180 * scale;
  if (time < 0.4) {
    const p = (time - 0.3) / 0.1;
    return {
      x: mix(
        center - 28 * scale + (point.x - 0.5) * 16 * scale,
        spread,
        Math.sin((p * Math.PI) / 2),
      ),
      y: floor - Math.sin(p * Math.PI) * point.seed * 22,
      radius: (5 + Math.sin(p * Math.PI) * 2) * scale,
    };
  }
  const p = (time - 0.4) / 0.6;
  const rise = 1 - Math.pow(1 - p, 3);
  const gather = p * p * (3 - 2 * p);
  return {
    x: mix(spread, targetX, gather) + Math.sin(p * Math.PI * 2) * (1 - p) * (point.seed - 0.5) * 30,
    y: mix(floor, targetY, rise) - Math.sin(p * Math.PI) * (1 - p) * 65,
    radius: mix(6, 2.2, gather) * scale,
  };
}
