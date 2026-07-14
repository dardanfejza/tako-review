import { afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { AuthErrorBanner } from './AuthErrorBanner';

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(() => window.history.replaceState({}, '', '/'));

describe('AuthErrorBanner', () => {
  it('reads ?auth_error= at /, shows the mapped message, and strips the param', () => {
    window.history.replaceState({}, '', '/?auth_error=state_mismatch');
    render(<AuthErrorBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent(/verified/i);
    expect(window.location.search).not.toContain('auth_error');
  });

  it('maps an unknown reason to the generic error', () => {
    window.history.replaceState({}, '', '/?auth_error=nope');
    render(<AuthErrorBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('renders nothing when there is no auth_error param', () => {
    render(<AuthErrorBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dismisses the notice when close is clicked', async () => {
    window.history.replaceState({}, '', '/?auth_error=state_mismatch');
    render(<AuthErrorBanner />);
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
