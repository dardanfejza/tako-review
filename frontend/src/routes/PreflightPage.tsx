import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useCapabilityProbe } from '../hooks/useCapabilityProbe';
import { detectBrowser } from '../lib/deviceClass';
import styles from './PreflightPage.module.css';

/** Icon SVG components — inline to avoid import overhead on the gate. */
const CheckIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M5 10.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const XIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M5 5l10 10M15 5l-10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
/** Distinct warn glyph (triangle + bang) — not the fail X, so the state reads without colour. */
const WarnIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M10 3l8 14H2L10 3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M10 8.5v3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="10" cy="14.5" r="0.5" fill="currentColor" stroke="currentColor" />
  </svg>
);
const Spinner = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className={styles.spinner}>
    <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="30 15" />
  </svg>
);

type RowStatus = 'ok' | 'fail' | 'warn' | 'pending';

interface CapabilityRowProps {
  label: string;
  status: RowStatus;
  detail?: string;
}

/** Single capability check row with icon + label + detail. */
function CapabilityRow({ label, status, detail }: CapabilityRowProps) {
  return (
    <div className={styles.row}>
      <span className={[styles.icon, styles[status]].join(' ')} data-status={status}>
        {status === 'ok' && <CheckIcon />}
        {status === 'fail' && <XIcon />}
        {status === 'warn' && <WarnIcon />}
        {status === 'pending' && <Spinner />}
      </span>
      <div>
        <span className={styles.label}>{label}</span>
        {detail && <span className={styles.detail}>{detail}</span>}
      </div>
    </div>
  );
}

/** /preflight — standalone capability check with guidance (FE §6). */
export function PreflightPage() {
  const { t } = useTranslation();
  const probe = useCapabilityProbe();
  const browser = detectBrowser(navigator.userAgent);

  const isProbing = probe.status === 'probing';
  const isSecure = window.isSecureContext;
  const hasWorker = !isProbing && window.Worker !== undefined;

  // Derive each row from the GRANULAR probe status so a row never contradicts the failure
  // guidance beside it (a single `status === 'ok'` would mark WebGPU "Not supported" on an
  // HTTPS or adapter failure too). FE §4.3 status union: needs_https | no_webgpu | no_adapter
  // | device_init_failed | oom | ok.
  let webgpuStatus: RowStatus;
  let webgpuDetail: string;
  if (isProbing) {
    webgpuStatus = 'pending';
    webgpuDetail = t('preflight.checking');
  } else if (probe.status === 'no_webgpu') {
    // The WebGPU API itself is absent — the only true "Not supported".
    webgpuStatus = 'fail';
    webgpuDetail = t('preflight.notSupported');
  } else if (probe.status === 'needs_https') {
    // The API may exist but the probe can't reach it without a secure context — blocked, not absent.
    webgpuStatus = 'warn';
    webgpuDetail = t('preflight.webgpuBlockedInsecure');
  } else if (
    probe.status === 'no_adapter' ||
    probe.status === 'device_init_failed' ||
    probe.status === 'oom'
  ) {
    // API is available; the GPU device/adapter failed — warn so the row agrees with the modal.
    webgpuStatus = 'warn';
    webgpuDetail = t('preflight.deviceFailed');
  } else {
    webgpuStatus = 'ok';
    webgpuDetail = t('preflight.available');
  }

  return (
    <div className={styles.preflight}>
      <h1>{t('common.appName')}</h1>

      {/* Two-column layout */}
      <div className={styles.grid}>
        {/* Left column — capability cards */}
        <div className={styles.column}>
          <div className={styles.card}>
            <CapabilityRow label={t('preflight.rowWebgpu')} status={webgpuStatus} detail={webgpuDetail} />
            <CapabilityRow
              label={t('preflight.rowSecureContext')}
              status={isProbing ? 'pending' : isSecure ? 'ok' : 'fail'}
              detail={
                isProbing
                  ? t('preflight.checking')
                  : isSecure
                    ? t('preflight.secureDetail')
                    : t('preflight.notSecure')
              }
            />
          </div>
          <div className={styles.card}>
            <CapabilityRow
              label={t('preflight.rowWorker')}
              status={isProbing ? 'pending' : hasWorker ? 'ok' : 'fail'}
              detail={isProbing ? t('preflight.checking') : hasWorker ? t('preflight.available') : t('preflight.notSupported')}
            />
          </div>
        </div>

        {/* Right column — status summary card. role=status + aria-live announces the async
            probing → result transition to screen readers. */}
        <div className={[styles.column, styles.summaryColumn].join(' ')}>
          <div className={styles.card} role="status" aria-live="polite">
            {probe.status === 'ok' && (
              <>
                <p className={styles.okText}>{t('preflight.ok')}</p>
                <Link to="/" className={styles.goLink}>
                  {t('review.run')}
                </Link>
              </>
            )}
            {probe.status === 'probing' && <p className={styles.muted}>{t('common.loading')}</p>}
            {probe.status !== 'ok' && probe.status !== 'probing' && (
              // Inline region (NOT a focus-trapped aria-modal) so the diagnostic rows — the page's
              // whole point — stay reachable by screen readers. Always offers a way out so an
              // unsupported evaluator is never dead-ended (FE §6 / §5.2 guest+sample path).
              <div role="region" aria-label={t('preflight.fail', { browser })}>
                <p className={styles.failText}>{t('preflight.fail', { browser })}</p>
                <p className={styles.reason}>{t(REASON_KEY[probe.status] ?? 'gate.reasonNoWebgpu')}</p>
                <p className={styles.reason}>{t('gate.unsupportedBody')}</p>
                <div className={styles.failActions}>
                  <Link to="/" className={styles.goLink}>
                    {t('gate.continueAsGuest')}
                  </Link>
                  <Link to="/?sample=1" className={styles.secondaryLink}>
                    {t('gate.trySample')}
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-status reason copy, mirroring UnsupportedModal so the inline guidance matches the gate. */
const REASON_KEY: Partial<Record<string, string>> = {
  needs_https: 'gate.reasonNeedsHttps',
  no_webgpu: 'gate.reasonNoWebgpu',
  no_adapter: 'gate.reasonNoAdapter',
  device_init_failed: 'gate.reasonDeviceInitFailed',
  oom: 'gate.reasonOom',
};
