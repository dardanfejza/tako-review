import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewListItem, ReviewMode } from '../../types/api';
import { BURST_EVENT, type BurstRect } from '../../creatures/burst';
import styles from './HistoryItem.module.css';

const MODE_KEY: Record<ReviewMode, string> = {
  explain: 'review.modeExplain',
  bugs: 'review.modeBugs',
  security: 'review.modeSecurity',
  style: 'review.modeStyle',
};

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function relativeTime(date: Date, locale: string): string {
  const sec = Math.round((date.getTime() - Date.now()) / 1000);
  // A malformed `created_at` yields an Invalid Date (getTime → NaN); Intl.RelativeTimeFormat.format
  // throws a RangeError on NaN. Fall back to the absolute string instead of crashing.
  if (!Number.isFinite(sec)) return date.toLocaleString(locale);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, s] of units) {
    if (Math.abs(sec) >= s) return rtf.format(Math.round(sec / s), unit);
  }
  return rtf.format(sec, 'second');
}

/** A history row: a code-derived header + snippet body (FE §5.1/§8.B). Restores on click; a separate
 *  icon deletes (with a confirm step). Hover/focus shows a custom details popup (mode, full date,
 *  relative time, size) that is described by aria-describedby and dismissable with Escape. */
export function HistoryItem({
  item,
  selected,
  onSelect,
  onDelete,
}: {
  item: ReviewListItem;
  selected?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const rowRef = useRef<HTMLLIElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const tipId = useId();

  const open = () => {
    timerRef.current = setTimeout(() => {
      const r = rowRef.current?.getBoundingClientRect();
      const top = r?.top ?? 0;
      const TIP_W = 288; // 18rem (keep in sync with .tooltip width)
      // Clamp/flip so the popup never spills off a narrow (e.g. 375px) viewport.
      const right = (r?.right ?? 0) + 8;
      const left = right + TIP_W > window.innerWidth ? Math.max(8, (r?.left ?? 0) - TIP_W - 8) : right;
      setPos({ top, left });
    }, 120); // faster than the native ~500ms title delay, slow enough to avoid scroll-by flicker
  };
  const close = () => {
    clearTimeout(timerRef.current);
    setPos(null);
  };

  // Escape dismisses the popup. Only listens while it is open.
  useEffect(() => {
    if (!pos) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pos]);

  const created = new Date(item.created_at);
  const meta = t('history.itemMeta', {
    mode: t(MODE_KEY[item.review_mode]),
    when: created.toLocaleString(i18n.language),
    lines: item.line_count ?? 0,
    size: formatBytes(item.code_bytes ?? 0),
  });

  return (
    <li ref={rowRef} className={`${styles.historyItem}${selected ? ' ' + styles.selected : ''}`}>
      <button
        type="button"
        className={styles.historyRestore}
        aria-describedby={pos ? tipId : undefined}
        onClick={() => {
          // Experimental flourish: spawn a school of background octopuses swimming out from the
          // clicked row (reuses the run-burst pipeline; OctopusBackground honors reduced-motion).
          const r = rowRef.current?.getBoundingClientRect();
          if (r) {
            const detail: BurstRect = { x: r.x, y: r.y, width: r.width, height: r.height };
            window.dispatchEvent(new CustomEvent<BurstRect>(BURST_EVENT, { detail }));
          }
          onSelect(item.id);
        }}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        <span className={styles.itemHeader}>{item.title}</span>
        {item.snippet && <span className={styles.itemBody}>{item.snippet}</span>}
      </button>
      {confirming ? (
        <span className={styles.confirmRow}>
          <button
            type="button"
            className={styles.confirmDelete}
            onClick={() => {
              setConfirming(false);
              onDelete(item.id);
            }}
          >
            {t('history.confirmDelete')}
          </button>
          <button type="button" className={styles.cancelDelete} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={styles.historyDelete}
          aria-label={t('history.delete')}
          onClick={() => setConfirming(true)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3 4.5h10M6.5 4.5V3.4a.9.9 0 0 1 .9-.9h1.2a.9.9 0 0 1 .9.9v1.1M5.2 4.5l.5 7.8a1 1 0 0 0 1 .95h2.6a1 1 0 0 0 1-.95l.5-7.8M6.8 7v3.6M9.2 7v3.6"
              stroke="currentColor"
              strokeWidth="1.1"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {pos && (
        <div
          id={tipId}
          className={styles.tooltip}
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
        >
          <span className={styles.tipHeader}>{item.title}</span>
          {item.snippet && <code className={styles.tipSnippet}>{item.snippet}</code>}
          <span className={styles.tipMeta}>{meta}</span>
          <span className={styles.tipRel}>{relativeTime(created, i18n.language)}</span>
        </div>
      )}
    </li>
  );
}
