import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './Tooltip.module.css';

/**
 * Lightweight hover/focus tooltip for surfacing non-obvious features. The bubble is
 * position:fixed so it escapes sidebar overflow clipping (same trick as HistoryItem's
 * details popup). Keyboard focus shows it immediately; mouse hover after a short delay;
 * activating the control (click) closes it so it never lingers over menus.
 */
export function Tooltip({
  label,
  children,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    if (disabled) return;
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.top - 8, left: r.left + r.width / 2 });
  };
  const showDelayed = () => {
    if (disabled) return;
    timerRef.current = setTimeout(show, 300);
  };
  const close = () => {
    clearTimeout(timerRef.current);
    setPos(null);
  };

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  return (
    <span
      ref={wrapRef}
      // Passive wrapper: the interactive element is the wrapped child; click/Escape only dismiss
      // the bubble (WCAG 1.4.13 dismissable-on-Escape, same pattern as the HistoryItem tooltip).
      role="presentation"
      className={styles.tooltipWrap}
      onMouseEnter={showDelayed}
      onMouseLeave={close}
      onFocus={show}
      onBlur={close}
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      {children}
      {pos && (
        <span role="tooltip" className={styles.tooltipBubble} style={{ top: pos.top, left: pos.left }}>
          {label}
        </span>
      )}
    </span>
  );
}
