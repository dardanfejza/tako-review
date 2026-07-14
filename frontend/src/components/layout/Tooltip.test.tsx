import { vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('shows on keyboard focus immediately and hides on blur', async () => {
    render(
      <Tooltip label="hello tip">
        <button type="button">target</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('hello tip');
    await userEvent.tab(); // focus leaves -> blur
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows on hover after a short delay and hides on leave', () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip label="hover tip">
          <button type="button">target</button>
        </Tooltip>,
      );
      const wrap = screen.getByRole('button').parentElement!;
      fireEvent.mouseEnter(wrap);
      expect(screen.queryByRole('tooltip')).toBeNull(); // not yet — delay pending
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('tooltip')).toHaveTextContent('hover tip');
      fireEvent.mouseLeave(wrap);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on click so the bubble never lingers over an activated control', async () => {
    render(
      <Tooltip label="tip">
        <button type="button">target</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays closed while disabled', async () => {
    render(
      <Tooltip label="tip" disabled>
        <button type="button">target</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
