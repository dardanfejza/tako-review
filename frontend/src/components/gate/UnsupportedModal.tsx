import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CapabilityStatus } from '../../types/review';
import styles from './UnsupportedModal.module.css';

const REASON_KEY: Partial<Record<CapabilityStatus, string>> = {
  needs_https: 'gate.reasonNeedsHttps',
  no_webgpu: 'gate.reasonNoWebgpu',
  no_adapter: 'gate.reasonNoAdapter',
  device_init_failed: 'gate.reasonDeviceInitFailed',
  oom: 'gate.reasonOom',
};

/**
 * In-page region shown when WebGPU is unavailable (spec §5.2). It is NOT a modal: the surrounding
 * chrome (sidebar, EN/JP toggle, account) must stay reachable for keyboard / SR users, so this is a
 * non-blocking `role="region"` with an `aria-live` reason — not an `aria-modal` dialog with a focus
 * trap (which would lock those users out of the still-visible UI for the whole session). It names
 * the specific reason and always offers the guest / sample-code path plus a link to the detailed
 * preflight check so an evaluator is never dead-ended.
 */
export function UnsupportedModal({
  status,
  onContinueAsGuest,
  onTrySample,
}: {
  status: CapabilityStatus;
  onContinueAsGuest?: () => void;
  onTrySample?: () => void;
}) {
  const { t } = useTranslation();
  // A named <section> has an implicit role="region"; the aria-labelledby supplies the name, so
  // keyboard / SR users keep access to the surrounding chrome (this is NOT an aria-modal).
  return (
    <section className={styles.unsupportedModal} aria-labelledby="unsupported-title">
      <h2 id="unsupported-title">{t('gate.unsupportedTitle')}</h2>
      <p role="alert">{t(REASON_KEY[status] ?? 'gate.reasonNoWebgpu')}</p>
      <p>{t('gate.unsupportedBody')}</p>
      <div className={styles.unsupportedActions}>
        {onContinueAsGuest && (
          <button type="button" className={styles.unsupportedBtn} onClick={onContinueAsGuest}>
            {t('gate.continueAsGuest')}
          </button>
        )}
        {onTrySample && (
          <button type="button" className={styles.unsupportedBtn} onClick={onTrySample}>
            {t('gate.trySample')}
          </button>
        )}
      </div>
      <Link className={styles.detailLink} to="/preflight">
        {t('gate.seeDetailedCheck')}
      </Link>
    </section>
  );
}
