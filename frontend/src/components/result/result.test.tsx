import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { TimingBadge } from './TimingBadge';
import { ChunkProgress } from './ChunkProgress';
import { FeedbackWidget } from './FeedbackWidget';
import { ResultPane } from './ResultPane';
import type { Timing } from '../../types/api';

const timing: Timing = {
  load_ms: 0,
  ttft_ms: 100,
  total_ms: 4200,
  tokens_prompt: 10,
  tokens_completion: 20,
  tok_per_sec: 38,
};

describe('TimingBadge (spec §5.3)', () => {
  it('formats e2e seconds and tok/s', () => {
    render(<TimingBadge timing={timing} />);
    expect(screen.getByText('reviewed in 4.2s · 38 tok/s')).toBeInTheDocument();
  });

  it('coalesces missing total_ms / tok_per_sec to 0 (optional wire fields)', () => {
    render(
      <TimingBadge timing={{ load_ms: 0, tokens_prompt: 1, tokens_completion: 1 }} />,
    );
    expect(screen.getByText('reviewed in 0.0s · 0 tok/s')).toBeInTheDocument();
  });
});

describe('ChunkProgress (FE §4.6)', () => {
  it('renders nothing for a single chunk', () => {
    const { container } = render(<ChunkProgress index={1} total={1} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows section progress when chunked', () => {
    render(<ChunkProgress index={2} total={5} />);
    expect(screen.getByText(/section 2 of 5/i)).toBeInTheDocument();
  });
});

describe('FeedbackWidget (gated on save, append-only — FE §8.C)', () => {
  it('is disabled until a review id exists', () => {
    render(<FeedbackWidget reviewId={null} onVote={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeDisabled();
  });

  it('shows the save-to-enable hint when the save failed', () => {
    render(<FeedbackWidget reviewId={null} saveFailed onVote={vi.fn()} />);
    expect(screen.getByText(/save the review to leave feedback/i)).toBeInTheDocument();
  });

  it('votes up with no tags', async () => {
    const onVote = vi.fn();
    render(<FeedbackWidget reviewId="r1" onVote={onVote} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(onVote).toHaveBeenCalledWith('up', []);
  });

  it('votes down with the selected reason tags', async () => {
    const onVote = vi.fn();
    render(<FeedbackWidget reviewId="r1" onVote={onVote} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Too vague' }));
    await userEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(onVote).toHaveBeenCalledWith('down', ['too_vague']);
  });

  it('persists a reason-tag change immediately once a rating exists (no second vote click needed)', async () => {
    const onVote = vi.fn();
    render(
      <FeedbackWidget
        reviewId="r1"
        currentFeedback={{ rating: 'up', reason_tags: [] }}
        onVote={onVote}
      />,
    );
    // Already voted "up"; checking a reason tag must POST {rating:'up', reason_tags:['inaccurate']}.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Inaccurate' }));
    expect(onVote).toHaveBeenCalledWith('up', ['inaccurate']);
    // Unchecking it persists the empty set too (the tag was genuinely removed).
    await userEvent.click(screen.getByRole('checkbox', { name: 'Inaccurate' }));
    expect(onVote).toHaveBeenLastCalledWith('up', []);
  });

  it('does NOT auto-submit a tag toggle before any rating exists (a tag rides a rating)', async () => {
    const onVote = vi.fn();
    render(<FeedbackWidget reviewId="r1" onVote={onVote} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Too vague' }));
    expect(onVote).not.toHaveBeenCalled(); // pending until a rating is chosen
    await userEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(onVote).toHaveBeenCalledWith('up', ['too_vague']); // ...then it submits with the tag
  });

  it('resyncs reason-tag checkboxes when switching reviews from history', () => {
    const { rerender } = render(
      <FeedbackWidget
        reviewId="rA"
        currentFeedback={{ rating: 'down', reason_tags: ['too_vague'] }}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Too vague' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Inaccurate' })).not.toBeChecked();

    // Switch to review B (different feedback): the stale checkbox state must NOT persist.
    rerender(
      <FeedbackWidget
        reviewId="rB"
        currentFeedback={{ rating: 'down', reason_tags: ['inaccurate'] }}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Inaccurate' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Too vague' })).not.toBeChecked();
  });
});

describe('ResultPane', () => {
  it('renders the review markdown and the timing badge', () => {
    render(<ResultPane content={'## Summary\nlooks ok'} timing={timing} reviewId="r1" onVote={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText(/tok\/s/)).toBeInTheDocument();
  });

  it('does NOT wrap the streaming content in aria-live: only a status line announces', () => {
    const { container } = render(
      <ResultPane content={'## Summary'} reviewId="r1" running onVote={vi.fn()} />,
    );
    // The pane itself has no aria-live; only the dedicated sr status node does.
    expect(container.querySelector('section[aria-live]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/reviewing/i);
  });

  it('shows a Reviewing… status before the first token arrives', () => {
    render(<ResultPane content={''} reviewId={null} running onVote={vi.fn()} />);
    // Both the visually-hidden status and the in-flow placeholder read "Reviewing…".
    expect(screen.getAllByText(/reviewing/i).length).toBeGreaterThan(0);
  });

  it('marks the markdown container aria-busy while streaming', () => {
    const { container } = render(
      <ResultPane content={'partial'} reviewId={null} running onVote={vi.fn()} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('defers the feedback widget until generation completes', () => {
    const { rerender } = render(
      <ResultPane content={'partial output'} reviewId="r1" running onVote={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
    rerender(<ResultPane content={'partial output'} reviewId="r1" onVote={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
  });

  it('badges a cancelled run as a partial result', () => {
    render(<ResultPane content={'half a review'} reviewId={null} cancelled onVote={vi.fn()} />);
    expect(screen.getByText(/partial result/i)).toBeInTheDocument();
  });

  it('copies the finished review to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ResultPane content={'the full review'} reviewId="r1" onVote={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('the full review');
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('hides the copy button while streaming', () => {
    render(<ResultPane content={'partial'} reviewId={null} running onVote={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it('announces completion once content is present and not streaming', () => {
    render(<ResultPane content={'done'} reviewId="r1" onVote={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/review complete/i);
  });

  it('keeps the status empty when there is no content and nothing is running', () => {
    render(<ResultPane content={''} reviewId={null} onVote={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
