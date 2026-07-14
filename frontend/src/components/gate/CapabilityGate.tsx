import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CapabilityStatus } from '../../types/review';
import { UnsupportedModal } from './UnsupportedModal';
import styles from './CapabilityGate.module.css';

/**
 * Gates the workspace on WebGPU capability (spec §5.2). Renders children while probing or when ok.
 *
 * On a failed probe the children (which run on-device inference) cannot mount, but the gate is no
 * longer a dead end: the two escape actions produce a *visible* result. "Continue as guest" shows a
 * confirmation that history/feedback still work without WebGPU; "Try sample code" both seeds the
 * editor (via the parent callback) and shows the sample so the user sees the product surface. The
 * UnsupportedModal also links to /preflight for the detailed capability breakdown.
 */
export function CapabilityGate({
  status,
  children,
  onContinueAsGuest,
  onTrySample,
}: {
  status: CapabilityStatus | 'probing';
  children: ReactNode;
  onContinueAsGuest?: () => void;
  onTrySample?: () => void;
}) {
  const { t } = useTranslation();
  const [acted, setActed] = useState<'guest' | 'sample' | null>(null);

  if (status === 'ok' || status === 'probing') return <>{children}</>;

  const handleGuest = onContinueAsGuest
    ? () => {
        onContinueAsGuest();
        setActed('guest');
      }
    : undefined;
  const handleSample = onTrySample
    ? () => {
        onTrySample();
        setActed('sample');
      }
    : undefined;

  return (
    <div className={styles.gate}>
      <UnsupportedModal status={status} onContinueAsGuest={handleGuest} onTrySample={handleSample} />
      {acted && (
        <p className={styles.actedNotice} role="status">
          {acted === 'guest' ? t('gate.guestConfirmed') : t('gate.sampleSeeded')}
        </p>
      )}
    </div>
  );
}
