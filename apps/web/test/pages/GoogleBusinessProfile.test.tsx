import { StrictMode, useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type GbpStatus, type SamvardiqApiClient } from '../../src/api/SamvardiqApiClient.js';
import { GoogleBusinessProfileCallbackPage } from '../../src/pages/GoogleBusinessProfileCallbackPage.js';
import { GBP_CALLBACK_PATH, GBP_PENDING_ORGANIZATION_KEY, GoogleBusinessProfilePage } from '../../src/pages/GoogleBusinessProfilePage.js';

/** GBP-W1 browser boundary: Y (no token ever in the browser), G4-A (session-bound completion, sent once), AM (provider text is inert). */
const STATE = 's'.repeat(43);
const connected: GbpStatus = {
  connection: { connectionId: 'c1', status: 'ACTIVE', googleAccountId: 'accounts/111', grantedScopes: [], connectedAt: 'x', updatedAt: 'x' },
  binding: null,
  candidates: [{ locationName: 'locations/9001', accountName: 'accounts/111', accountDisplayName: 'Owner', title: '<img src=x onerror=alert(1)>Clinic', addressSummary: 'Hyderabad' }],
};

let currentPath = '';
function PathProbe() {
  const location = useLocation();
  useEffect(() => {
    currentPath = `${location.pathname}${location.search}`;
  }, [location]);
  return null;
}

function renderAt(path: string, apiClient: SamvardiqApiClient, strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <PathProbe />
      <Routes>
        <Route path="/org/:organizationId/integrations/google-business-profile" element={<GoogleBusinessProfilePage apiClient={apiClient} />} />
        <Route path={GBP_CALLBACK_PATH} element={<GoogleBusinessProfileCallbackPage apiClient={apiClient} />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('GoogleBusinessProfile callback page (G4-A)', () => {
  beforeEach(() => sessionStorage.clear());

  it('strips code/state from the URL, completes exactly once with the session (even under StrictMode), then returns to the integration page', async () => {
    sessionStorage.setItem(GBP_PENDING_ORGANIZATION_KEY, 'org-A');
    const apiClient = { completeGbpAuthorization: vi.fn().mockResolvedValue(connected), getGbpStatus: vi.fn().mockResolvedValue(connected) } as unknown as SamvardiqApiClient;
    renderAt(`${GBP_CALLBACK_PATH}?state=${STATE}&code=4/0Asecret&scope=x`, apiClient, true);
    await waitFor(() => expect(currentPath).toBe('/org/org-A/integrations/google-business-profile'));
    expect(apiClient.completeGbpAuthorization).toHaveBeenCalledTimes(1);
    expect(apiClient.completeGbpAuthorization).toHaveBeenCalledWith('org-A', { state: STATE, code: '4/0Asecret' });
    expect(sessionStorage.getItem(GBP_PENDING_ORGANIZATION_KEY)).toBeNull();
  });

  it('forwards a Google denial as an error (consuming the state server-side) and shows the server’s message', async () => {
    sessionStorage.setItem(GBP_PENDING_ORGANIZATION_KEY, 'org-A');
    const apiClient = { completeGbpAuthorization: vi.fn().mockRejectedValue(new ApiError(400, 'Google authorization was not granted.')) } as unknown as SamvardiqApiClient;
    renderAt(`${GBP_CALLBACK_PATH}?state=${STATE}&error=access_denied`, apiClient);
    expect(await screen.findByRole('alert')).toHaveTextContent('Google authorization was not granted.');
    expect(apiClient.completeGbpAuthorization).toHaveBeenCalledWith('org-A', { state: STATE, error: 'access_denied' });
    expect(currentPath).toBe(GBP_CALLBACK_PATH);
  });

  it('a callback without a pending authorization in this tab (e.g. a forged or replayed link) never calls the API', async () => {
    const apiClient = { completeGbpAuthorization: vi.fn() } as unknown as SamvardiqApiClient;
    renderAt(`${GBP_CALLBACK_PATH}?state=${STATE}&code=c`, apiClient);
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/);
    expect(apiClient.completeGbpAuthorization).not.toHaveBeenCalled();
    expect(currentPath).toBe(GBP_CALLBACK_PATH);
  });
});

describe('GoogleBusinessProfile page', () => {
  const assign = vi.fn();
  beforeEach(() => {
    sessionStorage.clear();
    assign.mockReset();
    vi.stubGlobal('location', { ...window.location, origin: 'https://app.example.test', assign });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('connect: asks the API for an authorization with this origin’s callback, remembers the organization for this tab, and leaves for Google', async () => {
    const apiClient = {
      getGbpStatus: vi.fn().mockResolvedValue({ connection: null, binding: null, candidates: [] }),
      beginGbpAuthorization: vi.fn().mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x', expiresAt: 'x' }),
    } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google account' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x'));
    expect(apiClient.beginGbpAuthorization).toHaveBeenCalledWith('org-A', 'https://app.example.test/integrations/google-business-profile/callback');
    expect(sessionStorage.getItem(GBP_PENDING_ORGANIZATION_KEY)).toBe('org-A');
  });

  it('binds only by explicit choice; provider titles render as inert text', async () => {
    const bound: GbpStatus = { ...connected, binding: { locationName: 'locations/9001', accountName: 'accounts/111', title: 'Clinic', boundByIdentityId: 'owner', boundAt: 'x' } };
    const apiClient = { getGbpStatus: vi.fn().mockResolvedValue(connected), bindGbpLocation: vi.fn().mockResolvedValue(bound) } as unknown as SamvardiqApiClient;
    const { container } = renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>Clinic/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(apiClient.bindGbpLocation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Bind this location' }));
    expect(apiClient.bindGbpLocation).toHaveBeenCalledWith('org-A', 'locations/9001');
    expect(await screen.findByText('Clinic')).toBeInTheDocument();
  });

  it('disconnect says plainly that Google-side access was not revoked', async () => {
    const apiClient = {
      getGbpStatus: vi.fn().mockResolvedValue(connected),
      disconnectGbp: vi.fn().mockResolvedValue({ connection: null, binding: null, candidates: [], googleAuthorization: 'NOT_REVOKED' }),
    } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Google may still list Samvardiq/);
  });

  it('a non-OWNER sees the server’s denial, never data', async () => {
    const apiClient = { getGbpStatus: vi.fn().mockRejectedValue(new ApiError(403, 'Access denied.')) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an organization OWNER can manage this integration.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
