import { useEffect, useRef } from 'react';
import { createCreatures, stepCreature, type Creature } from '../../creatures/boids';
import {
  BURST_EVENT,
  BURST_COUNT,
  createBurst,
  stepBurstCreature,
  burstAlpha,
  type BurstCreature,
  type BurstRect,
} from '../../creatures/burst';
import { OCTOPUS_PATH_D, OCTOPUS_PATH_CENTER } from '../../creatures/octopusPath';
import styles from './OctopusBackground.module.css';

/** Safety cap so spamming Run Review can't pile up unbounded burst creatures. */
const MAX_BURST_CREATURES = 90;

const SCALE = 0.14;
const BRAND = '#0D9488';

/** Full-viewport canvas of drifting octopus silhouettes (boids). Behind all content,
 *  non-interactive. Honors prefers-reduced-motion (single static frame, no RAF) and pauses
 *  when the tab is hidden. `dimmed` fades the layer to 30% (set true while the dense workspace
 *  is active). `calm` drops to a low-power mode (repaint every 4th frame at 1x DPR — ~6% of
 *  the raster cost) so the canvas doesn't compete with WebGPU inference for the GPU; the
 *  creatures keep drifting, just slower (set true while the model is generating or downloading). */
export function OctopusBackground({ dimmed = false, calm = false }: { dimmed?: boolean; calm?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const calmRef = useRef(calm);

  useEffect(() => {
    calmRef.current = calm;
  }, [calm]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return; // jsdom: no 2d context — nothing to animate

    const path = new Path2D(OCTOPUS_PATH_D);
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const follower = dark ? 'rgba(180,180,180,0.5)' : 'rgba(168,168,168,0.78)';
    let w = 0, h = 0, dpr = 1, creatures: Creature[] = [], bursts: BurstCreature[] = [];

    function resize() {
      // Calm mode renders at 1x — quarter the pixels of 2x retina; creatures are small dim
      // shapes behind the UI, so the softness is imperceptible
      dpr = calmRef.current ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas!.width = w * dpr; canvas!.height = h * dpr;
      canvas!.style.width = w + 'px'; canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function drawOne(x: number, y: number, vx: number, vy: number, leader: boolean, alpha: number) {
      ctx!.save();
      ctx!.globalAlpha = alpha;
      ctx!.translate(x, y);
      ctx!.rotate(Math.atan2(vy, vx));
      ctx!.scale(SCALE, SCALE);
      ctx!.translate(-OCTOPUS_PATH_CENTER.x, -OCTOPUS_PATH_CENTER.y);
      ctx!.fillStyle = leader ? BRAND : follower;
      ctx!.fill(path, 'evenodd');
      ctx!.restore();
    }
    function draw() {
      ctx!.clearRect(0, 0, w, h);
      for (const f of creatures) drawOne(f.x, f.y, f.vx, f.vy, f.leader, 1);
      for (const b of bursts) drawOne(b.x, b.y, b.vx, b.vy, b.leader, burstAlpha(b));
    }

    resize();
    creatures = createCreatures(w, h, Math.random);
    window.addEventListener('resize', resize);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      draw(); // one static frame
      return () => window.removeEventListener('resize', resize);
    }

    // Run Review bursts a school outward from the hero box (event detail = its rect)
    function onBurst(e: Event) {
      const d = (e as CustomEvent<BurstRect>).detail;
      if (!d) return;
      bursts = bursts.concat(createBurst(d, BURST_COUNT, Math.random)).slice(-MAX_BURST_CREATURES);
    }
    window.addEventListener(BURST_EVENT, onBurst);

    // Calm mode steps+paints every CALM_EVERY-th RAF tick: creatures drift in slow motion at
    // ~15fps while the model owns the GPU, instead of a full-rate 60fps repaint.
    const CALM_EVERY = 4;
    let raf = 0, t = 0, running = true, tick = 0, wasCalm = false;
    function frame() {
      if (!running) return;
      const calm = calmRef.current;
      if (calm !== wasCalm) {
        wasCalm = calm;
        resize(); // swap DPR for the new mode (this clears the canvas)
        draw();
      }
      tick++;
      if (!calm || tick % CALM_EVERY === 0) {
        t += 0.016;
        for (let i = 0; i < creatures.length; i++) stepCreature(creatures[i]!, i, creatures, w, h, t);
        // Step bursts; drop expired or far-off-screen creatures
        bursts = bursts.filter(
          (b) => stepBurstCreature(b) && b.x > -40 && b.x < w + 40 && b.y > -40 && b.y < h + 40,
        );
        draw();
      }
      raf = window.requestAnimationFrame(frame);
    }
    function onVisibility() {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; raf = window.requestAnimationFrame(frame); }
    }
    document.addEventListener('visibilitychange', onVisibility);
    raf = window.requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener(BURST_EVENT, onBurst);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className={`${styles.octopus} ${dimmed ? styles.dimmed : ''}`} />;
}
