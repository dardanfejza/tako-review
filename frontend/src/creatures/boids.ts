/** Pure Reynolds boids flocking (no canvas, no DOM) so it is unit-testable. */
export const CREATURE_COUNT = 15;
export const BOIDS = {
  maxspeed: 1.1,
  maxforce: 0.02,
  sepR: 20, alignR: 40, cohR: 50,
  sepW: 1.5, alignW: 1.0, cohW: 1.0,
  noiseW: 0.012,
  wrap: 3,
} as const;

export interface Creature { x: number; y: number; vx: number; vy: number; leader: boolean; na: number; }

type Rng = () => number;

export function createCreatures(w: number, h: number, rng: Rng): Creature[] {
  const creatures: Creature[] = [];
  for (let i = 0; i < CREATURE_COUNT; i++) {
    let x: number, y: number;
    if (i < 7) { x = w / 2 + (rng() - 0.5) * 120; y = h / 2 + (rng() - 0.5) * 120; }
    else { x = rng() * w; y = rng() * h; }
    const a = rng() * Math.PI * 2;
    creatures.push({ x, y, vx: Math.cos(a) * BOIDS.maxspeed, vy: Math.sin(a) * BOIDS.maxspeed, leader: i === CREATURE_COUNT - 1, na: a });
  }
  return creatures;
}

function limit(vx: number, vy: number, m: number): [number, number] {
  const s = Math.hypot(vx, vy);
  return s > m && s > 0 ? [vx / s * m, vy / s * m] : [vx, vy];
}

/** Advance one creature by one frame. `t` drives the leader's smooth noise wander. */
export function stepCreature(f: Creature, _i: number, all: Creature[], w: number, h: number, t: number): void {
  if (f.leader) {
    f.na += (Math.sin(t * 0.7) + Math.sin(t * 1.7 + 1.3) + Math.sin(t * 0.31 + 4)) * BOIDS.noiseW;
    f.vx = Math.cos(f.na) * BOIDS.maxspeed;
    f.vy = Math.sin(f.na) * BOIDS.maxspeed;
  } else {
    let sx = 0, sy = 0, ax = 0, ay = 0, cx = 0, cy = 0, ns = 0, na = 0, nc = 0;
    for (const o of all) {
      if (o === f) continue;
      const dx = f.x - o.x, dy = f.y - o.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < BOIDS.sepR) { sx += dx / d; sy += dy / d; ns++; }
      if (d < BOIDS.alignR) { ax += o.vx; ay += o.vy; na++; }
      if (d < BOIDS.cohR) { cx += o.x; cy += o.y; nc++; }
    }
    let fx = 0, fy = 0;
    if (ns) { const [a, b] = limit(sx / ns, sy / ns, BOIDS.maxspeed); fx += (a - f.vx) * BOIDS.sepW; fy += (b - f.vy) * BOIDS.sepW; }
    if (na) { const [a, b] = limit(ax / na, ay / na, BOIDS.maxspeed); fx += (a - f.vx) * BOIDS.alignW; fy += (b - f.vy) * BOIDS.alignW; }
    if (nc) { const [a, b] = limit(cx / nc - f.x, cy / nc - f.y, BOIDS.maxspeed); fx += (a - f.vx) * BOIDS.cohW; fy += (b - f.vy) * BOIDS.cohW; }
    [fx, fy] = limit(fx, fy, BOIDS.maxforce);
    f.vx += fx; f.vy += fy;
    [f.vx, f.vy] = limit(f.vx, f.vy, BOIDS.maxspeed);
  }
  f.x += f.vx; f.y += f.vy;
  const k = BOIDS.wrap;
  if (f.x < -k) f.x = w + k; if (f.y < -k) f.y = h + k;
  if (f.x > w + k) f.x = -k; if (f.y > h + k) f.y = -k;
}
