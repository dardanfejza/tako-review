import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * True if `e` is an IME-composition keystroke that must never submit (FE §14). A CJK-candidate
 * commit carries `isComposing` (often only on `nativeEvent`) or, in some browsers, `keyCode === 229`
 * without it — so we check all three.
 */
export function isImeComposing(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return Boolean(e.isComposing) || Boolean(e.nativeEvent?.isComposing) || e.keyCode === 229;
}

/**
 * A SINGLE composition-aware Enter handler (FE §14). The reference app attaches duplicate
 * listeners and the second drops the shiftKey guard — we implement one handler that submits only
 * on Enter while not composing. Guards on both a tracked flag and nativeEvent.isComposing
 * (the IME-commit Enter often carries isComposing=true without a matching compositionstart).
 *
 * `requireMod` (default false) gates submission on Cmd/Ctrl+Enter, leaving a bare Enter to insert a
 * newline. CodeMirror already uses Cmd/Ctrl+Enter; the textarea fallback passes `true` so the one
 * agnostic CodeInput abstraction submits on the same gesture in both editors.
 */
export function useEnterToSubmit(onSubmit: () => void, requireMod = false) {
  const composing = useRef(false);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || composing.current) return;
      if (requireMod && !(e.metaKey || e.ctrlKey)) return;
      if (isImeComposing(e)) return;
      e.preventDefault();
      onSubmit();
    },
    [onSubmit, requireMod],
  );

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);
  const onCompositionEnd = useCallback(() => {
    composing.current = false;
  }, []);

  return { onKeyDown, onCompositionStart, onCompositionEnd };
}
