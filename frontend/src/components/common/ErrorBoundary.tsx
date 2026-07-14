import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Generic React error boundary (Contract C1). Catches render/lifecycle errors below it and
 * renders the fallback; when ANY value in `resetKeys` changes the error is cleared so the
 * subtree re-mounts (e.g. the result pane keyed by review id, or a manual reset button).
 *
 * Used at two altitudes: a top-level boundary in `main.tsx` with a locale-INDEPENDENT fallback
 * (LocaleProvider may itself throw, so the fallback must not depend on i18n), and a result-pane
 * boundary so an adversarial streamed-markdown stack-overflow white-screens only the result,
 * not the whole SPA (review §9b).
 */
type FallbackRender = (error: Error, reset: () => void) => ReactNode;

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | FallbackRender;
  resetKeys?: unknown[];
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Shallow per-element compare of two resetKeys arrays — a length or any element change resets. */
function resetKeysChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (prev === next) return false;
  if (!prev || !next || prev.length !== next.length) return true;
  return prev.some((value, i) => !Object.is(value, next[i]));
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for debugging; never re-throw (that would unmount the boundary too).
    // No raw reviewed code reaches here — only the thrown Error's own message/stack.
    console.error('ErrorBoundary caught an error', error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') return (fallback as FallbackRender)(error, this.reset);
      return fallback ?? null;
    }
    return this.props.children;
  }
}
