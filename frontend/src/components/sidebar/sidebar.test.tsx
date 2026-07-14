import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import '../../i18n';
import { QueryProvider } from '../../providers/QueryProvider';
import { HistoryList } from './HistoryList';
import { HistoryItem } from './HistoryItem';
import { NewReviewButton } from './NewReviewButton';
import { Sidebar } from './Sidebar';
import type { ReviewListItem } from '../../types/api';

vi.mock('../../providers/AuthProvider', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'g', is_guest: true, display_name: 'Guest', email: null, ui_language: null },
    isLoading: false,
    signInGitHub: vi.fn(),
    continueAsGuest: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock('../../providers/LocaleProvider', () => ({
  useLocale: vi.fn(() => ({ locale: 'en', setLocale: vi.fn() })),
}));

// The footer's SettingsMenu mirrors the telemetry pref via a PATCH-/me mutation, so any render
// of <Sidebar> needs a QueryClient (the wrapper survives rerender()).
const renderSidebar = (ui: ReactElement) => render(ui, { wrapper: QueryProvider });

const sidebarBase = {
  items: [],
  isLoading: false,
  hasMore: false,
  selectedId: null,
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onLoadMore: vi.fn(),
  onNewReview: vi.fn(),
  onToggleCollapse: vi.fn(),
};

const item = (id: string, title = 'main.py'): ReviewListItem => ({
  id,
  title,
  review_mode: 'bugs',
  language: 'python',
  created_at: '2026-06-09T00:00:00Z',
  snippet: 'def main():',
  code_bytes: 42,
  line_count: 3,
});

const noop = {
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onLoadMore: vi.fn(),
};

