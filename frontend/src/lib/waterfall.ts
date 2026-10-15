export interface WaterfallParticle {
  x: number;
  y: number;
  delay: number;
  fall: number;
  contact: number;
  spread: number;
  hops: number;
  height: number;
  skid: number;
  sway: number;
  direction: number;
}
export function waterfallParticle(x: number, y: number, random = Math.random): WaterfallParticle {
  const r = random(),
    s = random(),
    drift = random(),
    bounce = random();
  return {
    x,
    y,
    delay: (y / 70) * 0.06 + r * 0.05,
    fall: 0.33 + r * 0.06,
    contact: 0.34 + bounce * 0.16,
    spread: r,
    hops: 3 + Math.floor(s * 3),
    height: 19 + bounce * 26,
    skid: 22 + drift * 50,
    sway: 6 + s * 17,
    direction: random() < 0.35 ? (x < 96 ? 1 : -1) : x < 96 ? -1 : 1,
  };
}
/** Normalized time makes the same path reversible without a second simulation. */
export function waterfallFrame(
  tile: WaterfallParticle,
  time: number,
  width: number,
  height: number,
  left = 24,
  right = width - 24,
) {
  const size = 3,
    ox = (width - 192) / 2,
    oy = height * 0.4 - 35;
  const p = (time - tile.delay) / tile.fall;
  const sx = ox + tile.x,
    sy = oy + tile.y;
  const landing = Math.max(
    left,
    Math.min(right - size, width / 2 + (tile.x - 96) * 1.45 + (tile.spread - 0.5) * 28),
  );
  if (p < 0) return { x: sx, y: sy, size, alpha: 1 };
  if (p >= 1) {
    const contact = (time - tile.delay - tile.fall) / tile.contact;
    if (contact >= 1) return { x: landing, y: height - size, size, alpha: 0 };
    const wander =
      Math.sin(contact * Math.PI * (2 + tile.spread * 3)) * tile.sway * Math.sin(contact * Math.PI);
    const x = Math.max(
      left,
      Math.min(right - size, landing + tile.direction * tile.skid * contact + wander),
    );
    const bounce =
      Math.abs(Math.sin(contact * Math.PI * tile.hops)) * Math.pow(1 - contact, 1.25) * tile.height;
    return { x, y: height - size - bounce, size, alpha: 0.72 * Math.pow(1 - contact, 0.65) };
  }
  return {
    x: sx + (landing - sx) * Math.pow(p, 0.75) + Math.sin(p * 5 + tile.spread * 6) * p * 4,
    y: sy + (height - size - sy) * p * p,
    size,
    alpha: 0.85 - 0.3 * p,
  };
}
