import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import styles from './Disclaimer.module.css';

/** Exit transition is ~400ms (CSS); the fallback covers a transitionend that never fires
 *  (display:none ancestors, interrupted transitions) so the card can't get stuck half-gone. */
const DISMISS_FALLBACK_MS = 600;

export interface DisclaimerProps {
  /** Flips true after the user submits their first review; the card animates off-screen
   *  (down-right + fade) and unmounts. Under prefers-reduced-motion it hides immediately. */
  dismissed?: boolean;
}

/**
 * Standing disclaimers (FE §1/§11/§15): AI-generated (verify), on-device + data-collected (no
 * privacy claim), and the mandatory dual-license — Qwen2 base (Apache-2.0) AND Gemma Terms of
 * Use (training-data lineage). NOT "Gemma derivative". The telemetry opt-out toggle lives in the
 * sidebar SettingsMenu (next to the account control), not here.
 */
export function Disclaimer({ dismissed = false }: DisclaimerProps) {
  const { t } = useTranslation();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [gone, setGone] = useState(false);
  const leaving = dismissed && !gone;

  useEffect(() => {
    if (!dismissed || gone) return;
    if (reducedMotion) {
      setGone(true); // skip the animation entirely — hide on the next render
      return;
    }
    const fallback = window.setTimeout(() => setGone(true), DISMISS_FALLBACK_MS);
    return () => window.clearTimeout(fallback);
  }, [dismissed, gone, reducedMotion]);

  if (gone) return null;
  return (
    <footer
      className={`${styles.disclaimer} ${leaving ? styles.dismissed : ''}`}
      // While animating out the card is decorative: hide it from AT and ignore clicks
      // (pointer-events: none rides on the .dismissed class).
      aria-hidden={leaving || undefined}
      onTransitionEnd={leaving ? () => setGone(true) : undefined}
    >
      <dl className={styles.rows}>
        <dt>{t('disclaimer.aiGeneratedLabel')}</dt>
        <dd>{t('disclaimer.aiGenerated')}</dd>
        <dt>{t('disclaimer.onDeviceLabel')}</dt>
        <dd>{t('disclaimer.onDevice')}</dd>
        <dt>{t('disclaimer.licensesLabel')}</dt>
        <dd>{t('disclaimer.licenses')}</dd>
      </dl>
    </footer>
  );
}
