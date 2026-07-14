import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import CodeMirror, { EditorView, placeholder, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { useTranslation } from 'react-i18next';
import type { CodeInputBaseProps } from './TextareaInput';
import type { CodeInputHandle } from './CodeInput';
import { isImeComposing } from '../../hooks/useEnterToSubmit';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import styles from './CodeMirrorInput.module.css';

/** Per-language CodeMirror 6 extensions (tree-shaken). Unknown languages get plain text. */
function languageExtensions(language: string) {
  if (/^(js|jsx|ts|tsx|javascript|typescript)$/i.test(language)) {
    return [javascript({ jsx: true, typescript: /tsx?|typescript/i.test(language) })];
  }
  if (/^(py|python)$/i.test(language)) return [python()];
  return [];
}

// Tokens-based dark theme so the editor isn't a light slab in dark mode. Reads the same
// CSS custom properties the rest of the app uses (var() resolves inside CodeMirror's injected CSS).
const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-gutters': {
      backgroundColor: 'var(--code-bg)',
      color: 'var(--text-subtle)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'var(--bg-subtle)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-subtle)' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-placeholder': { color: 'var(--text-subtle)' },
  },
  { dark: true },
);

/** The "exceeds-the-bar" highlighting editor (FE §2.1). Line-number gutter aligns with §5.5. */
export const CodeMirrorInput = forwardRef<CodeInputHandle, CodeInputBaseProps>(function CodeMirrorInput(
  { value, onChange, language, readOnly, onSubmit },
  ref,
) {
  const { t } = useTranslation();
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const placeholderText = t('review.placeholder');

  // Accessible name + placeholder: CodeMirror's editable content is a contenteditable
  // with no implicit label; without aria-label SR users hear an unlabeled "edit text" region.
  const extensions = useMemo(
    () => [
      ...languageExtensions(language),
      placeholder(placeholderText),
      EditorView.contentAttributes.of({ 'aria-label': placeholderText }),
      ...(prefersDark ? [darkTheme] : []),
    ],
    [language, placeholderText, prefersDark],
  );

  // IME-safe Cmd/Ctrl+Enter run shortcut (FE §14). A bare Enter stays a newline in the code editor;
  // a CJK-candidate commit (isComposing / keyCode 229) never runs. Shares the textarea's IME guard.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || isImeComposing(e) || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      onSubmit?.();
    },
    [onSubmit],
  );

  useImperativeHandle(
    ref,
    () => ({
      // Select the cited inclusive range and scroll it into view (spec §5.5 citation jump).
      scrollToLine(from: number, to = from) {
        const view = cmRef.current?.view;
        if (!view) return;
        const lineCount = view.state.doc.lines;
        const startLine = view.state.doc.line(Math.max(1, Math.min(from, lineCount)));
        const endLine = view.state.doc.line(Math.max(1, Math.min(to, lineCount)));
        view.dispatch({ selection: { anchor: startLine.from, head: endLine.to }, scrollIntoView: true });
        view.focus();
      },
    }),
    [],
  );

  return (
    <CodeMirror
      ref={cmRef}
      className={styles.codeInput}
      value={value}
      readOnly={readOnly}
      editable={!readOnly}
      extensions={extensions}
      onChange={(v) => onChange(v)}
      onKeyDown={onSubmit ? onKeyDown : undefined}
      basicSetup={{ lineNumbers: true }}
    />
  );
});
