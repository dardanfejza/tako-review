/** Pure burst-of-creatures physics (no canvas, no DOM) so it is unit-testable, mirroring boids.ts.
 *  A burst spawns creatures on the hero box perimeter swimming outward; each glides, wiggles,
 *  and fades out at end of life. OctopusBackground renders them on its existing canvas. */

/** Window CustomEvent name carrying a BurstRect detail (viewport coordinates). */
export const BURST_EVENT = 'tako:burst';

export interface BurstRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BurstCreature {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  ttl: number;
  phase: number;
  /** Every few creatures carry the brand accent, like the flock's leader. */
  leader: boolean;
}

export const BURST_COUNT = 30;
const SPEED_MIN = 2.0;
const SPEED_MAX = 3.4;
const TTL_MIN = 150;
const TTL_MAX = 280;
const DRAG = 0.995;
const FADE_FRAMES = 50;
const ANGLE_JITTER = 0.7; // radians, total spread around the outward normal

type Rng = () => number;

export function createBurst(rect: BurstRect, count: number, rng: Rng): BurstCreature[] {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const perimeter = 2 * (rect.width + rect.height);
  const out: BurstCreature[] = [];
  for (let i = 0; i < count; i++) {
    // Random point along the rect perimeter, walked edge by edge
    const t = rng() * perimeter;
    let px: number, py: number;
    if (t < rect.width) {
      px = rect.x + t;
      py = rect.y;
    } else if (t < rect.width + rect.height) {
      px = rect.x + rect.width;
      py = rect.y + (t - rect.width);
    } else if (t < 2 * rect.width + rect.height) {
      px = rect.x + (t - rect.width - rect.height);
      py = rect.y + rect.height;
    } else {
      px = rect.x;
      py = rect.y + (t - 2 * rect.width - rect.height);
    }
    // Outward from the box center, jittered less than 90deg so it always points away
    const a = Math.atan2(py - cy, px - cx) + (rng() - 0.5) * ANGLE_JITTER;
    const s = SPEED_MIN + rng() * (SPEED_MAX - SPEED_MIN);
    out.push({
      x: px,
      y: py,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      age: 0,
      ttl: TTL_MIN + rng() * (TTL_MAX - TTL_MIN),
      phase: rng() * Math.PI * 2,
      leader: i % 7 === 0,
    });
  }
  return out;
}

/** Advance one burst creature a frame; returns false once expired. */
export function stepBurstCreature(f: BurstCreature): boolean {
  f.age += 1;
  if (f.age > f.ttl) return false;
  // Gentle heading wiggle (rotate velocity) + drag so the dash settles into a glide
  const wig = Math.sin(f.age * 0.15 + f.phase) * 0.045;
  const cos = Math.cos(wig);
  const sin = Math.sin(wig);
  const vx = f.vx * cos - f.vy * sin;
  const vy = f.vx * sin + f.vy * cos;
  f.vx = vx * DRAG;
  f.vy = vy * DRAG;
  f.x += f.vx;
  f.y += f.vy;
  return true;
}

/** 1 through most of life, ramping to 0 over the final FADE_FRAMES. */
export function burstAlpha(f: BurstCreature): number {
  return Math.max(0, Math.min(1, (f.ttl - f.age) / FADE_FRAMES));
}
