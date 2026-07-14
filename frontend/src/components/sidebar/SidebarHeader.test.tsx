import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { SidebarHeader } from './SidebarHeader';

describe('SidebarHeader', () => {
  it('renders the brand as a heading and a collapse toggle (expanded)', async () => {
    const onToggleCollapse = vi.fn();
    render(<SidebarHeader collapsed={false} onToggleCollapse={onToggleCollapse} onHome={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /takoreview/i })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('the brand is a button that returns home', async () => {
    const onHome = vi.fn();
    render(<SidebarHeader collapsed={false} onToggleCollapse={vi.fn()} onHome={onHome} />);
    // The brand button's accessible name comes from the heading text.
    await userEvent.click(screen.getByRole('button', { name: /takoreview/i }));
    expect(onHome).toHaveBeenCalled();
  });

  it('exposes an expand control and keeps the heading when collapsed', () => {
    render(<SidebarHeader collapsed onToggleCollapse={vi.fn()} onHome={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /expand sidebar/i }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { name: /takoreview/i })).toBeInTheDocument();
  });
});
