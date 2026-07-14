import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { useEnterToSubmit } from './useEnterToSubmit';

function keyEvent(key: string, shiftKey = false): KeyboardEvent {
  return { key, shiftKey, preventDefault: vi.fn(), nativeEvent: {} } as unknown as KeyboardEvent;
}

function modKeyEvent(mod: 'meta' | 'ctrl'): KeyboardEvent {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: mod === 'meta',
    ctrlKey: mod === 'ctrl',
    preventDefault: vi.fn(),
    nativeEvent: {},
  } as unknown as KeyboardEvent;
}

describe('useEnterToSubmit (single IME-safe Enter handler — FE §14)', () => {
  it('submits on plain Enter and prevents default', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    const e = keyEvent('Enter');
    result.current.onKeyDown(e);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('does not submit on Shift+Enter (newline)', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    result.current.onKeyDown(keyEvent('Enter', true));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit while composing (IME), then submits after composition ends', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    result.current.onCompositionStart();
    result.current.onKeyDown(keyEvent('Enter'));
    expect(onSubmit).not.toHaveBeenCalled();
    result.current.onCompositionEnd();
    result.current.onKeyDown(keyEvent('Enter'));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('respects nativeEvent.isComposing even without a composition-start', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    const e = { key: 'Enter', shiftKey: false, preventDefault: vi.fn(), nativeEvent: { isComposing: true } } as unknown as KeyboardEvent;
    result.current.onKeyDown(e);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores non-Enter keys', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    result.current.onKeyDown(keyEvent('a'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('useEnterToSubmit — hardened IME guard (keyCode 229 / synthetic isComposing)', () => {
  it('does not submit on the IME-commit keystroke reported as keyCode 229', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    // Some browsers report the candidate-commit Enter as keyCode 229 without isComposing set.
    const e = {
      key: 'Enter',
      shiftKey: false,
      keyCode: 229,
      preventDefault: vi.fn(),
      nativeEvent: {},
    } as unknown as KeyboardEvent;
    result.current.onKeyDown(e);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('respects a synthetic isComposing flag even when nativeEvent omits it', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit));
    const e = {
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
      preventDefault: vi.fn(),
      nativeEvent: {},
    } as unknown as KeyboardEvent;
    result.current.onKeyDown(e);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('useEnterToSubmit — requireMod=true (Cmd/Ctrl+Enter only, M-4)', () => {
  it('does NOT submit on a bare Enter (so it inserts a newline in the textarea)', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit, true));
    const e = keyEvent('Enter');
    result.current.onKeyDown(e);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled(); // newline keystroke is left untouched
  });

  it('submits on Cmd+Enter and on Ctrl+Enter, preventing default', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit, true));
    const cmd = modKeyEvent('meta');
    result.current.onKeyDown(cmd);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(cmd.preventDefault).toHaveBeenCalled();

    const ctrl = modKeyEvent('ctrl');
    result.current.onKeyDown(ctrl);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(ctrl.preventDefault).toHaveBeenCalled();
  });

  it('still suppresses an IME-commit Cmd/Ctrl+Enter (keyCode 229)', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useEnterToSubmit(onSubmit, true));
    const e = {
      key: 'Enter',
      shiftKey: false,
      metaKey: true,
      keyCode: 229,
      preventDefault: vi.fn(),
      nativeEvent: {},
    } as unknown as KeyboardEvent;
    result.current.onKeyDown(e);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
