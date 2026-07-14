import { afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../i18n';
import { QueryProvider } from './QueryProvider';
import { LocaleProvider, useLocale } from './LocaleProvider';
import { AuthContext } from './AuthProvider';
import type { MeResponse, UiLanguage } from '../types/api';

function LocaleProbe() {
  return <span data-testid="locale">{useLocale().locale}</span>;
}

function ToggleProbe({ to = 'en' as UiLanguage }: { to?: UiLanguage }) {
  const { locale, setLocale } = useLocale();
  return (
    <>
      <span data-testid="locale">{locale}</span>
      <button type="button" onClick={() => setLocale(to)}>
        toggle
      </button>
    </>
  );
}

function renderToggle(user: MeResponse | null, to: UiLanguage) {
  return render(
    <QueryProvider>
      <AuthContext.Provider value={authValue(user)}>
        <LocaleProvider>
          <ToggleProbe to={to} />
        </LocaleProvider>
      </AuthContext.Provider>
    </QueryProvider>,
  );
}

function authValue(user: MeResponse | null) {
  return {
    user,
    isLoading: false,
    signInGitHub: () => {},
    continueAsGuest: () => {},
    signOut: () => {},
  };
}

function renderWithPrincipal(user: MeResponse | null) {
  return render(
    <QueryProvider>
      <AuthContext.Provider value={authValue(user)}>
        <LocaleProvider>
          <LocaleProbe />
        </LocaleProvider>
      </AuthContext.Provider>
    </QueryProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = '';
});
afterEach(() => vi.unstubAllGlobals());

describe('LocaleProvider — profile reconcile (FE §14)', () => {
  it('adopts the signed-in profile ui_language on load', async () => {
    const user: MeResponse = {
      id: 'u1',
      is_guest: false,
      display_name: 'octocat',
      email: 'o@x.com',
      ui_language: 'ja',
    };
    renderWithPrincipal(user);
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('ja'));
    expect(localStorage.getItem('tako.ui_language')).toBe('ja');
  });

  it('keeps the local default when the profile ui_language is null', async () => {
    const user: MeResponse = {
      id: 'u2',
      is_guest: false,
      display_name: 'x',
      email: null,
      ui_language: null,
    };
    renderWithPrincipal(user);
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
  });

  it('does not clobber a local toggle made after the profile reconcile', async () => {
    // Stub the PATCH /api/auth/me fired by setLocale (signed-in mirror) so it resolves benignly.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ui_language: 'en' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const user: MeResponse = {
      id: 'u9',
      is_guest: false,
      display_name: 'x',
      email: null,
      ui_language: 'ja',
    };
    render(
      <QueryProvider>
        <AuthContext.Provider value={authValue(user)}>
          <LocaleProvider>
            <ToggleProbe />
          </LocaleProvider>
        </AuthContext.Provider>
      </QueryProvider>,
    );
    // Reconciled to the profile value once...
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('ja'));
    // ...then the user toggles locally. The reconcile effect re-runs (locale changed) but the
    // once-per-principal guard must NOT pull it back to the profile's 'ja'.
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
  });

  it('does not throw when rendered without an AuthProvider (tolerant context read)', () => {
    render(
      <QueryProvider>
        <LocaleProvider>
          <LocaleProbe />
        </LocaleProvider>
      </QueryProvider>,
    );
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
  });

  it('sets <html lang> from the reconciled profile ui_language', async () => {
    const user: MeResponse = {
      id: 'u3',
      is_guest: false,
      display_name: 'octocat',
      email: null,
      ui_language: 'ja',
    };
    renderWithPrincipal(user);
    await waitFor(() => expect(document.documentElement.lang).toBe('ja'));
  });

  it('updates <html lang> when the user toggles the locale', async () => {
    // Stub the signed-in mirror PATCH so the mutation resolves benignly.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ui_language: 'ja' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const user: MeResponse = {
      id: 'u4',
      is_guest: false,
      display_name: 'x',
      email: null,
      ui_language: 'en',
    };
    renderToggle(user, 'ja');
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('ja'));
  });
});

describe('LocaleProvider — profile mirror PATCH gating', () => {
  it('does NOT PATCH /api/auth/me when an anonymous visitor toggles the locale', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderToggle(null, 'ja'); // no principal at all
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('locale')).toHaveTextContent('ja'); // local switch still applied
  });

  it('does NOT PATCH /api/auth/me when a guest toggles the locale', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const guest: MeResponse = {
      id: 'g1',
      is_guest: true,
      display_name: 'guest',
      email: null,
      ui_language: null,
    };
    renderToggle(guest, 'ja');
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw when localStorage access throws (storage-blocked browser) — §9b/N-15', async () => {
    // Safari Private Browsing / disabled storage throws on every access. Unguarded reads in
    // initialLocale (render) AND writes in the reconcile effect / setLocale would unmount the
    // whole tree. The provider must degrade to navigator.language + in-memory locale instead.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ui_language: 'ja' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const user: MeResponse = {
      id: 'u-storage',
      is_guest: false,
      display_name: 'x',
      email: null,
      ui_language: 'ja', // drives the reconcile-effect setItem path
    };
    expect(() => renderToggle(user, 'en')).not.toThrow();
    // Reconcile effect (storage-blocked) still applies the profile locale in-memory.
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('ja'));
    // A manual toggle (storage-blocked setLocale) must also not throw and still switch in-memory.
    await expect(userEvent.click(screen.getByRole('button', { name: 'toggle' }))).resolves.toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
  });

  it('DOES PATCH /api/auth/me when a signed-in (non-guest) user toggles the locale', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ui_language: 'ja' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user: MeResponse = {
      id: 'u5',
      is_guest: false,
      display_name: 'octocat',
      email: null,
      ui_language: 'en',
    };
    renderToggle(user, 'ja');
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/auth/me');
  });
});
