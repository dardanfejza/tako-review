import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryProvider } from './providers/QueryProvider';
import { AuthProvider } from './providers/AuthProvider';
import { LocaleProvider } from './providers/LocaleProvider';
import { EngineProvider } from './providers/EngineProvider';
import { ReviewWorkspace } from './routes/ReviewWorkspace';
import { PreflightPage } from './routes/PreflightPage';
import './i18n';

/**
 * Provider composition + routing (FE §6). Two routes only: /preflight and / (the workspace).
 * GitHub OAuth redirects to the backend and 302s to / (no SPA /auth/callback route — §9).
 */
export function App() {
  return (
    <QueryProvider>
      <AuthProvider>
        <LocaleProvider>
          <EngineProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/preflight" element={<PreflightPage />} />
                <Route path="/" element={<ReviewWorkspace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </EngineProvider>
        </LocaleProvider>
      </AuthProvider>
    </QueryProvider>
  );
}
