import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import { App } from './App';
import ErrorBoundary from './components/common/ErrorBoundary';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Locale-INDEPENDENT fallback: LocaleProvider (and i18n itself) sit INSIDE <App/>, so a fallback
// that tried to translate could throw again. Plain, untranslated reload prompt keeps the last
// line of defense unconditional (review §9b — top-level boundary).
const topLevelFallback = (
  <div role="alert" style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
    <h1 style={{ fontSize: '1.25rem' }}>Something went wrong</h1>
    <p>The app hit an unexpected error. Please reload the page to continue.</p>
    <button type="button" onClick={() => window.location.reload()}>
      Reload
    </button>
  </div>
);

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={topLevelFallback}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
