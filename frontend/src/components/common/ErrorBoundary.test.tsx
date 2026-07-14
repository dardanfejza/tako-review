import { useState } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorBoundary from './ErrorBoundary';

/** A child that throws on first render unless told not to — used to drive the boundary. */
function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('boom');
  return <span>safe child</span>;
}

describe('ErrorBoundary (Contract C1)', () => {
  beforeEach(() => {
    // React logs the caught error to console.error; silence it so the suite output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary fallback={<p>fallback</p>}>
        <span>healthy</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.queryByText('fallback')).not.toBeInTheDocument();
  });

  it('catches a throwing child and renders a ReactNode fallback', () => {
    render(
      <ErrorBoundary fallback={<p>something broke</p>}>
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText('something broke')).toBeInTheDocument();
  });

  it('renders nothing (null) when no fallback is provided but still contains the crash', () => {
    const { container } = render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('passes the error and a reset callback to a render-prop fallback', async () => {
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <ErrorBoundary
          resetKeys={[explode]}
          fallback={(error, reset) => (
            <div>
              <p>caught: {error.message}</p>
              <button
                type="button"
                onClick={() => {
                  setExplode(false);
                  reset();
                }}
              >
                retry
              </button>
            </div>
          )}
        >
          <Bomb explode={explode} />
        </ErrorBoundary>
      );
    }
    render(<Harness />);
    expect(screen.getByText('caught: boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(screen.getByText('safe child')).toBeInTheDocument();
  });

  it('clears the error and re-mounts the subtree when a resetKey changes', async () => {
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setExplode(false)}>
            fix
          </button>
          <ErrorBoundary resetKeys={[explode]} fallback={<p>fallback shown</p>}>
            <Bomb explode={explode} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText('fallback shown')).toBeInTheDocument();
    // Changing the resetKey (explode true→false) must clear the boundary and re-render children.
    await userEvent.click(screen.getByRole('button', { name: 'fix' }));
    expect(screen.getByText('safe child')).toBeInTheDocument();
    expect(screen.queryByText('fallback shown')).not.toBeInTheDocument();
  });

  it('does NOT reset when resetKeys are unchanged across an unrelated re-render', async () => {
    function Harness() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            tick
          </button>
          <ErrorBoundary resetKeys={['stable']} fallback={<p>still broken</p>}>
            <Bomb explode />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText('still broken')).toBeInTheDocument();
    // A re-render that does not touch resetKeys leaves the boundary in its error state.
    await userEvent.click(screen.getByRole('button', { name: 'tick' }));
    expect(screen.getByText('still broken')).toBeInTheDocument();
  });

  it('invokes onReset when the boundary resets via a resetKey change', async () => {
    const onReset = vi.fn();
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setExplode(false)}>
            recover
          </button>
          <ErrorBoundary resetKeys={[explode]} onReset={onReset} fallback={<p>boundary fallback</p>}>
            <Bomb explode={explode} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(onReset).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'recover' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('safe child')).toBeInTheDocument();
  });

  it('does not reset on resetKeys change while healthy (no spurious onReset)', async () => {
    const onReset = vi.fn();
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setN((v) => v + 1)}>
            bump
          </button>
          <ErrorBoundary resetKeys={[n]} onReset={onReset} fallback={<p>fb</p>}>
            <span>alive</span>
          </ErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'bump' }));
    // No error present, so a resetKey change must not call onReset.
    expect(onReset).not.toHaveBeenCalled();
    expect(screen.getByText('alive')).toBeInTheDocument();
  });
});
