import { vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import '../../i18n';
import { ProgressBar } from './ProgressBar';
import { TipsCarousel } from './TipsCarousel';
import { DownloadOverlay } from './DownloadOverlay';
import { CapabilityGate } from '../gate/CapabilityGate';

describe('ProgressBar (a11y — FE §10)', () => {
  it('exposes progressbar aria attributes', () => {
    render(<ProgressBar value={0.42} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });
});

describe('TipsCarousel (FE §10)', () => {
  it('auto-rotates tips when motion is allowed', () => {
    vi.useFakeTimers();
    try {
      render(<TipsCarousel intervalMs={1000} reducedMotion={false} />);
      expect(screen.getByText(/citations are clickable/i)).toBeVisible();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText(/citations are clickable/i)).not.toBeVisible();
      expect(screen.getByText(/run from the keyboard/i)).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays static when prefers-reduced-motion is set', () => {
    vi.useFakeTimers();
    try {
      render(<TipsCarousel intervalMs={1000} reducedMotion={true} />);
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByText(/citations are clickable/i)).toBeVisible();
      expect(screen.getByText(/run from the keyboard/i)).not.toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every tip mounted (hidden) so the panel height never changes between tips', () => {
    render(<TipsCarousel reducedMotion={true} />);
    expect(screen.getByText(/citations are clickable/i)).toBeVisible();
    expect(screen.getByText(/run from the keyboard/i)).not.toBeVisible();
    expect(screen.getByText(/section by section/i)).not.toBeVisible();
  });

  it('renders the Did-you-know heading, a 1-of-6 pager, and browses with the arrows', async () => {
    render(<TipsCarousel reducedMotion={true} />);
    expect(screen.getByText(/did you know/i)).toBeInTheDocument();
    expect(screen.getByText('1 of 6')).toBeInTheDocument();
    expect(screen.getByText(/citations are clickable/i)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /next tip/i }));
    expect(screen.getByText('2 of 6')).toBeInTheDocument();
    expect(screen.getByText(/run from the keyboard/i)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /previous tip/i }));
    expect(screen.getByText('1 of 6')).toBeInTheDocument();
  });

  it('wraps from the first tip back to the last on previous', async () => {
    render(<TipsCarousel reducedMotion={true} />);
    await userEvent.click(screen.getByRole('button', { name: /previous tip/i }));
    expect(screen.getByText('6 of 6')).toBeInTheDocument();
    expect(screen.getByText(/section by section/i)).toBeVisible();
  });

  it('stops rotating when prefers-reduced-motion is toggled on mid-download', () => {
    // A controllable matchMedia that captures `change` listeners so we can flip the OS setting.
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    let matches = false;
    const mql = {
      get matches() {
        return matches;
      },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
        listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    const original = window.matchMedia;
    window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      // No reducedMotion prop -> the component reads + subscribes to the media query itself.
      render(<TipsCarousel intervalMs={1000} />);
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText(/run from the keyboard/i)).toBeVisible(); // rotating while motion is allowed

      // OS flips prefers-reduced-motion ON: fire the change event the component subscribed to.
      act(() => {
        matches = true;
        listeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent));
      });
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByText(/run from the keyboard/i)).toBeVisible(); // rotation stopped
    } finally {
      vi.useRealTimers();
      window.matchMedia = original;
    }
  });
});

