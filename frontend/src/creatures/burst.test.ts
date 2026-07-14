import { createBurst, stepBurstCreature, burstAlpha, BURST_COUNT } from './burst';

const rect = { x: 100, y: 100, width: 200, height: 100 };

/** Deterministic LCG so assertions are stable across runs. */
function makeRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('createBurst', () => {
  it('creates the requested number of creatures', () => {
    expect(createBurst(rect, BURST_COUNT, makeRng())).toHaveLength(BURST_COUNT);
    expect(createBurst(rect, 5, makeRng())).toHaveLength(5);
  });

  it('spawns every creature on the rect perimeter', () => {
    const eps = 1e-6;
    for (const f of createBurst(rect, 50, makeRng())) {
      const onX = Math.abs(f.x - 100) < eps || Math.abs(f.x - 300) < eps;
      const onY = Math.abs(f.y - 100) < eps || Math.abs(f.y - 200) < eps;
      expect(f.x).toBeGreaterThanOrEqual(100 - eps);
      expect(f.x).toBeLessThanOrEqual(300 + eps);
      expect(f.y).toBeGreaterThanOrEqual(100 - eps);
      expect(f.y).toBeLessThanOrEqual(200 + eps);
      expect(onX || onY).toBe(true);
    }
  });

  it('points every velocity outward from the box center', () => {
    const cx = 200, cy = 150;
    for (const f of createBurst(rect, 50, makeRng())) {
      const dot = (f.x - cx) * f.vx + (f.y - cy) * f.vy;
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('stepBurstCreature', () => {
  it('advances the position each frame', () => {
    const [f] = createBurst(rect, 1, makeRng());
    const { x, y } = f!;
    expect(stepBurstCreature(f!)).toBe(true);
    expect(Math.hypot(f!.x - x, f!.y - y)).toBeGreaterThan(0);
  });

  it('expires once age exceeds ttl', () => {
    const [f] = createBurst(rect, 1, makeRng());
    let frames = 0;
    while (stepBurstCreature(f!) && frames < 10_000) frames++;
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(Math.ceil(f!.ttl));
  });
});

describe('burstAlpha', () => {
  it('is fully opaque at spawn and fades to zero at end of life', () => {
    const [f] = createBurst(rect, 1, makeRng());
    expect(burstAlpha(f!)).toBe(1);
    f!.age = f!.ttl;
    expect(burstAlpha(f!)).toBe(0);
  });
});
