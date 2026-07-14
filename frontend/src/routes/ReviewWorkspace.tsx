import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../providers/EngineProvider';
import { useAuth } from '../providers/AuthProvider';
import { useLocale } from '../providers/LocaleProvider';
import { useCapabilityProbe, type CapabilityProbeDeps } from '../hooks/useCapabilityProbe';
import { useReviewTelemetry } from '../hooks/useReviewTelemetry';
import { useLocalStoragePref } from '../hooks/useLocalStoragePref';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useReviewsInfinite, useCreateReview, useDeleteReview, useReviewDetail } from '../queries/useReviews';
import { useFeedback } from '../queries/useFeedback';
import { getOrCreateClientId } from '../lib/clientId';
import { AuthErrorBanner } from '../components/layout/AuthErrorBanner';
import { OctopusBackground } from '../components/layout/OctopusBackground';
import { Disclaimer } from '../components/layout/Disclaimer';
import { CapabilityGate } from '../components/gate/CapabilityGate';
import { DownloadOverlay } from '../components/download/DownloadOverlay';
import { Sidebar } from '../components/sidebar/Sidebar';
import ErrorBoundary from '../components/common/ErrorBoundary';
import { WelcomeHero } from '../components/editor/WelcomeHero';
import { SAMPLE_CODE } from '../components/editor/SampleCodeButton';
import { ResultPane } from '../components/result/ResultPane';
import type { CodeInputVariant, CodeInputHandle } from '../components/editor/CodeInput';
import { codeTextBytes, MAX_CODE_BYTES, type ReviewDraft } from '../inference/reviewPipeline';
import { stripLineNumbers } from '../lib/lineNumber';
import { throttleLatest } from '../lib/throttle';
import type { Rating, ReasonTag, ReviewFeedback, ReviewMode, Timing } from '../types/api';
import styles from './ReviewWorkspace.module.css';

interface LiveResult {
  output: string;
  timing: Timing | null;
  chunk?: { index: number; total: number };
}

const WORKSPACE_STATES = new Set(['READY', 'REVIEWING', 'RESULT', 'SAVE_FAILED', 'REVIEW_ERROR', 'REVIEW_CANCELLED']);
const DOWNLOAD_STATES = new Set(['DOWNLOADING', 'DL_CANCELLED', 'DOWNLOAD_ERROR']);

/** Streaming UI flush cadence. Each flush re-parses the whole markdown buffer (react-markdown +
 *  sanitize), so flushing per token is O(n^2) main-thread work over a generation; 10Hz looks
 *  identical to the eye while cutting that cost ~60% and decoupling it from tok/s. */
const TOKEN_FLUSH_MS = 100;

/**
 * The main view (FE §6): wires the capability probe + engine state machine + history/feedback/
 * telemetry queries into the sidebar/editor/result layout. `probeDeps` and `codeInputVariant`
 * are test seams.
 */