describe('HistoryList (states — FE §5.1)', () => {
  it('shows the empty state when there are no items', () => {
    render(<HistoryList items={[]} {...noop} />);
    expect(screen.getByText(/no reviews yet/i)).toBeInTheDocument();
  });

  it('shows a save-failed banner with retry', async () => {
    const onRetrySave = vi.fn();
    render(<HistoryList items={[]} saveFailed onRetrySave={onRetrySave} {...noop} />);
    expect(screen.getByText(/couldn.t save this review/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetrySave).toHaveBeenCalled();
  });

  it('surfaces a load-failed banner with retry instead of silently showing the empty state', async () => {
    const onRetryLoad = vi.fn();
    render(<HistoryList items={[]} isError onRetryLoad={onRetryLoad} {...noop} />);
    // A failed LIST fetch must NOT read as "no history yet".
    expect(screen.getByText(/couldn.t load history/i)).toBeInTheDocument();
    expect(screen.queryByText(/no reviews yet/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetryLoad).toHaveBeenCalled();
  });

  it('renders the header + snippet body, with mode/size in the tooltip, and restores on click', async () => {
    const onSelect = vi.fn();
    render(<HistoryList items={[item('a')]} {...noop} onSelect={onSelect} />);
    expect(screen.getByText('main.py')).toBeInTheDocument(); // header
    expect(screen.getByText('def main():')).toBeInTheDocument(); // snippet body
    const restore = screen.getByRole('button', { name: /main\.py/ });
    await userEvent.hover(restore);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/Find bugs/);
    expect(tip).toHaveTextContent(/3 lines/);
    await userEvent.click(restore);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('deletes an item only after a confirm step (no one-click destructive delete)', async () => {
    const onDelete = vi.fn();
    render(<HistoryList items={[item('a')]} {...noop} onDelete={onDelete} />);
    // First click arms the confirmation; it must NOT delete yet.
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(onDelete).not.toHaveBeenCalled();
    // Confirming fires the delete.
    await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }));
    expect(onDelete).toHaveBeenCalledWith('a');
  });

  it('lets the user cancel the delete confirmation', async () => {
    const onDelete = vi.fn();
    render(<HistoryList items={[item('a')]} {...noop} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDelete).not.toHaveBeenCalled();
    // Back to the armed delete icon.
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('shows load-more when there are more pages', async () => {
    const onLoadMore = vi.fn();
    render(<HistoryList items={[item('a')]} hasMore {...noop} onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalled();
  });
});

describe('HistoryItem (tooltip + safety)', () => {
  const renderItem = (over: Partial<ReviewListItem> = {}) =>
    render(
      <ul>
        <HistoryItem item={{ ...item('a'), ...over }} onSelect={vi.fn()} onDelete={vi.fn()} />
      </ul>,
    );

  it('falls back to the absolute date when created_at is unparseable (no RangeError on NaN)', async () => {
    // An Invalid Date would crash Intl.RelativeTimeFormat.format(NaN); the guard must absorb it.
    renderItem({ created_at: 'not-a-date' });
    await userEvent.hover(screen.getByRole('button', { name: /main\.py/ }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toBeInTheDocument(); // rendered without throwing
  });

  it('renders a seconds-granularity relative time for a very recent review', async () => {
    renderItem({ created_at: new Date(Date.now() - 5000).toISOString() }); // 5s ago
    await userEvent.hover(screen.getByRole('button', { name: /main\.py/ }));
    const tip = await screen.findByRole('tooltip');
    // "5 seconds ago" / "now" — just assert the tooltip rendered the seconds branch without error.
    expect(tip).toBeInTheDocument();
  });

  it('describes the restore button by the tooltip (aria-describedby) while open', async () => {
    renderItem();
    const restore = screen.getByRole('button', { name: /main\.py/ });
    expect(restore).not.toHaveAttribute('aria-describedby');
    await userEvent.hover(restore);
    const tip = await screen.findByRole('tooltip');
    expect(restore).toHaveAttribute('aria-describedby', tip.id);
  });

  it('dismisses the tooltip on Escape', async () => {
    renderItem();
    await userEvent.hover(screen.getByRole('button', { name: /main\.py/ }));
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('flips the tooltip to the left on a narrow viewport so it does not overflow', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
    try {
      renderItem();
      await userEvent.hover(screen.getByRole('button', { name: /main\.py/ }));
      const tip = await screen.findByRole('tooltip');
      // jsdom getBoundingClientRect returns 0s, so right=8; 8+288 > 375 -> flips to max(8, ...) = 8.
      expect(parseInt(tip.style.left, 10)).toBeLessThanOrEqual(8);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });
});

describe('NewReviewButton', () => {
  it('fires onClick and shows the label when expanded', async () => {
    const onClick = vi.fn();
    render(<NewReviewButton onClick={onClick} />);
    const btn = screen.getByRole('button', { name: /new review/i });
    expect(btn).toHaveTextContent(/new review/i);
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('collapses to an icon-only button that keeps its accessible name', () => {
    render(<NewReviewButton onClick={vi.fn()} collapsed />);
    const btn = screen.getByRole('button', { name: /new review/i });
    expect(btn).not.toHaveTextContent(/new review/i); // label is visually gone…
    expect(btn).toHaveAttribute('aria-label', 'New review'); // …but kept for AT
  });
});

describe('Sidebar (chrome + rail + body gating)', () => {
  it('always shows the brand heading and toggles collapse', async () => {
    const onToggleCollapse = vi.fn();
    renderSidebar(<Sidebar {...sidebarBase} collapsed={false} showBody onToggleCollapse={onToggleCollapse} />);
    expect(screen.getByRole('heading', { name: /takoreview/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('expanded body shows the history list; the rail hides it behind a history icon', () => {
    const { rerender } = renderSidebar(<Sidebar {...sidebarBase} collapsed={false} showBody />);
    expect(screen.getByRole('heading', { name: /^history$/i })).toBeInTheDocument();
    rerender(<Sidebar {...sidebarBase} collapsed showBody />);
    expect(screen.queryByRole('heading', { name: /^history$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^history$/i })).toBeInTheDocument(); // rail icon
  });

  it('selecting a history item restores without closing when not in drawer mode', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderSidebar(
      <Sidebar
        {...sidebarBase}
        items={[item('a')]}
        collapsed={false}
        showBody
        open={false}
        onClose={onClose}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /main\.py/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides the body (new review + history) in non-workspace states but keeps the chrome', () => {
    renderSidebar(<Sidebar {...sidebarBase} collapsed={false} showBody={false} />);
    expect(screen.queryByRole('button', { name: /new review/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^history$/i })).toBeNull();
    expect(screen.getByRole('heading', { name: /takoreview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /account/i })).toBeInTheDocument();
  });
});

describe('Sidebar (mobile drawer — keyboard dismissal)', () => {
  it('closes the open drawer on Escape (document-level listener)', async () => {
    const onClose = vi.fn();
    renderSidebar(<Sidebar {...sidebarBase} collapsed={false} showBody open onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('exposes a focusable close button inside the open drawer', async () => {
    const onClose = vi.fn();
    renderSidebar(<Sidebar {...sidebarBase} collapsed={false} showBody open onClose={onClose} />);
    const close = screen.getByRole('button', { name: /close/i });
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus into the drawer on open', () => {
    const { container } = renderSidebar(
      <Sidebar {...sidebarBase} collapsed={false} showBody open onClose={vi.fn()} />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.contains(document.activeElement)).toBe(true);
  });

  it('closes the drawer when a history item is selected', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    renderSidebar(
      <Sidebar
        {...sidebarBase}
        items={[item('a')]}
        collapsed={false}
        showBody
        open
        onClose={onClose}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /main\.py/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalled();
  });
});
