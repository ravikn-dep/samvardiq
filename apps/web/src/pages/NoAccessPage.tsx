import { useAuth } from '../auth/AuthContext.js';

/**
 * Section 25/26: ONE generic message covers every reason
 * `GET /v1/me/organizations` can return an empty list — unprovisioned
 * (no IdentityProviderLink), suspended/revoked identity, or genuinely
 * zero active memberships. The backend deliberately does not distinguish
 * these (see organizationDiscoveryHandler.ts's own doc comment on
 * non-enumeration), so this page does not invent a distinction the API
 * never provides. No tenant/organization names are ever shown here.
 */
export function NoAccessPage() {
  const { signOut } = useAuth();
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ width: '22rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem' }}>No active organization access</h1>
        <p>Your account is not currently associated with any active organization. Contact your organization administrator if you believe this is an error.</p>
        <button type="button" onClick={() => void signOut()}>
          Log out
        </button>
      </div>
    </div>
  );
}
