import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ApiError, type Goal, type SamvardiqApiClient } from '../api/SamvardiqApiClient.js';
import { useAuth } from '../auth/AuthContext.js';
import { useOrganization } from '../organizations/OrganizationContext.js';

/**
 * Section 33/34 — the protected dashboard shell. Deliberately minimal
 * (no goal management UI — section 14). Its entire purpose is proving
 * the full real chain: browser login -> bearer token -> Fastify ->
 * W3 verification -> W2/W4 trusted organization -> application service
 * -> PostgreSQL/RLS, via ONE real protected call.
 *
 * Reads `:organizationId` from the URL, NOT from OrganizationContext's
 * "selected" value — section 34: a client-side route/state guard is UX
 * only, never the actual authority. If a user hand-edits the URL to a
 * DIFFERENT organization than the one they're a member of (section 41,
 * AC), this component still only ever calls the backend with whatever
 * the URL says, and the backend's own fresh authorization check is what
 * actually denies it — proven in test/pages/DashboardPage.test.tsx.
 */
export function DashboardPage({ apiClient }: { apiClient: SamvardiqApiClient }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const { state, refresh } = useOrganization();
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    apiClient
      .listGoals(organizationId)
      .then((result) => {
        if (active) setGoals(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Section 28/AD/AE: any denial here (revoked membership, suspended
        // identity, or a hand-edited URL naming an organization this
        // identity no longer has access to) triggers a fresh discovery
        // re-fetch and returns the user to wherever that now correctly
        // places them (selector or no-access) — never leaves stale
        // protected data visible.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          refresh();
          navigate('/organizations', { replace: true });
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Something went wrong loading this dashboard.');
      });
    return () => {
      active = false;
    };
  }, [apiClient, organizationId, navigate, refresh]);

  // Section 30: OWNER/MEMBER/VIEWER (org access) is displayed; never ApproverRole, never inferred approval authority.
  const orgInfo = state.status === 'selected' || state.status === 'selecting' ? state.organizations.find((o) => o.organizationId === organizationId) : undefined;

  return (
    <div style={{ minHeight: '100vh', fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Samvardiq</h1>
          {orgInfo && (
            <p style={{ margin: 0, opacity: 0.7 }}>
              {orgInfo.name} — {orgInfo.role}
            </p>
          )}
        </div>
        <button type="button" onClick={() => void signOut()}>
          Log out
        </button>
      </header>

      {error && <p role="alert">{error}</p>}
      {!error && goals === null && <p>Loading…</p>}
      {!error && goals !== null && <p>Dashboard foundation ready — {goals.length} goal(s) loaded for this organization.</p>}
    </div>
  );
}
