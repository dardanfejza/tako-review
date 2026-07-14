import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './TipsCarousel.module.css';

/** Tip catalog: i18n key (tips.<key>.title/.desc) + a small decorative icon. The tips tour
 *  features an evaluator wouldn't discover unaided: citation jumps, keyboard run, JA-first
 *  model, randomized sample deck, history sync, auto-chunking. */
const TIPS = [
  {
    key: 't1',
    icon: (
      // crosshair target — citation jump
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="10" cy="10" r="5.5" />
        <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" />
        <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" />
      </g>
    ),
  },
  {
    key: 't2',
    icon: (
      // keyboard return key
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5" width="15" height="10" rx="2" />
        <path d="M13.5 8.5v2h-6M9 9l-1.5 1.5L9 12" />
      </g>
    ),
  },
  {
    key: 't3',
    icon: (
      // globe
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="6.5" />
        <path d="M3.5 10h13M10 3.5c2.2 1.8 3.2 4 3.2 6.5s-1 4.7-3.2 6.5c-2.2-1.8-3.2-4-3.2-6.5s1-4.7 3.2-6.5z" />
      </g>
    ),
  },
  {
    key: 't4',
    icon: (
      // shuffle — randomized deck
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6h3l8 8h4M2.5 14h3l2.5-2.5M11 8.5L13.5 6h4M15 3.5L17.5 6 15 8.5M15 11.5l2.5 2.5-2.5 2.5" />
      </g>
    ),
  },
  {
    key: 't5',
    icon: (
      // clock — history
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="10" cy="10" r="6.5" />
        <path d="M10 6.5V10l2.5 1.8" />
      </g>
    ),
  },
  {
    key: 't6',
    icon: (
      // stacked sections — chunking
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2.5l7 3.5-7 3.5-7-3.5 7-3.5zM3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" />
      </g>
    ),
  },
] as const;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.matchMedia?.(REDUCED_MOTION_QUERY).matches);
}

/**
 * "Did you know?" tips panel shown during the ~1 GB download (FE §10): one tip at a time with a
 * "1 of 3" pager and prev/next arrows; auto-rotates unless reduced motion. aria-live=polite so
 * screen readers announce changes without interrupting; the media query is observed live —
 * toggling the OS setting mid-download stops / restarts rotation — unless an explicit
 * `reducedMotion` override is passed (tests / controlled use). Manual arrows always work.
 */
export function TipsCarousel({
  intervalMs = 15000,
  reducedMotion,
}: {
  intervalMs?: number;
  reducedMotion?: boolean;
}) {
  const { t } = useTranslation();
  const [mqReduced, setMqReduced] = useState(prefersReducedMotion);
  const [index, setIndex] = useState(0);

  // Subscribe to prefers-reduced-motion so flipping the OS setting mid-download takes effect.
  // Skipped when controlled via the `reducedMotion` prop.
  useEffect(() => {
    if (reducedMotion !== undefined || typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    setMqReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMqReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [reducedMotion]);

  const reduced = reducedMotion ?? mqReduced;

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % TIPS.length), intervalMs);
    return () => clearInterval(id);
  }, [reduced, intervalMs]);

  return (
    <section className={styles.tipsCarousel} aria-label={t('download.didYouKnow')}>
      <div className={styles.tipsHeader}>
        <span className={styles.tipsBulb} aria-hidden="true">
          <svg viewBox="0 0 20 20" width="16" height="16">
            <path
              d="M10 2a5.5 5.5 0 00-3 10.1c.6.4 1 1 1 1.7v.7h4v-.7c0-.7.4-1.3 1-1.7A5.5 5.5 0 0010 2zM8.5 16.5h3M9 18.5h2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className={styles.tipsTitle}>{t('download.didYouKnow')}</span>
        <span className={styles.tipsPager}>
          {t('download.tipPage', { current: index + 1, total: TIPS.length })}
        </span>
        <button
          type="button"
          className={styles.tipsArrow}
          aria-label={t('download.prevTip')}
          onClick={() => setIndex((i) => (i - 1 + TIPS.length) % TIPS.length)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.tipsArrow}
          aria-label={t('download.nextTip')}
          onClick={() => setIndex((i) => (i + 1) % TIPS.length)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {/* All tips share one grid cell: the stack is always as tall as the TALLEST tip, so the
          card never resizes while rotating. Inactive tips are visibility-hidden (kept in layout,
          dropped from the a11y tree). */}
      <div className={styles.tipStack} aria-live="polite">
        {TIPS.map((tip, i) => (
          <div
            key={tip.key}
            className={styles.tipBody}
            style={{ visibility: i === index ? 'visible' : 'hidden' }}
          >
            <span className={styles.tipIcon} aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18">{tip.icon}</svg>
            </span>
            <div className={styles.tipText}>
              <p className={styles.tipTitle}>{t(`tips.${tip.key}.title`)}</p>
              <p className={styles.tipDesc}>{t(`tips.${tip.key}.desc`)}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
