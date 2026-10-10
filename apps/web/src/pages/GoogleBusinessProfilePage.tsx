import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError, type GbpStatus, type GoogleRevocationOutcome, type SamvardiqApiClient } from '../api/SamvardiqApiClient.js';

export const GBP_CALLBACK_PATH = '/integrations/google-business-profile/callback';
/** Which organization the in-flight Google authorization belongs to — UX routing only; the server binds the state to the human and organization itself. */
export const GBP_PENDING_ORGANIZATION_KEY = 'samvardiq.gbp.pendingOrganizationId';

const messageOf = (err: unknown) =>
  err instanceof ApiError ? (err.status === 403 ? 'Only an organization OWNER can manage this integration.' : err.message) : 'Something went wrong. Please try again.';

const REVOCATION_NOTICE: Record<GoogleRevocationOutcome, string> = {
  REVOKED: 'Disconnected. Google confirmed that Samvardiq’s access was revoked, and Samvardiq deleted its stored access.',
  FAILED: 'Disconnected, and Samvardiq deleted its stored access — but Google did not confirm the revocation. Remove Samvardiq under your Google Account’s third-party access to be sure.',
  NOT_ATTEMPTED: 'Disconnected, and Samvardiq deleted its stored access. Google-side revocation could not be attempted; remove Samvardiq under your Google Account’s third-party access if you wish.',
  NOT_REQUESTED: 'Disconnected. Samvardiq deleted its stored access. Google still lists Samvardiq under your Google Account’s third-party access until you remove it there.',
};

/**
 * GBP-W1 — minimal OWNER connection UX: connect (Google consent), refresh
 * discovery, verify, select several discovered locations and confirm the
 * binding, unbind per location, disconnect (optionally revoking at Google).
 * The page only renders what the server returns; every action is
 * re-authorized server-side (human OWNER), so a MEMBER/VIEWER who opens this
 * URL just sees the 403 message. Provider titles/addresses are rendered as
 * React text (never markup). No token ever reaches this page.
 */
export function GoogleBusinessProfilePage({ apiClient }: { apiClient: SamvardiqApiClient }) {
  const { organizationId = '' } = useParams<{ organizationId: string }>();
  const [status, setStatus] = useState<GbpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmingBind, setConfirmingBind] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [revoke, setRevoke] = useState(false);

  const run = async (action: () => Promise<GbpStatus | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
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

  const bind = () =>
    run(async () => {
      const next = await apiClient.bindGbpLocations(organizationId, selected);
      setSelected([]);
      setConfirmingBind(false);
      return next;
    });

  const disconnect = () =>
    run(async () => {
      const result = await apiClient.disconnectGbp(organizationId, revoke);
      setConfirmingDisconnect(false);
      setRevoke(false);
      setNotice(REVOCATION_NOTICE[result.googleRevocation]);
      return result;
    });

  const verify = () =>
    run(async () => {
      const result = await apiClient.verifyGbpConnection(organizationId);
      setNotice('Connection verified: Google accepts Samvardiq’s access.');
      return result;
    });

  const connection = status?.connection;
  const active = connection?.status === 'ACTIVE';
  const boundNames = new Set(status?.bindings.map((b) => b.locationName));
  const available = status?.candidates.filter((c) => !boundNames.has(c.locationName)) ?? [];
  const titleOf = (name: string) => status?.candidates.find((c) => c.locationName === name)?.title || name;
  const toggle = (name: string) => setSelected((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));

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
                Status: <strong>{active ? 'Connected' : 'Needs reconnection'}</strong>
              </p>
            ) : (
              <p>Not connected.</p>
            )}
            <button type="button" disabled={busy} onClick={() => void connect()}>
              {connection ? 'Reconnect Google account' : 'Connect Google account'}
            </button>{' '}
            {active && (
              <>
                <button type="button" disabled={busy} onClick={() => void run(() => apiClient.refreshGbpDiscovery(organizationId))}>
                  Refresh locations
                </button>{' '}
                <button type="button" disabled={busy} onClick={() => void verify()}>
                  Verify connection
                </button>{' '}
              </>
            )}
            {connection && !confirmingDisconnect && (
              <button type="button" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
                Disconnect…
              </button>
            )}
            {connection && confirmingDisconnect && (
              <div role="group" aria-label="Confirm disconnect">
                <p>Disconnecting stops all Samvardiq use of this Google account and ends every location binding (history is kept).</p>
                <label>
                  <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} /> Also revoke Samvardiq’s access at Google. This removes it for every Samvardiq
                  organization connected with this Google account.
                </label>
                <p>
                  <button type="button" disabled={busy} onClick={() => void disconnect()}>
                    Confirm disconnect
                  </button>{' '}
                  <button type="button" disabled={busy} onClick={() => setConfirmingDisconnect(false)}>
                    Cancel
                  </button>
                </p>
              </div>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: '1rem' }}>Bound locations</h2>
            {status.bindings.length ? (
              <ul>
                {status.bindings.map((b) => (
                  <li key={b.locationName}>
                    <strong>{b.title || b.locationName}</strong>
                    {b.accessLostAt ? ' — not accessible with the connected Google account; not used until access returns' : ''}{' '}
                    <button type="button" disabled={busy} onClick={() => void run(() => apiClient.unbindGbpLocation(organizationId, b.locationName))}>
                      Unbind
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No location is bound yet.</p>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: '1rem' }}>Available locations</h2>
            {active ? (
              available.length ? (
                <>
                  <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
                    {available.map((c) => (
                      <li key={c.locationName}>
                        <label>
                          <input type="checkbox" disabled={busy || confirmingBind} checked={selected.includes(c.locationName)} onChange={() => toggle(c.locationName)} /> {c.title || c.locationName}
                          {c.addressSummary ? ` — ${c.addressSummary}` : ''} <small style={{ opacity: 0.7 }}>({c.accountDisplayName})</small>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {!confirmingBind ? (
                    <button type="button" disabled={busy || !selected.length} onClick={() => setConfirmingBind(true)}>
                      Bind selected ({selected.length})
                    </button>
                  ) : (
                    <div role="group" aria-label="Confirm binding">
                      <p>Bind these locations to this organization? Only bind locations your clinic operates.</p>
                      <ul>
                        {selected.map((name) => (
                          <li key={name}>{titleOf(name)}</li>
                        ))}
                      </ul>
                      <button type="button" disabled={busy} onClick={() => void bind()}>
                        Confirm binding
                      </button>{' '}
                      <button type="button" disabled={busy} onClick={() => setConfirmingBind(false)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p>No further Business Profile locations were returned for this Google account.</p>
              )
            ) : (
              <p>Connect a Google account to choose locations.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
