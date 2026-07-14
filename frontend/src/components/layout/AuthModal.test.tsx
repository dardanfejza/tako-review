import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AuthModal } from './AuthModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

afterEach(cleanup);

describe('AuthModal', () => {
  it('wires GitHub and disables the other providers', () => {
    const onGitHub = vi.fn();
    render(<AuthModal onGitHub={onGitHub} onClose={() => {}} />);
    const github = screen.getByRole('button', { name: /continueWithGitHub/ });
    expect(github).not.toBeDisabled();
    fireEvent.click(github);
    expect(onGitHub).toHaveBeenCalledTimes(1);
    for (const key of ['continueWithGoogle', 'continueWithApple', 'continueWithLine']) {
      expect(screen.getByRole('button', { name: new RegExp(key) })).toBeDisabled();
    }
  });

  it('dismisses on Escape, close button, and backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(<AuthModal onGitHub={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /common.close/ }));
    fireEvent.click(container.querySelector('[data-backdrop]')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('is a labelled modal dialog', () => {
    render(<AuthModal onGitHub={() => {}} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });
});
