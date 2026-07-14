import { forwardRef } from 'react';
import { TextareaInput, type CodeInputBaseProps } from './TextareaInput';
import { CodeMirrorInput } from './CodeMirrorInput';

export type CodeInputVariant = 'codemirror' | 'textarea';

/** Imperative handle the result pane uses to jump the editor to a cited line (spec §5.5). */
export interface CodeInputHandle {
  scrollToLine: (from: number, to?: number) => void;
}

export interface CodeInputProps extends CodeInputBaseProps {
  variant?: CodeInputVariant;
}

/**
 * The single editor abstraction (FE §2.1): CodeMirror 6 by default, `<textarea>` as a first-class
 * fallback. The rest of the app is agnostic to which backs it — dropping to textarea is a one-line
 * variant swap. Forwards a {@link CodeInputHandle} so a citation click can jump either variant.
 */
export const CodeInput = forwardRef<CodeInputHandle, CodeInputProps>(function CodeInput(
  { variant = 'codemirror', ...props },
  ref,
) {
  return variant === 'textarea' ? (
    <TextareaInput ref={ref} {...props} />
  ) : (
    <CodeMirrorInput ref={ref} {...props} />
  );
});
