import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { CodeInput } from './CodeInput';
import { RunReviewButton } from './RunReviewButton';
import { SampleCodeButton, SAMPLE_CODE } from './SampleCodeButton';
import { SAMPLE_CATALOG, pickSampleIndex } from './sampleCatalog';
import { EditorPane } from './EditorPane';

describe('CodeInput (textarea variant)', () => {
  it('renders a textbox and reports changes', async () => {
    const onChange = vi.fn();
    render(<CodeInput variant="textarea" value="" onChange={onChange} language="python" />);
    await userEvent.type(screen.getByRole('textbox'), 'x');
    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('is read-only when readOnly is set', () => {
    render(<CodeInput variant="textarea" value="abc" onChange={() => {}} language="python" readOnly />);
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  });
});

describe('RunReviewButton', () => {
  it('is disabled when disabled is set', () => {
    render(<RunReviewButton onRun={() => {}} onCancel={() => {}} running={false} disabled />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeDisabled();
  });

  it('runs when enabled', async () => {
    const onRun = vi.fn();
    render(<RunReviewButton onRun={onRun} onCancel={() => {}} running={false} disabled={false} />);
    await userEvent.click(screen.getByRole('button', { name: /run review/i }));
    expect(onRun).toHaveBeenCalled();
  });

  it('swaps to the stop circle while running: Run is gone, Stop cancels', async () => {
    const onCancel = vi.fn();
    render(<RunReviewButton onRun={() => {}} onCancel={onCancel} running disabled={false} />);
    expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('sample catalog', () => {
  it('has 10 entries, each with non-empty code and a distinct language', () => {
    expect(SAMPLE_CATALOG).toHaveLength(10);
    for (const entry of SAMPLE_CATALOG) {
      expect(entry.code).toMatch(/\S/);
      expect(entry.language).toMatch(/\S/);
    }
    const languages = new Set(SAMPLE_CATALOG.map((e) => e.language));
    expect(languages.size).toBe(10);
  });

  it('keeps SAMPLE_CODE as the first catalog entry (ReviewWorkspace onTrySample compat)', () => {
    expect(SAMPLE_CODE).toBe(SAMPLE_CATALOG[0]!.code);
  });

  it('pickSampleIndex maps random() to an index and offsets away from the last index', () => {
    expect(pickSampleIndex(null, () => 0.35)).toBe(3); // no history: straight floor(r*10)
    expect(pickSampleIndex(2, () => 0.35)).toBe(3); // no collision: keep the roll
    expect(pickSampleIndex(3, () => 0.35)).toBe(4); // collision: offset by one
    expect(pickSampleIndex(9, () => 0.99)).toBe(0); // collision at the end: wrap around
  });
});

describe('SampleCodeButton', () => {
  it('seeds non-empty sample code', async () => {
    const onSeed = vi.fn();
    render(<SampleCodeButton onSeed={onSeed} />);
    await userEvent.click(screen.getByRole('button', { name: /sample code/i }));
    expect(onSeed).toHaveBeenCalledWith(expect.stringMatching(/\S/));
  });

  it('seeds a snippet that comes from the catalog', async () => {
    const onSeed = vi.fn();
    render(<SampleCodeButton onSeed={onSeed} />);
    await userEvent.click(screen.getByRole('button', { name: /sample code/i }));
    const seeded = onSeed.mock.calls[0]![0] as string;
    expect(SAMPLE_CATALOG.map((e) => e.code)).toContain(seeded);
  });

  it('never seeds the same snippet twice in a row (Math.random pinned to collide)', async () => {
    // Pin Math.random so every roll lands on index 0 — the second click MUST offset away.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    try {
      const onSeed = vi.fn();
      render(<SampleCodeButton onSeed={onSeed} />);
      const button = screen.getByRole('button', { name: /sample code/i });
      await userEvent.click(button);
      await userEvent.click(button);
      expect(onSeed).toHaveBeenCalledTimes(2);
      const [first] = onSeed.mock.calls[0]! as [string];
      const [second] = onSeed.mock.calls[1]! as [string];
      expect(first).not.toBe(second);
      expect(SAMPLE_CATALOG.map((e) => e.code)).toContain(second);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('is truly disabled (not a no-op click) when disabled is set', async () => {
    const onSeed = vi.fn();
    render(<SampleCodeButton onSeed={onSeed} disabled />);
    const button = screen.getByRole('button', { name: /sample code/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onSeed).not.toHaveBeenCalled();
  });
});

describe('EditorPane (input lock during REVIEWING — FE §7)', () => {
  const base = {
    code: 'print(1)',
    onCodeChange: vi.fn(),
    language: 'python',
    canRun: true,
    onRun: vi.fn(),
    onCancel: vi.fn(),
    codeInputVariant: 'textarea' as const,
  };

  it('enables Run and editing when not running', () => {
    render(<EditorPane {...base} running={false} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeEnabled();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
  });

  it('locks the editor and shows Stop while running', () => {
    render(<EditorPane {...base} running={true} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('disables the Sample Code button while running', () => {
    render(<EditorPane {...base} running={true} />);
    expect(screen.getByRole('button', { name: /sample code/i })).toBeDisabled();
  });

  it('enables the Sample Code button when not running', () => {
    render(<EditorPane {...base} running={false} />);
    expect(screen.getByRole('button', { name: /sample code/i })).toBeEnabled();
  });

  it('renders the modelSelector slot when provided', () => {
    render(
      <EditorPane
        {...base}
        running={false}
        modelSelector={<span data-testid="ms">Model</span>}
      />,
    );
    expect(screen.getByTestId('ms')).toBeInTheDocument();
  });

  it('renders without error when modelSelector is omitted (backward compat)', () => {
    render(<EditorPane {...base} running={false} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeInTheDocument();
  });

  it('panel variant shows a file tab with the code-derived filename', () => {
    render(<EditorPane {...base} running={false} variant="panel" />);
    expect(screen.getByText('print-1.py')).toBeInTheDocument();
  });

  it('card variant (default) shows no file tab', () => {
    render(<EditorPane {...base} running={false} />);
    expect(screen.queryByText(/\.py$/)).toBeNull();
  });
});
