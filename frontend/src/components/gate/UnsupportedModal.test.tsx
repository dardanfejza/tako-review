import { vi } from 'vitest';
import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import '../../i18n';
import { UnsupportedModal } from './UnsupportedModal';
import { useFocusTrap } from '../../hooks/useFocusTrap';

const renderModal = (status: 'no_webgpu' | 'oom' = 'no_webgpu', props = {}) =>
  render(
    <MemoryRouter>
      <UnsupportedModal status={status} {...props} />
    </MemoryRouter>,
  );

describe('UnsupportedModal (in-page region)', () => {
  it('is an in-page region, NOT an aria-modal dialog (the sidebar/EN-JP toggle must stay reachable)', () => {
    renderModal();
    // No dialog/modal + no focus trap: keyboard / SR users keep access to the surrounding chrome.
    expect(screen.queryByRole('dialog')).toBeNull();
    const region = screen.getByRole('region', { name: /webgpu is required/i });
    expect(region).not.toHaveAttribute('aria-modal');
  });

  it('does not steal focus on mount (no focus trap)', () => {
    renderModal();
    // Focus stays on <body>; the region is announced via the reason's role="alert" instead.
    expect(document.body).toHaveFocus();
  });

  it('names the specific reason via an alert', () => {
    renderModal('no_webgpu');
    expect(screen.getByRole('alert')).toHaveTextContent(/does not support webgpu/i);
  });

  it('links to the detailed preflight capability check', () => {
    renderModal();
    expect(screen.getByRole('link', { name: /detailed capability/i })).toHaveAttribute(
      'href',
      '/preflight',
    );
  });

  it('offers the guest + sample escape buttons when handlers are provided', () => {
    renderModal('no_webgpu', { onContinueAsGuest: vi.fn(), onTrySample: vi.fn() });
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try sample/i })).toBeInTheDocument();
  });
});

// Harness exercising the focus trap hook directly (still used by the truly-blocking AuthModal).
function TrapHarness({ onClose }: { onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onClose });
  return (
    <div ref={ref}>
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element on mount', () => {
    render(<TrapHarness />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(<TrapHarness onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not throw on Escape when no onClose is provided', async () => {
    render(<TrapHarness />);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'first' })).toBeInTheDocument();
  });

  it('traps Tab: from the last element it wraps back to the first', () => {
    render(<TrapHarness />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    // fireEvent so the keydown bubbles to the container listener (userEvent.tab moves focus only).
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('traps Shift+Tab: from the first element it wraps to the last', () => {
    render(<TrapHarness />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('does nothing on Tab when there are no tabbable stops (empty trap)', () => {
    function Empty() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return <div ref={ref} data-testid="empty" />;
    }
    render(<Empty />);
    // No throw and no focus move when the container has no tabbable children.
    fireEvent.keyDown(screen.getByTestId('empty'), { key: 'Tab' });
    expect(screen.getByTestId('empty')).toBeInTheDocument();
  });

  it('restores focus to the previously-focused element on unmount', () => {
    render(
      <>
        <button type="button">opener</button>
        <div id="mount" />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    expect(opener).toHaveFocus();
    const { unmount } = render(<TrapHarness />, {
      container: document.getElementById('mount')!,
    });
    // The trap moved focus to its first button…
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
    unmount();
    // …and on close it returns to the opener instead of dropping to <body>.
    expect(opener).toHaveFocus();
  });

  it('does NOT yank focus back when the app deliberately moved it outside the trap', () => {
    render(
      <>
        <button type="button">opener</button>
        <button type="button">elsewhere</button>
        <div id="mount2" />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'opener' });
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    opener.focus();
    const { unmount } = render(<TrapHarness />, {
      container: document.getElementById('mount2')!,
    });
    // App intentionally moves focus elsewhere while the trap is still mounted.
    elsewhere.focus();
    unmount();
    // Cleanup must leave the intentional target focused, not restore the opener.
    expect(elsewhere).toHaveFocus();
  });
});