export function ReviewWorkspace({
  probeDeps,
  codeInputVariant,
}: {
  probeDeps?: CapabilityProbeDeps;
  codeInputVariant?: CodeInputVariant;
}) {
  const { t } = useTranslation();
  const engine = useEngine();
  const auth = useAuth();
  const { locale } = useLocale();
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const editorRef = useRef<CodeInputHandle>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStoragePref('tako.sidebar.collapsed', false);
  const isNarrow = useMediaQuery('(max-width: 900px)');
  const [code, setCode] = useState('');
  // Review mode is fixed (the mode picker was removed as low-value); kept for the stored record + prompt.
  const mode: ReviewMode = 'bugs';
  // MVP: python-only (FE §6) — a language selector is future work. The @codemirror/lang-javascript
  // pack stays wired in CodeMirrorInput so adding a picker later needs no editor change.
  const [language] = useState('python');
  const [result, setResult] = useState<LiveResult | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [currentFeedback, setCurrentFeedback] = useState<ReviewFeedback | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  // Sticky: flips true on the session's first submitted run and never back — dismisses the
  // standing Disclaimer card (it animates off-screen and unmounts).
  const [submitted, setSubmitted] = useState(false);
  // Hero "expand" affordance: jump to the split layout before any review exists (the right
  // pane shows an empty-state hint until a result arrives). Reset by New review.
  const [expanded, setExpanded] = useState(false);

  const dispatchEngine = engine.dispatch;
  const onDeviceLost = useCallback(() => dispatchEngine({ type: 'DEVICE_LOST' }), [dispatchEngine]);
  const probe = useCapabilityProbe({ ...probeDeps, onDeviceLost });
  const reprobe = probe.reprobe;

  // Probe result drives the engine state machine (PREFLIGHT → CAPABLE / UNSUPPORTED).
  // Only dispatch from PREFLIGHT: PROBE_OK/PROBE_FAIL are valid only there, and `engine` being a
  // dep re-runs this on every state tick — without the guard we'd re-dispatch a now-ignored event
  // on each render (the reducer's dev-warning would cry wolf). DEVICE_LOST recovery uses the
  // separate reprobe/REPROBE_* path below.
  useEffect(() => {
    if (probe.status === 'probing' || engine.state !== 'PREFLIGHT') return;
    engine.dispatch({ type: probe.status === 'ok' ? 'PROBE_OK' : 'PROBE_FAIL' });
  }, [probe.status, engine]);

  // FE §7: a mid-session GPU loss must never dead-end. On entering DEVICE_LOST, re-probe once —
  // a healthy adapter returns to CAPABLE (reload the model), a failed probe drops to UNSUPPORTED.
  useEffect(() => {
    if (engine.state !== 'DEVICE_LOST') return;
    let cancelled = false;
    void reprobe().then((status) => {
      if (!cancelled) dispatchEngine({ type: status === 'ok' ? 'REPROBE_OK' : 'REPROBE_FAIL' });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.state]);

  // Emit model_load + generation beacons off the engine state machine (FE §12).
  useReviewTelemetry({
    state: engine.state,
    draft,
    deviceClass: probe.deviceClass,
    webgpuSupported: probe.status === 'ok',
    loadMs: engine.loadMs,
    cacheHit: engine.loadProgress?.cacheHit,
    downloadErrorKind: engine.downloadErrorKind,
    lastGenFailure: engine.lastGenFailure,
    lastGenChunks: engine.lastGenChunks,
  });

  // Auto-load when the model is already cached (no surprise ~1 GB download): on first reaching
  // CAPABLE, delegate to engine.autoLoad(), which soft-probes the WebLLM cache, takes the cross-tab
  // presence slot (N tabs must not each allocate ~1 GB VRAM), and single-flights the
  // load so it can't race a manual Load-model click. First-time visitors still gate the download
  // behind the explicit button.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (engine.state !== 'CAPABLE' || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    void engine.autoLoad();
  }, [engine]);

  // Gate the history list behind an established principal: before the auto-guest session exists
  // `auth.user` is null and a fetch would 401; the query refetches when `user` flips truthy.
  const reviews = useReviewsInfinite(20, !!auth.user);
  const createReview = useCreateReview();
  const deleteReview = useDeleteReview();
  const feedback = useFeedback();
  const detail = useReviewDetail(restoreId);

  // Restore: hydrate the result pane from a fetched record (no re-inference — FE §8.B).
  // Hydration is keyed on the restored record's *id*, NOT on detail.data's object identity:
  // a feedback vote (now patched into the same cache key, but still) or any structural-sharing
  // churn yields a new object whose identity change must NOT re-hydrate and wipe in-progress
  // edits (regression: HIGH "voting re-fires restore effect, wipes edits" — commit c459604).
  const lastHydratedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detail.data) return;
    // Restoring mid-run would show B's code in the editor while A's stream renders and A gets
    // saved (MED "restore during REVIEWING corrupts workspace"). The reducer no-ops RESTORE in
    // REVIEWING, but the state setters below would still fire — guard the whole effect.
    if (engine.state === 'REVIEWING') return;
    const d = detail.data;
    if (d.id === lastHydratedIdRef.current) return; // same record already on screen — don't re-hydrate
    lastHydratedIdRef.current = d.id;
    setCode(stripLineNumbers(d.code_text)); // stored code_text is line-numbered; show RAW in the editor

    setResult({ output: d.review_output, timing: d.timing });
    setReviewId(d.id);
    setCurrentFeedback(d.feedback);
    dispatchEngine({ type: 'RESTORE' });
    // Depend on the loaded record + the STABLE dispatch only. Depending on the whole `engine`
    // re-fired this on every state tick, re-hydrating (and resetting) the editor mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, dispatchEngine]);

  const save = useCallback(
    (d: ReviewDraft) => {
      createReview.mutate(
        { ...d, client_id: clientId, device_class: probe.deviceClass },
        {
          onSuccess: (record) => setReviewId(record.id),
          onError: () => engine.dispatch({ type: 'SAVE_FAILED' }),
        },
      );
    },
    [createReview, clientId, probe.deviceClass, engine],
  );

  const onRun = useCallback(async () => {
    setValidationError(null);
    // Fail fast: the server caps code_text at 256 KB. Refuse oversized input here, before a
    // full on-device inference, rather than wasting the compute on a POST that would 422.
    if (codeTextBytes(code) > MAX_CODE_BYTES) {
      setValidationError(t('errors.tooLarge'));
      return;
    }
    setSubmitted(true); // first accepted run → dismiss the disclaimer card
    setReviewId(null);
    setRestoreId(null); // detach from any restored record: this run creates & auto-selects a NEW entry
    lastHydratedIdRef.current = null; // a later restore of the same id must re-hydrate (not be skipped)
    setDraft(null);
    setCurrentFeedback(null);
    setResult({ output: '', timing: null });
    const pushToken = throttleLatest<string>(
      (buffer) => setResult((r) => ({ output: buffer, timing: null, chunk: r?.chunk })),
      TOKEN_FLUSH_MS,
    );
    const d = await engine.run({
      code,
      mode,
      locale,
      language,
      onToken: pushToken,
      onChunk: (chunk) => setResult((r) => ({ output: r?.output ?? '', timing: null, chunk })),
    });
    if (!d) {
      pushToken.flush(); // cancel/error: keep the last partial tokens visible
      return; // inputs re-enabled by the machine
    }
    pushToken.cancel(); // drop any stale partial — the full output lands next
    setDraft(d);
    setResult({ output: d.review_output, timing: d.timing });
    save(d);
  }, [engine, code, mode, locale, language, save, t]);

  const retrySave = useCallback(() => {
    if (!draft) return;
    engine.dispatch({ type: 'SAVE_RETRY_OK' });
    save(draft);
  }, [draft, engine, save]);

  const onNewReview = useCallback(() => {
    // Abort an in-flight generation first so "home"/New review fully clears state back to the
    // post-model-load (READY) state — cancel() is a no-op when nothing is running.
    if (engine.state === 'REVIEWING') engine.cancel();
    setCode('');
    setResult(null);
    setReviewId(null);
    setDraft(null);
    setCurrentFeedback(null);
    setRestoreId(null);
    setExpanded(false); // back to the centered hero
    lastHydratedIdRef.current = null; // a later restore of the same id must re-hydrate
    engine.dispatch({ type: 'NEW_REVIEW' });
  }, [engine]);

  const onVote = useCallback(
    (rating: Rating, tags: ReasonTag[]) => {
      if (!reviewId) return;
      setVoteError(null);
      const prev = currentFeedback; // for rollback if the POST fails
      setCurrentFeedback({ rating, reason_tags: tags }); // optimistic
      feedback.mutate(
        { session_id: reviewId, rating, reason_tags: tags },
        {
          // Roll back the optimistic mark and surface a brief hint so a failed POST doesn't read
          // as a registered vote (LOW "onVote no rollback"), mirroring useDeleteReview's pattern.
          onError: () => {
            setCurrentFeedback(prev);
            setVoteError(t('errors.generic'));
          },
        },
      );
    },
    [reviewId, feedback, currentFeedback, t],
  );

  const state = engine.state;
  // The desktop rail is ignored on narrow screens (drawer shows full content) and while a save
  // failed (so the history-list Retry stays reachable). The persisted pref is left untouched.
  const effectiveCollapsed = sidebarCollapsed && !isNarrow && state !== 'SAVE_FAILED';
  const items = reviews.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={styles.appShell}>
      <OctopusBackground
        dimmed={WORKSPACE_STATES.has(state)}
        calm={state === 'REVIEWING' || DOWNLOAD_STATES.has(state)}
      />
      <Sidebar
        items={items}
        isLoading={reviews.isLoading}
        isError={reviews.isError}
        hasMore={reviews.hasNextPage}
        selectedId={reviewId}
        saveFailed={state === 'SAVE_FAILED'}
        onRetrySave={retrySave}
        onRetryLoad={() => void reviews.refetch()}
        onSelect={setRestoreId}
        onDelete={(id) => deleteReview.mutate(id)}
        onLoadMore={() => void reviews.fetchNextPage()}
        onNewReview={onNewReview}
        collapsed={effectiveCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        showBody={WORKSPACE_STATES.has(state)}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className={styles.rightCol}>
        <button
          type="button"
          className={styles.drawerToggle}
          aria-label={t('sidebar.open')}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        <AuthErrorBanner />

        <CapabilityGate
          status={probe.status}
          onContinueAsGuest={auth.continueAsGuest}
          onTrySample={() => setCode(SAMPLE_CODE)}
        >
          {state === 'CAPABLE' && (
            <DownloadOverlay ready onStart={() => void engine.load()} />
          )}

          {state === 'DEVICE_LOST' && (
            <div className={styles.deviceLost} role="alert">
              <p>{t('errors.deviceLost')}</p>
            </div>
          )}

          {DOWNLOAD_STATES.has(state) && (
            <DownloadOverlay
              progress={engine.loadProgress?.progress ?? 0}
              statusText={engine.loadProgress?.text}
              cacheHit={engine.loadProgress?.cacheHit}
              cancelled={state === 'DL_CANCELLED'}
              // C2: surface the classified load-failure kind so disk-full shows the quota guidance
              // instead of the generic connection message. Only in the error state — passing `kind`
              // is what puts the overlay into its error branch.
              kind={state === 'DOWNLOAD_ERROR' ? (engine.downloadErrorKind ?? 'cdn') : undefined}
              onRetry={() => void engine.load()}
              onResume={() => void engine.load()}
              onCancel={engine.cancel}
            />
          )}

          {WORKSPACE_STATES.has(state) && (
            <WelcomeHero
              code={code}
              onCodeChange={setCode}
              language={language}
              running={state === 'REVIEWING'}
              canRun={code.trim().length > 0}
              onRun={() => void onRun()}
              onCancel={engine.cancel}
              validationError={validationError}
              codeInputVariant={codeInputVariant}
              editorRef={editorRef}
              alert={
                state === 'REVIEW_ERROR' || detail.isError || voteError ? (
                  <>
                    {state === 'REVIEW_ERROR' && (
                      <p role="alert" className={styles.workspaceAlert}>{t('errors.generation')}</p>
                    )}
                    {/* History restore failed (404/network): tell the user instead of failing
                        silently — wires the previously-dead errors.notFound key. */}
                    {detail.isError && (
                      <p role="alert" className={styles.workspaceAlert}>{t('errors.notFound')}</p>
                    )}
                    {/* Optimistic vote rolled back on a failed POST (LOW "onVote no rollback"). */}
                    {voteError && (
                      <p role="alert" className={styles.workspaceAlert}>{voteError}</p>
                    )}
                  </>
                ) : undefined
              }
              onExpand={() => setExpanded(true)}
              resultPane={
                result ? (
                  // Untrusted model output is rendered as markdown here; a render crash must not
                  // take down the editor + the user's code. resetKeys=[reviewId] clears the
                  // error when a different review is shown/run.
                  <ErrorBoundary
                    resetKeys={[reviewId]}
                    fallback={
                      <p role="alert" className={styles.workspaceAlert}>{t('errors.generic')}</p>
                    }
                  >
                    <ResultPane
                      content={result.output}
                      timing={result.timing}
                      chunk={result.chunk}
                      reviewId={reviewId}
                      running={state === 'REVIEWING'}
                      cancelled={state === 'REVIEW_CANCELLED'}
                      saving={createReview.isPending}
                      saveFailed={state === 'SAVE_FAILED'}
                      currentFeedback={currentFeedback}
                      onVote={onVote}
                      onCitationClick={(range) => editorRef.current?.scrollToLine(range.from, range.to)}
                    />
                  </ErrorBoundary>
                ) : expanded ? (
                  // Expanded-before-running: same split layout, nothing to review yet.
                  <div className={styles.emptyResultPane}>
                    <p>{t('review.emptyPane')}</p>
                  </div>
                ) : undefined
              }
            />
          )}
        </CapabilityGate>

        {/* Dismiss the card once the user engages: a submitted run OR opening a history item
            (restoreId flips on click, before the detail loads) — not only on Run. */}
        <Disclaimer dismissed={submitted || restoreId !== null} />
      </div>
    </div>
  );
}
