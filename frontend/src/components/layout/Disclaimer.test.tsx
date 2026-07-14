import { afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '../../i18n';
import { Disclaimer } from './Disclaimer';

/** useMediaQuery reads window.matchMedia; flip the prefers-reduced-motion answer. */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Disclaimer (license + notices — FE §11/§15)', () => {
  it('surfaces the license (Qwen2.5-Coder, MLC packaging), the AI-accuracy warning and the data disclosure', () => {
    render(<Disclaimer />);
    expect(screen.getByText(/Qwen2\.5-Coder/)).toBeInTheDocument();
    expect(screen.getByText(/MLC/)).toBeInTheDocument();
    expect(screen.getByText(/AI-generated/i)).toBeInTheDocument();
    expect(screen.getByText(/usage metrics are sent/i)).toBeInTheDocument();
  });

  it('no longer hosts the telemetry opt-out checkbox (it moved to the sidebar SettingsMenu)', () => {
    render(<Disclaimer />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('Disclaimer (dismissal — animates off-screen after the first submit)', () => {
  it('stays visible and interactive while dismissed=false', () => {
    const { container } = render(<Disclaimer dismissed={false} />);
    const card = container.querySelector('footer')!;
    expect(card).not.toHaveAttribute('aria-hidden');
    expect(card.className).not.toMatch(/dismissed/);
  });

  it('dismissed: applies the exit class + aria-hidden, then unmounts on transitionend', () => {
    const { container, rerender } = render(<Disclaimer dismissed={false} />);
    rerender(<Disclaimer dismissed />);
    const card = container.querySelector('footer')!;
    expect(card.className).toMatch(/dismissed/); // animation class while leaving
    expect(card).toHaveAttribute('aria-hidden', 'true'); // decorative during the exit
    fireEvent.transitionEnd(card);
    expect(container.querySelector('footer')).toBeNull(); // unmounted
  });

  it('dismissed: unmounts via the timeout fallback when transitionend never fires', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Disclaimer dismissed={false} />);
    rerender(<Disclaimer dismissed />);
    expect(container.querySelector('footer')).not.toBeNull(); // still animating
    act(() => {
      vi.advanceTimersByTime(700); // > DISMISS_FALLBACK_MS
    });
    expect(container.querySelector('footer')).toBeNull();
  });

  it('prefers-reduced-motion: hides immediately without animating', () => {
    stubReducedMotion(true);
    const { container, rerender } = render(<Disclaimer dismissed={false} />);
    expect(container.querySelector('footer')).not.toBeNull();
    rerender(<Disclaimer dismissed />);
    expect(container.querySelector('footer')).toBeNull(); // no exit class, no wait
  });
});
