import { afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { QueryProvider } from '../../providers/QueryProvider';
import { SidebarFooter } from './SidebarFooter';
import { useAuth } from '../../providers/AuthProvider';
import type { MeResponse } from '../../types/api';

vi.mock('../../providers/AuthProvider', () => ({ useAuth: vi.fn() }));
vi.mock('../../providers/LocaleProvider', () => ({
  useLocale: vi.fn(() => ({ locale: 'en', setLocale: vi.fn() })),
}));

const GUEST: MeResponse = {
  id: 'g',
  is_guest: true,
  display_name: 'Guest',
  email: null,
  ui_language: null,
  telemetry_opt_out: false,
};

function setAuth(user: MeResponse | null) {
  vi.mocked(useAuth).mockReturnValue({
    user,
    isLoading: false,
    signInGitHub: vi.fn(),
    continueAsGuest: vi.fn(),
    signOut: vi.fn(),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('SidebarFooter', () => {
  it('expanded: renders identity and the settings gear next to it (language now lives in settings)', () => {
    setAuth(GUEST);
    render(<SidebarFooter collapsed={false} onExpand={vi.fn()} />, { wrapper: QueryProvider });
    expect(screen.getByText('Guest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
    // The standalone language toggle moved into the settings dialog (closed by default).
    expect(screen.queryByRole('button', { name: /^language$/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('collapsed: the avatar expands the sidebar; the gear opens settings without a popover in the rail', async () => {
    setAuth(GUEST);
    const onExpand = vi.fn();
    render(<SidebarFooter collapsed onExpand={onExpand} />, { wrapper: QueryProvider });
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    // The gear opens the settings dialog directly (it does not expand the rail).
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
  });
});
