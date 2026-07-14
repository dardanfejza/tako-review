import { afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { AuthMenu } from './AuthMenu';
import { useAuth } from '../../providers/AuthProvider';
import type { MeResponse } from '../../types/api';

vi.mock('../../providers/AuthProvider', () => ({ useAuth: vi.fn() }));
const mockUseAuth = vi.mocked(useAuth);

function setAuth(user: MeResponse | null, signOut = vi.fn()) {
  mockUseAuth.mockReturnValue({
    user,
    isLoading: false,
    signInGitHub: vi.fn(),
    continueAsGuest: vi.fn(),
    signOut,
  });
}

afterEach(() => vi.clearAllMocks());

const GUEST: MeResponse = { id: 'g', is_guest: true, display_name: 'Guest', email: null, ui_language: null };

describe('AuthMenu', () => {
  it('guest: shows the guest label; the account menu reveals Sign in, which opens the modal', async () => {
    setAuth(GUEST);
    render(<AuthMenu />);
    expect(screen.getByText('Guest')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /sign in/i })).toBeNull(); // behind the menu
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^sign in$/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('member: shows the display name; the menu offers Sign out', async () => {
    const signOut = vi.fn();
    setAuth({ id: 'u', is_guest: false, display_name: 'octocat', email: 'o@x.com', ui_language: 'en' }, signOut);
    render(<AuthMenu />);
    expect(screen.getByText('octocat')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });

  it('closes the menu on Escape', async () => {
    setAuth(GUEST);
    render(<AuthMenu />);
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes the menu on an outside click', async () => {
    setAuth(GUEST);
    render(
      <div>
        <AuthMenu />
        <button type="button">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /outside/i }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('guest: explains sign-in persistence in a tooltip on focus', async () => {
    setAuth(GUEST);
    render(<AuthMenu />);
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent(/sign in to keep your reviews/i);
  });

  it('member: shows no sign-in tooltip', async () => {
    setAuth({ id: 'u', is_guest: false, display_name: 'octocat', email: 'o@x.com', ui_language: 'en' });
    render(<AuthMenu />);
    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('collapsed: renders an avatar button that calls onExpand instead of opening a menu', async () => {
    setAuth(GUEST);
    const onExpand = vi.fn();
    render(<AuthMenu collapsed onExpand={onExpand} />);
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    expect(onExpand).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
