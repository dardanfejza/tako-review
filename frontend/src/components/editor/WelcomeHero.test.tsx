import { vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { WelcomeHero } from './WelcomeHero';
import { BURST_EVENT } from '../../creatures/burst';
import type { CodeInputVariant } from './CodeInput';

const base = {
  code: '',
  onCodeChange: vi.fn(),
  language: 'python',
  running: false,
  canRun: false,
  onRun: vi.fn(),
  onCancel: vi.fn(),
  codeInputVariant: 'textarea' as CodeInputVariant,
};

describe('WelcomeHero', () => {
  it('renders the "Let\'s Code" heading', () => {
    render(<WelcomeHero {...base} />);
    expect(screen.getByRole('heading', { name: /let's code/i })).toBeInTheDocument();
  });

  it('renders a fish logo SVG', () => {
    const { container } = render(<WelcomeHero {...base} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders the Run Review button via the forwarded EditorPane', () => {
    render(<WelcomeHero {...base} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeInTheDocument();
  });

  it('forwards modelSelector into EditorPane\'s action bar', () => {
    render(
      <WelcomeHero
        {...base}
        modelSelector={<span data-testid="model-sel">Model</span>}
      />,
    );
    expect(screen.getByTestId('model-sel')).toBeInTheDocument();
  });

  it('forwards running=true to EditorPane (locks editor)', () => {
    render(<WelcomeHero {...base} running={true} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  });

  it('stays in centered mode (no data-split) without a resultPane', () => {
    const { container } = render(<WelcomeHero {...base} />);
    expect(container.firstElementChild).not.toHaveAttribute('data-split');
  });

  it('renders the resultPane slot and enters split mode when provided', () => {
    const { container } = render(
      <WelcomeHero {...base} resultPane={<div data-testid="result-pane">review</div>} />,
    );
    expect(screen.getByTestId('result-pane')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-split');
  });

  it('hides the heading but keeps the logo in split mode', () => {
    const { container } = render(<WelcomeHero {...base} resultPane={<div>review</div>} />);
    expect(screen.queryByRole('heading', { name: /let's code/i })).toBeNull();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders the alert slot in the hero column', () => {
    render(<WelcomeHero {...base} alert={<p role="alert">generation failed</p>} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a keyboard-resizable divider in split mode and persists the split', () => {
    localStorage.clear();
    render(<WelcomeHero {...base} resultPane={<div>review</div>} />);
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(sep).toHaveAttribute('aria-valuenow', '48');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '50');
    expect(localStorage.getItem('tako.split.left')).toBe('50');
  });

  it('exposes no separator in the centered hero state', () => {
    render(<WelcomeHero {...base} />);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('renders the editor as a full-height panel (file tab) only in split mode', () => {
    const { unmount } = render(<WelcomeHero {...base} resultPane={<div>review</div>} />);
    expect(screen.getByText('untitled.py')).toBeInTheDocument();
    unmount();
    render(<WelcomeHero {...base} />);
    expect(screen.queryByText('untitled.py')).toBeNull();
  });

  it('dispatches a fish-burst event and still runs the review on Run Review', async () => {
    const onRun = vi.fn();
    const onBurst = vi.fn();
    window.addEventListener(BURST_EVENT, onBurst);
    try {
      render(<WelcomeHero {...base} canRun={true} onRun={onRun} />);
      await userEvent.click(screen.getByRole('button', { name: /run review/i }));
      expect(onRun).toHaveBeenCalledTimes(1);
      expect(onBurst).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(BURST_EVENT, onBurst);
    }
  });
});
