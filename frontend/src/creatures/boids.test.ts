import { describe, it, expect } from 'vitest';
import { createCreatures, stepCreature, CREATURE_COUNT, BOIDS } from './boids';

describe('boids', () => {
  it('creates CREATURE_COUNT creatures, first 7 seeded near center', () => {
    const creatures = createCreatures(1000, 600, () => 0.5);
    expect(creatures).toHaveLength(CREATURE_COUNT);
    expect(creatures[0]!.x).toBeCloseTo(500, 5);
    expect(creatures[0]!.y).toBeCloseTo(300, 5);
  });

  it('marks the last creature as the leader', () => {
    const creatures = createCreatures(800, 600, () => 0.5);
    expect(creatures[CREATURE_COUNT - 1]!.leader).toBe(true);
    expect(creatures[0]!.leader).toBe(false);
  });

  it('wraps position toroidally past the edges', () => {
    const creatures = createCreatures(100, 100, () => 0.5);
    const f = creatures[0]!;
    f.x = 100 + 5; f.y = -5; f.vx = 0; f.vy = 0;
    stepCreature(f, 0, creatures, 100, 100, 0);
    expect(f.x).toBeCloseTo(BOIDS.wrap * -1, 1);
    expect(f.x).toBeLessThan(0);
    expect(f.y).toBeGreaterThan(100);
  });

  it('separation pushes two crowded followers apart over a step', () => {
    const creatures = createCreatures(400, 400, () => 0.5);
    const a = creatures[0]!, b = creatures[1]!;
    a.x = 200; a.y = 200; a.vx = 0; a.vy = 0;
    b.x = 205; b.y = 200; b.vx = 0; b.vy = 0;
    const before = Math.abs(a.x - b.x);
    stepCreature(a, 0, creatures, 400, 400, 0);
    expect(a.vx).toBeLessThan(0);
    expect(before).toBe(5);
  });
});
