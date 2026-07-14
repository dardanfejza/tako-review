/** Latest-value throttle for high-frequency streams (token deltas → React state).
 *  Leading call emits immediately; calls inside the window coalesce and only the most
 *  recent value fires at the trailing edge. flush() emits any pending value now;
 *  cancel() drops it (e.g. when the final authoritative value is about to land). */

export interface ThrottledEmit<T> {
  (value: T): void;
  flush(): void;
  cancel(): void;
}

export function throttleLatest<T>(emit: (value: T) => void, ms: number): ThrottledEmit<T> {
  let lastEmit = -Infinity;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function fire(value: T) {
    lastEmit = Date.now();
    emit(value);
  }

  const throttled = ((value: T) => {
    const now = Date.now();
    if (!timer && now - lastEmit >= ms) {
      fire(value);
      return;
    }
    pending = { value };
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          const v = pending.value;
          pending = null;
          fire(v);
        }
      }, Math.max(0, ms - (now - lastEmit)));
    }
  }) as ThrottledEmit<T>;

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      const v = pending.value;
      pending = null;
      fire(v);
    }
  };

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return throttled;
}
