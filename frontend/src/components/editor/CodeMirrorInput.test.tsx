import { vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef, forwardRef, useImperativeHandle, type ComponentProps } from 'react';

// A fake CodeMirror view so the imperative scrollToLine handle has something to dispatch against.
const dispatch = vi.fn();
const fakeView = {
  state: {
    doc: {
      lines: 5,
      line: (n: number) => ({ from: n * 10, to: n * 10 + 9 }),
    },
  },
  dispatch,
  focus: vi.fn(),
};

// Mock the heavy CodeMirror editor with a minimal textarea that surfaces the wired `onKeyDown`,
// so the IME-safe run-shortcut wiring can be tested deterministically in jsdom (no editor boot).
// The accessible-name + placeholder + dark-theme extensions read EditorView / placeholder, so the
// mock stubs those CM primitives too. The ref exposes a fake `view` to exercise scrollToLine.
vi.mock('@uiw/react-codemirror', () => ({
  default: forwardRef(
    (
      props: {
        value?: string;
        readOnly?: boolean;
        onChange?: (v: string) => void;
        onKeyDown?: (e: React.KeyboardEvent) => void;
        extensions?: unknown[];
      },
      ref: unknown,
    ) => {
      useImperativeHandle(ref as never, () => ({ view: fakeView }));
      return (
        <textarea
          data-testid="cm"
          data-ext-count={props.extensions?.length ?? 0}
          value={props.value}
          readOnly={props.readOnly}
          onChange={(e) => props.onChange?.(e.target.value)}
          onKeyDown={props.onKeyDown}
        />
      );
    },
  ),
  EditorView: {
    theme: (spec: unknown, opts: unknown) => ({ kind: 'theme', spec, opts }),
    contentAttributes: { of: (attrs: unknown) => ({ kind: 'contentAttributes', attrs }) },
  },
  placeholder: (text: unknown) => ({ kind: 'placeholder', text }),
}));

import { CodeMirrorInput } from './CodeMirrorInput';
import type { CodeInputHandle } from './CodeInput';

function renderCM(over: Partial<ComponentProps<typeof CodeMirrorInput>> = {}) {
  const onSubmit = vi.fn();
  render(
    <CodeMirrorInput
      value="print(1)"
      onChange={() => {}}
      language="python"
      onSubmit={onSubmit}
      {...over}
    />,
  );
  return { onSubmit, cm: screen.getByTestId('cm') };
}

describe('CodeMirrorInput — IME-safe Cmd/Ctrl+Enter run shortcut (FE §14)', () => {
  it('runs onSubmit on Cmd+Enter', () => {
    const { onSubmit, cm } = renderCM();
    fireEvent.keyDown(cm, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('runs onSubmit on Ctrl+Enter', () => {
    const { onSubmit, cm } = renderCM();
    fireEvent.keyDown(cm, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does not run on a bare Enter (newline in the code editor)', () => {
    const { onSubmit, cm } = renderCM();
    fireEvent.keyDown(cm, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not run on Cmd+Enter while composing a CJK candidate (keyCode 229)', () => {
    const { onSubmit, cm } = renderCM();
    fireEvent.keyDown(cm, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not run on Cmd+Enter while nativeEvent.isComposing is set', () => {
    const { onSubmit, cm } = renderCM();
    fireEvent.keyDown(cm, { key: 'Enter', metaKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores non-Enter keys even with the modifier held', () => {
    const { onSubmit, cm } = renderCM();
    fireEvent.keyDown(cm, { key: 'a', metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not wire a handler when no onSubmit is provided (read-only / locked)', () => {
    render(<CodeMirrorInput value="print(1)" onChange={() => {}} language="python" />);
    // No throw on Enter when the shortcut is intentionally not wired.
    fireEvent.keyDown(screen.getByTestId('cm'), { key: 'Enter', metaKey: true });
  });

  it('wires the placeholder + accessible-name extensions', () => {
    const { cm } = renderCM();
    // python lang + placeholder + contentAttributes (aria-label); light theme adds none.
    expect(Number(cm.getAttribute('data-ext-count'))).toBeGreaterThanOrEqual(3);
  });

  it('builds a JS/TS extension set without throwing', () => {
    const { cm } = renderCM({ language: 'tsx' });
    expect(Number(cm.getAttribute('data-ext-count'))).toBeGreaterThanOrEqual(3);
  });

  it('builds a plain-text extension set for unknown languages', () => {
    const { cm } = renderCM({ language: 'rust' }); // unknown -> no language pack
    // placeholder + contentAttributes still present even without a language pack.
    expect(Number(cm.getAttribute('data-ext-count'))).toBeGreaterThanOrEqual(2);
  });
});

describe('CodeMirrorInput — citation jump (spec §5.5 scrollToLine)', () => {
  it('selects the cited inclusive range and scrolls it into view', () => {
    dispatch.mockClear();
    const ref = createRef<CodeInputHandle>();
    render(
      <CodeMirrorInput ref={ref} value={'a\nb\nc\nd\ne'} onChange={() => {}} language="python" />,
    );
    ref.current!.scrollToLine(2, 4);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ scrollIntoView: true, selection: expect.any(Object) }),
    );
  });

  it('clamps an out-of-range citation to the document bounds', () => {
    dispatch.mockClear();
    const ref = createRef<CodeInputHandle>();
    render(<CodeMirrorInput ref={ref} value={'a\nb'} onChange={() => {}} language="python" />);
    // Far past the 5-line fake doc — must not throw; defaults `to` to `from`.
    ref.current!.scrollToLine(99);
    expect(dispatch).toHaveBeenCalled();
  });
});
