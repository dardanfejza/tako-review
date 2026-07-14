import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent, Ref, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { OCTOPUS_PATH_D } from '../../creatures/octopusPath';
import { BURST_EVENT, type BurstRect } from '../../creatures/burst';
import { EditorPane } from './EditorPane';
import type { CodeInputVariant, CodeInputHandle } from './CodeInput';
import styles from './WelcomeHero.module.css';

const SPLIT_KEY = 'tako.split.left';
const SPLIT_MIN = 30;
const SPLIT_MAX = 70;

function clampPct(n: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n));
}

function initialPct(): number {
  const raw = localStorage.getItem(SPLIT_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? clampPct(n) : 50;
}

export interface WelcomeHeroProps {
  code: string;
  onCodeChange: (code: string) => void;
  language: string;
  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
  validationError?: string | null;
  codeInputVariant?: CodeInputVariant;
  editorRef?: Ref<CodeInputHandle>;
  modelSelector?: ReactNode;
  /** Error banner rendered above the editor (e.g. generation failure). */
  alert?: ReactNode;
  /** When present the hero shifts left and this pane slides in on the right. */
  resultPane?: ReactNode;
  /** Hero-state affordance: jump to the split layout before any review exists. */
  onExpand?: () => void;
}

/**
 * The persistent workspace layout: a centered hero (logo + title + editor card) that, when a
 * resultPane arrives, morphs into the full-height split — editor panel left, result panel
 * right, separated by a draggable divider (30-70%, persisted). One animated grid, no remount
 * of the editor between the two states.
 */
export function WelcomeHero({
  code,
  onCodeChange,
  language,
  running,
  canRun,
  onRun,
  onCancel,
  validationError,
  codeInputVariant,
  editorRef,
  modelSelector,
  alert,
  resultPane,
  onExpand,
}: WelcomeHeroProps) {
  const { t } = useTranslation();
  const split = resultPane != null;
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [splitPct, setSplitPctState] = useState(initialPct);
  const [dragging, setDragging] = useState(false);
  const setSplitPct = useCallback((n: number) => {
    const v = clampPct(Math.round(n));
    setSplitPctState(v);
    localStorage.setItem(SPLIT_KEY, String(v));
  }, []);

  const onDividerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!split) return;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDividerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setSplitPct(((e.clientX - r.left) / r.width) * 100);
  };
  const onDividerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSplitPct(splitPct + (e.key === 'ArrowLeft' ? -2 : 2));
  };

  // Announce the run so OctopusBackground can burst octopuses outward from the editor box
  const handleRun = useCallback(() => {
    const r = editorBoxRef.current?.getBoundingClientRect();
    const detail: BurstRect = r
      ? { x: r.x, y: r.y, width: r.width, height: r.height }
      : { x: 0, y: 0, width: 0, height: 0 };
    window.dispatchEvent(new CustomEvent<BurstRect>(BURST_EVENT, { detail }));
    onRun();
  }, [onRun]);

  return (
    <div
      ref={rootRef}
      className={styles.welcomeHero}
      data-split={split ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      style={split ? { gridTemplateColumns: `${splitPct}fr 1px ${100 - splitPct}fr` } : undefined}
    >
      <div className={styles.heroCol}>
        {/* Logo + title collapse (height + fade) and leave the a11y tree once a result is
            showing — the sidebar carries the brand in the split state */}
        <div className={styles.heroHead} aria-hidden={split || undefined}>
          <div className={styles.heroHeadInner}>
            <span className={styles.heroLogo} aria-hidden="true">
              <svg viewBox="-4 -4 108 132" aria-hidden="true">
                <path fillRule="evenodd" fill="var(--brand)" d={OCTOPUS_PATH_D} />
              </svg>
            </span>
            <h2 className={styles.heroTitle}>Let's Code</h2>
          </div>
        </div>
        {alert}
        <div className={styles.editorWrapper} ref={editorBoxRef}>
          {!split && onExpand && (
            <button
              type="button"
              className={styles.expandButton}
              onClick={onExpand}
              aria-label={t('workspace.expand')}
              title={t('workspace.expand')}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <EditorPane
            code={code}
            onCodeChange={onCodeChange}
            language={language}
            running={running}
            canRun={canRun}
            onRun={handleRun}
            onCancel={onCancel}
            validationError={validationError}
            codeInputVariant={codeInputVariant}
            editorRef={editorRef}
            modelSelector={modelSelector}
            variant={split ? 'panel' : 'card'}
          />
        </div>
      </div>
      {/* Always mounted (the grid needs its middle track); only acts as a separator in split */}
      <div
        className={styles.divider}
        role={split ? 'separator' : undefined}
        aria-orientation={split ? 'vertical' : undefined}
        aria-valuenow={split ? splitPct : undefined}
        aria-valuemin={split ? SPLIT_MIN : undefined}
        aria-valuemax={split ? SPLIT_MAX : undefined}
        aria-label={split ? t('workspace.resizePanels') : undefined}
        tabIndex={split ? 0 : -1}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={() => setDragging(false)}
        onKeyDown={onDividerKeyDown}
      >
        <span className={styles.dividerHandle} aria-hidden="true">
          <svg viewBox="0 0 4 16" width="4" height="16">
            <circle cx="2" cy="2" r="1.4" fill="currentColor" />
            <circle cx="2" cy="8" r="1.4" fill="currentColor" />
            <circle cx="2" cy="14" r="1.4" fill="currentColor" />
          </svg>
        </span>
      </div>
      <div className={styles.resultCol}>
        <div className={styles.resultInner}>{resultPane}</div>
      </div>
    </div>
  );
}
