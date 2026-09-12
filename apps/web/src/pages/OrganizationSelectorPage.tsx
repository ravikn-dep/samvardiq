import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext.js';
import { useOrganization } from '../organizations/OrganizationContext.js';

/**
 * Section 14/23: shown when the identity has 2+ eligible organizations
 * and none is currently selected. Purely a UX picker over the discovery
 * list already fetched — selecting an entry never establishes
 * authorization itself (section 11); the next protected request still
 * re-verifies everything server-side.
 */
export function OrganizationSelectorPage() {
  const { state } = useOrganization();
  const { signOut } = useAuth();
  const navigate = useNavigate();

  if (state.status !== 'selecting' && state.status !== 'selected') return null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ width: '22rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>Choose an organization</h1>
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {state.organizations.map((org) => (
            <li key={org.organizationId}>
              <button
                type="button"
                onClick={() => navigate(`/org/${encodeURIComponent(org.organizationId)}`)}
                style={{ width: '100%', textAlign: 'left', padding: '0.75rem' }}
              >
                {org.name} <span style={{ opacity: 0.6 }}>({org.role})</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void signOut()} style={{ marginTop: '1rem' }}>
          Log out
        </button>
      </div>
    </div>
  );
}