describe('DownloadOverlay', () => {
  it('shows progress while downloading', () => {
    render(<DownloadOverlay progress={0.3} statusText="Fetching shard 3" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  });
  it('shows loaded-from-cache on a cache hit', () => {
    render(<DownloadOverlay progress={1} cacheHit />);
    expect(screen.getByText(/loaded from cache/i)).toBeInTheDocument();
  });
  it('shows a retry on a CDN error', async () => {
    const onRetry = vi.fn();
    render(<DownloadOverlay kind="cdn" onRetry={onRetry} />);
    expect(screen.getByText(/couldn.t reach the model host/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('maps the quota kind to the storage-full message (download.quotaError)', () => {
    render(<DownloadOverlay kind="quota" onRetry={vi.fn()} />);
    expect(screen.getByText(/not enough storage/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t reach the model host/i)).toBeNull();
  });

  it('maps the other kind to a generic failure message', () => {
    render(<DownloadOverlay kind="other" onRetry={vi.fn()} />);
    expect(screen.getByText(/couldn.t be loaded/i)).toBeInTheDocument();
  });

  it('shows the percentage beside the progress bar', () => {
    render(<DownloadOverlay progress={0.63} />);
    expect(screen.getByText('63%')).toBeInTheDocument();
  });

  it('shows elapsed time and an estimated remaining time', () => {
    vi.useFakeTimers();
    try {
      render(<DownloadOverlay progress={0.5} statusText="Fetching param cache [18/30]" />);
      act(() => vi.advanceTimersByTime(11_000));
      // 11s at 50% → ~11s remaining (elapsed * (1-p)/p)
      expect(screen.getByText(/11s elapsed/)).toBeInTheDocument();
      expect(screen.getByText(/~11s remaining/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips WebLLM\'s redundant "% completed, N secs elapsed" tail from the status text', () => {
    render(
      <DownloadOverlay
        progress={0.82}
        statusText="Loading model from cache[24/30]: 686MB loaded. 82% completed, 2 secs elapsed. It can take a while when we first visit this page to populate the cache. Later refreshes will become faster."
      />,
    );
    expect(screen.getByText('Loading model from cache[24/30]: 686MB loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/% completed/)).toBeNull();
  });

  it('folds the works-offline reassurance into the ready description (not the downloading state)', () => {
    const { unmount } = render(<DownloadOverlay ready onStart={vi.fn()} />);
    expect(screen.getByText(/works offline/i)).toBeInTheDocument();
    expect(screen.getByText(/later refreshes will be faster/i)).toBeInTheDocument();
    unmount();
    render(<DownloadOverlay progress={0.3} />);
    expect(screen.queryByText(/works offline/i)).toBeNull();
  });

  it('offers an external Learn-more link', () => {
    render(<DownloadOverlay progress={0.3} />);
    const link = screen.getByRole('link', { name: /learn more/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('huggingface.co'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('titles as Loading (not Downloading) when the weights come from the local cache', () => {
    const { rerender } = render(
      <DownloadOverlay progress={0.1} statusText="Fetching param cache[2/30]: 50MB fetched." />,
    );
    expect(screen.getByRole('heading', { name: /downloading qwen2\.5-coder/i })).toBeInTheDocument();
    rerender(
      <DownloadOverlay progress={0.3} statusText="Loading model from cache[8/30]: 200MB loaded." />,
    );
    expect(screen.getByRole('heading', { name: /^loading qwen2\.5-coder/i })).toBeInTheDocument();
  });

  it('keeps the Loading title through later non-cache phases (no flapping)', () => {
    const { rerender } = render(
      <DownloadOverlay progress={0.5} statusText="Loading model from cache[24/30]: 686MB loaded." />,
    );
    rerender(<DownloadOverlay progress={0.9} statusText="Loading GPU shader modules[12/60]" />);
    expect(screen.getByRole('heading', { name: /^loading qwen2\.5-coder/i })).toBeInTheDocument();
  });

  it('is a non-modal in-page region, not an aria-modal dialog', () => {
    render(<DownloadOverlay progress={0.3} />);
    // No dialog/modal: the surrounding chrome (sidebar, EN/JP toggle) must stay reachable.
    expect(screen.queryByRole('dialog')).toBeNull();
    // Name the query: the Did-you-know tips panel inside the card is also a region
    const region = screen.getByRole('region', { name: /downloading qwen2\.5-coder/i });
    const heading = screen.getByRole('heading', { name: /downloading qwen2\.5-coder/i });
    expect(heading.id).toBeTruthy();
    expect(region).toHaveAttribute('aria-labelledby', heading.id);
  });

  it('moves focus to the error alert when the branch swaps progress->error (re-focus on swap)', () => {
    const { rerender } = render(<DownloadOverlay progress={0.3} />);
    rerender(<DownloadOverlay kind="cdn" onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveFocus();
  });

  it('announces the error via role="alert"', () => {
    render(<DownloadOverlay kind="cdn" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t reach the model host/i);
  });

  it('shows Resume when the download was cancelled and fires onResume', async () => {
    const onResume = vi.fn();
    render(<DownloadOverlay progress={0.5} cancelled onResume={onResume} />);
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onResume).toHaveBeenCalled();
  });
});

describe('DownloadOverlay (ready state — pre-download mirror card)', () => {
  it('renders the imperative title, description, and a Load model button wired to onStart', async () => {
    const onStart = vi.fn();
    render(<DownloadOverlay ready onStart={onStart} />);
    expect(
      screen.getByRole('heading', { name: /download qwen2\.5-coder-1\.5b/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/locally in your browser/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /load model/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows no progress bar, no elapsed line, and no Cancel while ready', () => {
    render(<DownloadOverlay ready onStart={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/elapsed/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
  });

  it('keeps the Did-you-know panel and Learn-more link while ready', () => {
    render(<DownloadOverlay ready onStart={vi.fn()} />);
    expect(screen.getByText(/did you know/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /learn more/i })).toBeInTheDocument();
  });
});

describe('CapabilityGate (spec §5.2)', () => {
  const renderGate = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('renders children when capability is ok', () => {
    renderGate(
      <CapabilityGate status="ok">
        <div>workspace</div>
      </CapabilityGate>,
    );
    expect(screen.getByText('workspace')).toBeInTheDocument();
  });

  it('renders children while probing', () => {
    renderGate(
      <CapabilityGate status="probing">
        <div>workspace</div>
      </CapabilityGate>,
    );
    expect(screen.getByText('workspace')).toBeInTheDocument();
  });

  it('shows the unsupported region on no_webgpu, naming the reason + guest path + preflight link', () => {
    renderGate(
      <CapabilityGate status="no_webgpu" onContinueAsGuest={vi.fn()} onTrySample={vi.fn()}>
        <div>workspace</div>
      </CapabilityGate>,
    );
    expect(screen.queryByText('workspace')).not.toBeInTheDocument();
    expect(screen.getByText(/does not support webgpu/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /detailed capability/i })).toHaveAttribute(
      'href',
      '/preflight',
    );
  });

  it('gives "Continue as guest" a visible confirmation (no longer a no-op)', async () => {
    const onContinueAsGuest = vi.fn();
    renderGate(
      <CapabilityGate status="no_webgpu" onContinueAsGuest={onContinueAsGuest}>
        <div>workspace</div>
      </CapabilityGate>,
    );
    await userEvent.click(screen.getByRole('button', { name: /continue as guest/i }));
    expect(onContinueAsGuest).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/browsing as a guest/i);
  });

  it('gives "Try sample code" a visible confirmation and seeds via the callback', async () => {
    const onTrySample = vi.fn();
    renderGate(
      <CapabilityGate status="no_webgpu" onTrySample={onTrySample}>
        <div>workspace</div>
      </CapabilityGate>,
    );
    await userEvent.click(screen.getByRole('button', { name: /try sample/i }));
    expect(onTrySample).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/sample code is ready/i);
  });
});

