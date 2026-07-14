import { afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import '../../i18n';
import { QueryProvider } from '../../providers/QueryProvider';
import { SettingsMenu } from './SettingsMenu';
import { useAuth } from '../../providers/AuthProvider';
import { useLocale } from '../../providers/LocaleProvider';
import type { MeResponse } from '../../types/api';

vi.mock('../../providers/AuthProvider', () => ({ useAuth: vi.fn() }));
vi.mock('../../providers/LocaleProvider', () => ({ useLocale: vi.fn() }));
const mockUseAuth = vi.mocked(useAuth);
const mockUseLocale = vi.mocked(useLocale);
const setLocale = vi.fn();

const GUEST: MeResponse = {
  id: 'g',
  is_guest: true,
  display_name: 'Guest',
  email: null,
  ui_language: null,
  telemetry_opt_out: false,
};
const MEMBER: MeResponse = {
  id: 'u1',
  is_guest: false,
  display_name: 'octocat',
  email: 'o@x.com',
  ui_language: 'en',
  telemetry_opt_out: false,
};

function setAuth(user: MeResponse | null) {
  mockUseAuth.mockReturnValue({
    user,
    isLoading: false,
    signInGitHub: vi.fn(),
    continueAsGuest: vi.fn(),
    signOut: vi.fn(),
  });
}

function renderMenu(ui: ReactElement = <SettingsMenu />) {
  mockUseLocale.mockReturnValue({ locale: 'en', setLocale });
  return render(<QueryProvider>{ui}</QueryProvider>);
}

/** fetch spy answering PATCH /api/auth/me with the given profile (the mutation's onSuccess parses it). */
function stubPatchMe(me: MeResponse) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

const metricsBox = () => screen.getByRole('checkbox', { name: /usage metrics/i });

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('SettingsMenu (opens a dialog)', () => {
  it('opens the settings dialog via the gear and shows the language + usage-metrics entries', async () => {
    setAuth(GUEST);
    renderMenu();
    const gear = screen.getByRole('button', { name: /settings/i });
    expect(gear).toHaveAttribute('aria-haspopup', 'dialog');
    expect(gear).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(gear);
    expect(gear).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: /settings/i });
    expect(dialog).toBeInTheDocument();
    expect(metricsBox()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '日本語' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
  });

  it('closes on Escape and on the close button', async () => {
    setAuth(GUEST);
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('collapsed: the rail gear opens the same dialog', async () => {
    setAuth(GUEST);
    renderMenu(<SettingsMenu collapsed />);
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
  });

  it('language entry switches the locale', async () => {
    setAuth(GUEST);
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(setLocale).toHaveBeenCalledWith('ja');
  });
});

describe('SettingsMenu (telemetry persistence — contract)', () => {
  it('guest: toggling writes localStorage but never PATCHes /me', async () => {
    setAuth(GUEST);
    const fetchSpy = stubPatchMe(GUEST);
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    // "Usage metrics" is ON by default (opt-out false → checked); unchecking it opts out.
    expect(metricsBox()).toBeChecked();
    await userEvent.click(metricsBox());
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true');
    await new Promise((r) => setTimeout(r, 0)); // let any (wrong) mutation fire
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('non-guest: toggling writes localStorage AND PATCHes /api/auth/me {telemetry_opt_out}', async () => {
    setAuth(MEMBER);
    const fetchSpy = stubPatchMe({ ...MEMBER, telemetry_opt_out: true });
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    await userEvent.click(metricsBox());
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/me');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ telemetry_opt_out: true });
  });

  it('toggling metrics back on persists "false" (and mirrors it for a member)', async () => {
    // Server and local agree on "opted out" at mount (the reconcile would otherwise win).
    setAuth({ ...MEMBER, telemetry_opt_out: true });
    localStorage.setItem('tako.telemetry_opt_out', 'true');
    const fetchSpy = stubPatchMe({ ...MEMBER, telemetry_opt_out: false });
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    // Opted out at mount → "Usage metrics" is unchecked; re-checking it opts back in.
    expect(metricsBox()).not.toBeChecked();
    await userEvent.click(metricsBox());
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('false');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      telemetry_opt_out: false,
    });
  });

  it('login reconcile: a non-guest profile value is written INTO localStorage (server wins)', async () => {
    setAuth({ ...MEMBER, telemetry_opt_out: true });
    renderMenu();
    await waitFor(() => expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true'));
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(metricsBox()).not.toBeChecked(); // opted out → metrics off
  });

  it('login reconcile: server false overwrites a stale local true for a non-guest (server wins both ways)', async () => {
    localStorage.setItem('tako.telemetry_opt_out', 'true');
    setAuth({ ...MEMBER, telemetry_opt_out: false });
    renderMenu();
    await waitFor(() => expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('false'));
  });

  it('guest principals are NOT reconciled (their server default must not erase a local opt-out)', async () => {
    localStorage.setItem('tako.telemetry_opt_out', 'true');
    setAuth({ ...GUEST, telemetry_opt_out: false });
    renderMenu();
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true');
  });
});
