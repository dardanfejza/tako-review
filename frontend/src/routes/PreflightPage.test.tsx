import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import en from '../i18n/en.json';
import type { CapabilityProbeState } from '../hooks/useCapabilityProbe';
import { PreflightPage } from './PreflightPage';

// PreflightPage calls useCapabilityProbe() with no deps, so we mock the hook to drive each branch
// deterministically (probing / ok / each granular failure) without a real WebGPU browser.
const probeState: { current: CapabilityProbeState } = {
  current: { status: 'probing', deviceClass: null },
};
vi.mock('../hooks/useCapabilityProbe', () => ({
  useCapabilityProbe: () => probeState.current,
}));

function setProbe(state: CapabilityProbeState) {
  probeState.current = state;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PreflightPage />
    </MemoryRouter>,
  );
}

/**
 * Resolve a capability row's status by its label: the icon span carries `data-status`, which is
 * the only CSS-independent signal (vitest runs with `css: false`, so module class lookups are
 * stubbed). Walks up from the label text to the row, then reads the icon's data-status.
 */
function rowEl(label: string): HTMLElement {
  const labelEl = screen.getByText(label);
  // label is inside the text div; the row is that div's parent.
  return labelEl.closest('div')!.parentElement as HTMLElement;
}

function rowStatus(label: string): string | null {
  return rowEl(label).querySelector('[data-status]')?.getAttribute('data-status') ?? null;
}

/** The detail line (second span in the text column) of a given row. */
function rowDetail(label: string): string | null {
  const labelEl = screen.getByText(label);
  const textDiv = labelEl.closest('div')!;
  const spans = textDiv.querySelectorAll('span');
  return spans[1]?.textContent ?? null;
}

describe('PreflightPage (standalone capability check — FE §6)', () => {
  it('shows the loading text while the probe is still running', () => {
    setProbe({ status: 'probing', deviceClass: null });
    renderPage();
    expect(screen.getByText(en.common.loading)).toBeInTheDocument();
    // No run link and no unsupported dialog while probing; every row reads pending.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('pending');
    expect(rowStatus(en.preflight.rowSecureContext)).toBe('pending');
    expect(rowStatus(en.preflight.rowWorker)).toBe('pending');
  });

  it('offers a run link back to the app (react-router, not a full reload) when the probe is ok', () => {
    setProbe({ status: 'ok', deviceClass: 'webgpu;vendor=apple' });
    renderPage();
    const link = screen.getByRole('link', { name: en.review.run });
    // <Link to="/"> renders href="/" but client-routes (no full reload that tears down the engine).
    expect(link).toHaveAttribute('href', '/');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(en.common.loading)).toBeNull();
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('ok');
  });

  it('renders failure guidance as a non-modal region (not an aria-modal dialog) on no_webgpu', () => {
    setProbe({ status: 'no_webgpu', deviceClass: null });
    renderPage();
    // The inline guidance must NOT be a focus-trapped aria-modal dialog — that would hide the
    // diagnostic rows (the page's whole point) from screen readers.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByText(en.gate.reasonNoWebgpu)).toBeInTheDocument();
    // Not dead-ended: a way back home plus the sample next-step.
    expect(screen.getByRole('link', { name: en.gate.continueAsGuest })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: en.gate.trySample })).toBeInTheDocument();
  });

  it('does NOT mark the WebGPU row as failed on needs_https (API may exist; context is the blocker)', () => {
    setProbe({ status: 'needs_https', deviceClass: null });
    renderPage();
    // Regression for the conflation bug: needs_https previously rendered "WebGPU: Not supported".
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('warn');
    expect(rowStatus(en.preflight.rowWebgpu)).not.toBe('fail');
    expect(screen.getByText(en.preflight.webgpuBlockedInsecure)).toBeInTheDocument();
    // The fail-only "Not supported" copy must not appear for the WebGPU row in this state.
    expect(screen.queryByText(en.gate.reasonNeedsHttps)).toBeInTheDocument();
  });

  it('shows the device-failed warn (not fail) on oom so the row agrees with the guidance', () => {
    setProbe({ status: 'oom', deviceClass: null });
    renderPage();
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('warn');
    expect(screen.getByText(en.preflight.deviceFailed)).toBeInTheDocument();
    expect(screen.getByText(en.gate.reasonOom)).toBeInTheDocument();
  });

  it('shows the device-failed warn on no_adapter and device_init_failed', () => {
    setProbe({ status: 'no_adapter', deviceClass: null });
    const { unmount } = renderPage();
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('warn');
    expect(screen.getByText(en.preflight.deviceFailed)).toBeInTheDocument();
    unmount();

    setProbe({ status: 'device_init_failed', deviceClass: null });
    renderPage();
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('warn');
    expect(screen.getByText(en.gate.reasonDeviceInitFailed)).toBeInTheDocument();
  });

  it('only the WebGPU API absence renders the "Not supported" fail row', () => {
    setProbe({ status: 'no_webgpu', deviceClass: null });
    renderPage();
    expect(rowStatus(en.preflight.rowWebgpu)).toBe('fail');
    expect(rowDetail(en.preflight.rowWebgpu)).toBe(en.preflight.notSupported);
  });

  it('sources row labels and details from the i18n catalog, not hardcoded English literals', () => {
    // The page reads window.isSecureContext directly; an "ok" probe implies a secure context.
    const prev = window.isSecureContext;
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    try {
      setProbe({ status: 'ok', deviceClass: 'webgpu;vendor=apple' });
      renderPage();
      // Labels come from preflight.* keys (WebGPU stays a proper noun, which equals its key value).
      expect(screen.getByText(en.preflight.rowSecureContext)).toBeInTheDocument();
      expect(screen.getByText(en.preflight.rowWorker)).toBeInTheDocument();
      // Details are catalog-sourced; the old literals would not equal these JA-translatable strings.
      expect(rowDetail(en.preflight.rowSecureContext)).toBe(en.preflight.secureDetail);
      expect(rowDetail(en.preflight.rowWebgpu)).toBe(en.preflight.available);
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: prev, configurable: true });
    }
  });

  it('announces the summary card to screen readers (role=status, aria-live=polite)', () => {
    setProbe({ status: 'ok', deviceClass: 'webgpu;vendor=apple' });
    renderPage();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});
