import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { getAccessToken } from './auth/supabaseClient.js';
import { SamvardiqApiClient } from './api/SamvardiqApiClient.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoadingScreen } from './components/LoadingScreen.js';
import { OrganizationProvider, useOrganization, type OrganizationState } from './organizations/OrganizationContext.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NoAccessPage } from './pages/NoAccessPage.js';
import { OrganizationSelectorPage } from './pages/OrganizationSelectorPage.js';

// Section 21: constructed once, here — the composition root for the
// frontend's own single API client instance (ADR-FRONTEND-001 rule 4).
const apiClient = new SamvardiqApiClient(import.meta.env.VITE_SAMVARDIQ_API_URL, getAccessToken);

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <RootGate />
      </AuthProvider>
    </BrowserRouter>
  );
}

/** Section 18: never render a protected screen before auth state resolves. Section 6: "authenticated" only ever means a valid Supabase session — organization state is resolved entirely separately, below. */
function RootGate() {
  const { state } = useAuth();

  if (state.status === 'loading') return <LoadingScreen label="Loading…" />;

  if (state.status === 'unauthenticated') {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <OrganizationProvider apiClient={apiClient}>
      <AuthenticatedRoutes />
    </OrganizationProvider>
  );
}

function AuthenticatedRoutes() {
  const { state } = useOrganization();

  if (state.status === 'loading') return <LoadingScreen label="Loading your organizations…" />;
  if (state.status === 'no-access') {
    return (
      <Routes>
        <Route path="*" element={<NoAccessPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/organizations" element={<OrganizationSelectorPage />} />
      <Route path="/org/:organizationId" element={<DashboardPage apiClient={apiClient} />} />
      <Route path="*" element={<RootRedirect state={state} />} />
    </Routes>
  );
}

/** Section 24: exactly one eligible organization auto-selects for UX — this redirect is what makes that skip the selector page; it grants no authority itself. */
function RootRedirect({ state }: { state: Extract<OrganizationState, { status: 'selecting' | 'selected' }> }) {
  if (state.status === 'selected') return <Navigate to={`/org/${encodeURIComponent(state.selected.organizationId)}`} replace />;
  return <Navigate to="/organizations" replace />;
}
