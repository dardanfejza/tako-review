import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownReview } from './MarkdownReview';

describe('MarkdownReview (sanitized render — FE §11)', () => {
  it('never renders a <script> element from markdown source', () => {
    const { container } = render(
      <MarkdownReview content={'before\n\n<script>window.__xss=1</script>\n\nafter'} />,
    );
    expect(container.querySelector('script')).toBeNull();
  });

  it('strips javascript: URLs from links', () => {
    const { container } = render(<MarkdownReview content={'[click](javascript:alert(1))'} />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('renders GFM tables', () => {
    const { container } = render(
      <MarkdownReview content={'| a | b |\n|---|---|\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('renders GFM tables with blank lines between rows (model blank-line fix)', () => {
    const { container } = render(
      <MarkdownReview
        content={'| Severity | Notes |\n|---|---|\n| High | bad |\n\n| Medium | N/A |\n| Low | N/A |'}
      />,
    );
    const rows = container.querySelectorAll('tr');
    // header + 3 data rows = 4
    expect(rows.length).toBe(4);
  });

  it('turns an L42 citation into a button that fires onCitationClick({from:42,to:42})', async () => {
    const onCite = vi.fn();
    render(<MarkdownReview content={'See L42 for details.'} onCitationClick={onCite} />);
    await userEvent.click(screen.getByRole('button', { name: 'L42' }));
    expect(onCite).toHaveBeenCalledWith({ from: 42, to: 42 });
  });

  it('fires the full inclusive range for a range citation (full-range anchor)', async () => {
    const onCite = vi.fn();
    render(<MarkdownReview content={'Issues in lines 12-15.'} onCitationClick={onCite} />);
    await userEvent.click(screen.getByRole('button', { name: 'lines 12-15' }));
    expect(onCite).toHaveBeenCalledWith({ from: 12, to: 15 });
  });

  it('turns a Japanese 行目 citation into a button (single + full range)', async () => {
    const onCite = vi.fn();
    const { rerender } = render(
      <MarkdownReview content={'42行目を確認してください。'} onCitationClick={onCite} />,
    );
    await userEvent.click(screen.getByRole('button', { name: '42行目' }));
    expect(onCite).toHaveBeenCalledWith({ from: 42, to: 42 });

    rerender(<MarkdownReview content={'12-15行目に問題があります。'} onCitationClick={onCite} />);
    await userEvent.click(screen.getByRole('button', { name: '12-15行目' }));
    expect(onCite).toHaveBeenCalledWith({ from: 12, to: 15 });
  });

  it('normalizes a reversed citation range so #L15-12 selects 12→15 (not backwards)', async () => {
    const onCite = vi.fn();
    render(<MarkdownReview content={'[see](#L15-12)'} onCitationClick={onCite} />);
    await userEvent.click(screen.getByRole('button', { name: 'see' }));
    expect(onCite).toHaveBeenCalledWith({ from: 12, to: 15 });
  });

  it('renders ordinary links as anchors (not citation buttons)', () => {
    const { container } = render(<MarkdownReview content={'[home](https://example.com)'} />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });
});
