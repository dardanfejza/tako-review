import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProgressBar } from './ProgressBar';
import { TipsCarousel } from './TipsCarousel';
import { MODEL_HF_URL } from '../../config/appConfig';
import styles from './DownloadOverlay.module.css';

/** The kind of model-load failure (CONTRACT C2). `cdn` = network/fetch; `quota` = storage full;
 *  `other` = anything else. Presence of `kind` means the overlay is in its error branch. */
export type DownloadErrorKind = 'cdn' | 'quota' | 'other';

export interface DownloadOverlayProps {
  progress?: number;
  statusText?: string;
  cacheHit?: boolean;
  cancelled?: boolean;
  /** Set to the failure kind to show the error branch (CONTRACT C2). */
  kind?: DownloadErrorKind;
  /** Pre-download mirror card: imperative title + description + Load-model CTA. */
  ready?: boolean;
  onStart?: () => void;
  onRetry?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}

const ERROR_KEY: Record<DownloadErrorKind, string> = {
  cdn: 'download.cdnError',
  quota: 'download.quotaError',
  other: 'download.otherError',
};

const LEARN_MORE_URL = MODEL_HF_URL;

function formatDuration(s: number): string {
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** WebLLM's progress text embeds its own "NN% completed, N secs elapsed. It can take a while…"
 *  tail — redundant with our bar/percentage and elapsed line (and it disagrees with them, since
 *  the clocks differ). Keep only the informative prefix ("Fetching param cache[18/30]: …").
 *  Known tradeoff: the prefix is English-only telemetry; the surrounding copy (title, note,
 *  tips, timing) is fully localized. */
function cleanStatusText(raw?: string): string | undefined {
  return raw?.replace(/\s*\d+% completed[\s\S]*$/, '').trim() || undefined;
}

/** WebLLM says "Loading model from cache[…]" when the weights are already on disk (vs
 *  "Fetching param cache[…]" for a network download). */
const FROM_CACHE_RE = /loading model from cache/i;

/**
 * In-page model download/ready card (spec §5.6). This is NOT a modal: the surrounding chrome
 * (sidebar, EN/JP toggle, account) stays reachable, so it is a non-blocking named region — not an
 * aria-modal dialog with a focus trap that would strand keyboard / SR users for the whole
 * multi-minute download. Critical progress info on top (bar + % + status + elapsed/ETA),
 * education below (offline note folded into the ready description, browsable Did-you-know tips).
 * When the progress branch swaps to the error branch, focus moves to the alert so SR/keyboard
 * users are not left on a control that no longer exists.
 */
export function DownloadOverlay({
  progress = 0,
  statusText,
  cacheHit,
  cancelled,
  kind,
  ready,
  onStart,
  onRetry,
  onResume,
  onCancel,
}: DownloadOverlayProps) {
  const { t } = useTranslation();
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Elapsed ticks once per second; the ETA extrapolates the observed rate. Both stop while
  // cancelled (the download is paused, an estimate would drift toward nonsense).
  const startRef = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ready || cancelled || cacheHit || kind) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ready, cancelled, cacheHit, kind]);

  // Sticky: once any report says the weights come from cache, the title stays "Loading…"
  // even through later phases (shader compile) whose text doesn't mention the cache.
  const sawCacheRef = useRef(false);
  if (statusText && FROM_CACHE_RE.test(statusText)) sawCacheRef.current = true;
  const loadingFromCache = sawCacheRef.current;

  // Progress -> error branch swap: move focus to the alert (the Cancel button it may have been
  // on no longer exists).
  useEffect(() => {
    if (kind) errorRef.current?.focus();
  }, [kind]);

  if (kind) {
    return (
      <section className={styles.downloadOverlay} aria-labelledby="download-error-title">
        <p
          ref={errorRef}
          id="download-error-title"
          className={styles.downloadError}
          role="alert"
          tabIndex={-1}
        >
          {t(ERROR_KEY[kind])}
        </p>
        {onRetry && (
          <button type="button" className={styles.downloadBtn} onClick={onRetry}>
            {t('common.retry')}
          </button>
        )}
      </section>
    );
  }

  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const elapsed = Math.max(0, Math.floor((now - startRef.current) / 1000));
  const remaining =
    !cancelled && progress >= 0.05 && elapsed >= 2
      ? Math.ceil((elapsed * (1 - progress)) / progress)
      : null;

  return (
    <section className={styles.downloadOverlay} aria-labelledby="download-title">
      <div className={styles.downloadHeader}>
        <span className={styles.downloadIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26">
            <path
              d="M7 17a4.5 4.5 0 01-.9-8.9 5.5 5.5 0 0110.6-1.4A4.2 4.2 0 0117 15M12 11v7m0 0l-2.8-2.8M12 18l2.8-2.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className={styles.downloadHeaderBody}>
          <h2 id="download-title" className={styles.downloadTitle}>
            {ready
              ? t('download.readyTitle')
              : loadingFromCache
                ? t('download.loadingTitle')
                : t('download.title')}
          </h2>
          {ready ? (
            <p className={styles.readyDesc}>
              {t('download.readyDesc')} {t('download.worksOffline')} {t('download.fasterReload')}
            </p>
          ) : cacheHit ? (
            <p className={styles.cacheHit}>{t('download.loadedFromCache')}</p>
          ) : (
            <>
              <div className={styles.progressRow}>
                <ProgressBar value={progress} />
                <span className={styles.progressPct}>{pct}%</span>
              </div>
              {/* Always rendered (nbsp placeholder) so the card height is stable from the
                  first frame — no layout shift when the first progress report lands */}
              <p className={styles.downloadStatus}>{cleanStatusText(statusText) ?? ' '}</p>
              <p className={styles.downloadTiming}>
                {t('download.elapsed', { time: formatDuration(elapsed) })}
                {remaining != null && (
                  <> · {t('download.remaining', { time: formatDuration(remaining) })}</>
                )}
              </p>
            </>
          )}
        </div>
      </div>

      <hr className={styles.downloadDivider} />

      <TipsCarousel />

      <div className={styles.downloadFooter}>
        <a
          className={styles.learnMore}
          href={LEARN_MORE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('download.learnMore')}
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M6 3h7v7M13 3L7 9M11 13H3V5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
        {ready && onStart ? (
          <button type="button" className={styles.downloadBtnPrimary} onClick={onStart}>
            {t('download.loadModel')}
          </button>
        ) : (
          <>
            {cancelled && onResume && (
              <button type="button" className={styles.downloadBtn} onClick={onResume}>
                {t('download.resume')}
              </button>
            )}
            {!cancelled && onCancel && (
              <button type="button" className={styles.downloadBtn} onClick={onCancel}>
                {t('common.cancel')}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
