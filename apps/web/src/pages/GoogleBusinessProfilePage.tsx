import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError, type GbpStatus, type SamvardiqApiClient } from '../api/SamvardiqApiClient.js';

export const GBP_CALLBACK_PATH = '/integrations/google-business-profile/callback';
/** Which organization the in-flight Google authorization belongs to — UX routing only; the server binds the state to the human and organization itself. */
export const GBP_PENDING_ORGANIZATION_KEY = 'samvardiq.gbp.pendingOrganizationId';

const messageOf = (err: unknown) =>
  err instanceof ApiError ? (err.status === 403 ? 'Only an organization OWNER can manage this integration.' : err.message) : 'Something went wrong. Please try again.';

/**
 * GBP-W1 — minimal OWNER connection UX: connect (Google consent), choose a
 * discovered location, bind, unbind, disconnect. The page only renders what
 * the server returns; every action is re-authorized server-side (human
 * OWNER), so a MEMBER/VIEWER who opens this URL just sees the 403 message.
 * Provider titles/addresses are rendered as React text (never markup).
 */
export function GoogleBusinessProfilePage({ apiClient }: { apiClient: SamvardiqApiClient }) {
  const { organizationId = '' } = useParams<{ organizationId: string }>();
  const [status, setStatus] = useState<GbpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<GbpStatus | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    apiClient
      .getGbpStatus(organizationId)
      .then((next) => active && setStatus(next))
      .catch((err: unknown) => active && setError(messageOf(err)));
    return () => {
      active = false;
    };
  }, [apiClient, organizationId]);

  const connect = () =>
    run(async () => {
      const { authorizationUrl } = await apiClient.beginGbpAuthorization(organizationId, `${window.location.origin}${GBP_CALLBACK_PATH}`);
      try {
        sessionStorage.setItem(GBP_PENDING_ORGANIZATION_KEY, organizationId);
      } catch {
        throw new ApiError(0, 'Your browser blocked session storage, which this step needs. Allow it and try again.');
      }
      window.location.assign(authorizationUrl);
    });

  const disconnect = () =>
    run(async () => {
      const result = await apiClient.disconnectGbp(organizationId);
      setNotice('Disconnected. Samvardiq deleted its stored Google access. Google may still list Samvardiq under your Google Account’s third-party access until you remove it there.');
      return result;
    });

  const connection = status?.connection;
  return (
    <div style={{ minHeight: '100vh', fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '48rem' }}>
      <p>
        <Link to={`/org/${encodeURIComponent(organizationId)}`}>← Dashboard</Link>
      </p>
      <h1 style={{ fontSize: '1.25rem' }}>Google Business Profile</h1>
      <p style={{ opacity: 0.7 }}>Read-only: Samvardiq reads your profile’s data. It never edits your profile, posts or replies.</p>

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!status && !error && <p>Loading…</p>}

      {status && (
        <>
          <section>
            <h2 style={{ fontSize: '1rem' }}>Connection</h2>
            {connection ? (
              <p>
                Status: <strong>{connection.status === 'ACTIVE' ? 'Connected' : 'Needs reconnection'}</strong>
              </p>
            ) : (
              <p>Not connected.</p>
            )}
            <button type="button" disabled={busy} onClick={() => void connect()}>
              {connection ? 'Reconnect Google account' : 'Connect Google account'}
            </button>{' '}
            {connection && (
              <button type="button" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: '1rem' }}>Location</h2>
            {status.binding ? (
              <p>
                Bound: <strong>{status.binding.title || status.binding.locationName}</strong>{' '}
                <button type="button" disabled={busy} onClick={() => void run(() => apiClient.unbindGbpLocation(organizationId))}>
                  Unbind
                </button>
              </p>
            ) : connection?.status === 'ACTIVE' ? (
              status.candidates.length ? (
                <ul>
                  {status.candidates.map((c) => (
                    <li key={c.locationName}>
                      {c.title || c.locationName}
                      {c.addressSummary ? ` — ${c.addressSummary}` : ''} <small style={{ opacity: 0.7 }}>({c.accountDisplayName})</small>{' '}
                      <button type="button" disabled={busy} onClick={() => void run(() => apiClient.bindGbpLocation(organizationId, c.locationName))}>
                        Bind this location
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>This Google account returned no Business Profile locations.</p>
              )
            ) : (
              <p>Connect a Google account to choose a location.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
