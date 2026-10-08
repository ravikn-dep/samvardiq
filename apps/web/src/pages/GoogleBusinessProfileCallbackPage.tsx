import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { ApiError, type SamvardiqApiClient } from '../api/SamvardiqApiClient.js';
import { GBP_CALLBACK_PATH, GBP_PENDING_ORGANIZATION_KEY } from './GoogleBusinessProfilePage.js';

function takePendingOrganization(): string | null {
  try {
    const value = sessionStorage.getItem(GBP_PENDING_ORGANIZATION_KEY);
    sessionStorage.removeItem(GBP_PENDING_ORGANIZATION_KEY);
    return value;
  } catch {
    return null;
  }
}

/**
 * GBP-W1, Founder decision G4-A: Google redirects the browser here. This page
 * strips `code`/`state` from the address bar immediately, then hands them to
 * the API WITH the signed-in session; the API completes only for the same
 * human OWNER and organization that started the authorization. It never
 * exchanges the code itself and never sees a token. Completion runs once —
 * the state is single-use, so React StrictMode's double effect must not
 * resend it.
 */
export function GoogleBusinessProfileCallbackPage({ apiClient }: { apiClient: SamvardiqApiClient }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(location.search);
    navigate(GBP_CALLBACK_PATH, { replace: true });
    const organizationId = takePendingOrganization();
    const state = params.get('state');
    const code = params.get('code');
    const googleError = params.get('error');
    const complete = async () => {
      if (!organizationId || !state || (!code && !googleError)) throw new ApiError(0, 'This Google connection attempt is invalid or has expired. Start again.');
      await apiClient.completeGbpAuthorization(organizationId, code ? { state, code } : { state, error: googleError! });
      navigate(`/org/${encodeURIComponent(organizationId)}/integrations/google-business-profile`, { replace: true });
    };
    complete().catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'));
  }, [apiClient, location.search, navigate]);

  return (
    <div style={{ minHeight: '100vh', fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Link to="/">Back to Samvardiq</Link>
        </>
      ) : (
        <p>Finishing the Google connection…</p>
      )}
    </div>
  );
}
