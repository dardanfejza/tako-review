import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { OctopusBackground } from './OctopusBackground';

function setMatchMedia(reduced: boolean, dark = false) {
  window.matchMedia = ((q: string) => ({
    matches: (reduced && q.includes('reduced-motion')) || (dark && q.includes('dark')),
    media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const ctxStub = {
  setTransform() {}, clearRect() {}, save() {}, restore() {},
  translate() {}, rotate() {}, scale() {}, fill() {}, fillStyle: '',
};

beforeEach(() => {
  vi.stubGlobal('Path2D', class { constructor(_d?: string) {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctxStub as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OctopusBackground', () => {
  it('renders an aria-hidden canvas', () => {
    setMatchMedia(false);
    const { container } = render(<OctopusBackground />);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('aria-hidden')).toBe('true');
  });

  it('schedules an animation frame when motion is allowed', () => {
    setMatchMedia(false);
    render(<OctopusBackground />);
    expect(requestAnimationFrame).toHaveBeenCalled();
  });

  it('renders a single static frame (no RAF) under prefers-reduced-motion', () => {
    setMatchMedia(true);
    render(<OctopusBackground />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('applies the dimmed class when dimmed', () => {
    setMatchMedia(false);
    const { container } = render(<OctopusBackground dimmed />);
    expect(container.querySelector('canvas')!.className).toMatch(/dimmed/);
  });
});
