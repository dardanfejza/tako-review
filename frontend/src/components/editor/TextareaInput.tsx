import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEnterToSubmit } from '../../hooks/useEnterToSubmit';
import type { CodeInputHandle } from './CodeInput';
import styles from './TextareaInput.module.css';

export interface CodeInputBaseProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  readOnly?: boolean;
  onSubmit?: () => void;
}

/** 1-based line number → character offset of that line's start within `text`. */
function lineStartOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      seen += 1;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

/** Guaranteed-available `<textarea>` editor (the JP-brief floor — FE §2.1) with IME-safe Enter. */
export const TextareaInput = forwardRef<CodeInputHandle, CodeInputBaseProps>(function TextareaInput(
  { value, onChange, readOnly, onSubmit, language },
  ref,
) {
  const { t } = useTranslation();
  // requireMod=true: submit on Cmd/Ctrl+Enter only, matching CodeMirror — a bare Enter inserts a
  // newline (no Shift needed), so CodeInput is one agnostic abstraction across both editors.
  const enter = useEnterToSubmit(onSubmit ?? (() => {}), true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      // Best-effort jump for the fallback variant: caret + selection on the cited range, which the
      // browser scrolls into view on focus (spec §5.5).
      scrollToLine(from: number, to = from) {
        const ta = taRef.current;
        if (!ta) return;
        const start = lineStartOffset(ta.value, from);
        const next = lineStartOffset(ta.value, to + 1);
        const end = next < ta.value.length ? next - 1 : ta.value.length;
        ta.focus();
        ta.setSelectionRange(start, Math.max(start, end));
      },
    }),
    [],
  );

  return (
    <textarea
      ref={taRef}
      className={styles.codeInput}
      aria-label={t('review.placeholder')}
      placeholder={t('review.placeholder')}
      spellCheck={false}
      value={value}
      readOnly={readOnly}
      data-language={language}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onSubmit ? enter.onKeyDown : undefined}
      onCompositionStart={enter.onCompositionStart}
      onCompositionEnd={enter.onCompositionEnd}
    />
  );
});
