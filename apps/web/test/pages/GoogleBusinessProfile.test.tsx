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
  bindings: [],
  candidates: [
    { locationName: 'locations/9001', accountName: 'accounts/111', accountDisplayName: 'Owner', title: '<img src=x onerror=alert(1)>Clinic', addressSummary: 'Hyderabad' },
    { locationName: 'locations/9002', accountName: 'accounts/111', accountDisplayName: 'Owner', title: 'Branch', addressSummary: null },
  ],
};
const binding = (locationName: string, title: string, accessLostAt: string | null = null) => ({ locationName, accountName: 'accounts/111', title, boundByIdentityId: 'owner', boundAt: 'x', accessLostAt });

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
      getGbpStatus: vi.fn().mockResolvedValue({ connection: null, bindings: [], candidates: [] }),
      beginGbpAuthorization: vi.fn().mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x', expiresAt: 'x' }),
    } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google account' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x'));
    expect(apiClient.beginGbpAuthorization).toHaveBeenCalledWith('org-A', 'https://app.example.test/integrations/google-business-profile/callback');
    expect(sessionStorage.getItem(GBP_PENDING_ORGANIZATION_KEY)).toBe('org-A');
  });

  it('BP/AX: several locations are bound only after selecting them AND confirming the exact selection; provider titles render as inert text', async () => {
    const bound: GbpStatus = { ...connected, bindings: [binding('locations/9001', 'Clinic'), binding('locations/9002', 'Branch')] };
    const apiClient = { getGbpStatus: vi.fn().mockResolvedValue(connected), bindGbpLocations: vi.fn().mockResolvedValue(bound) } as unknown as SamvardiqApiClient;
    const { container } = renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>Clinic/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Bind selected (0)' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Bind selected (2)' }));
    expect(apiClient.bindGbpLocations).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm binding' })).toHaveTextContent('Branch');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm binding' }));
    expect(apiClient.bindGbpLocations).toHaveBeenCalledWith('org-A', ['locations/9001', 'locations/9002']);
    expect(await screen.findByRole('heading', { name: 'Bound locations' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Unbind' })).toHaveLength(2);
  });

  it('BA: a binding Google no longer returns is shown as not usable; unbinding is per location', async () => {
    const status: GbpStatus = { ...connected, bindings: [binding('locations/9001', 'Clinic'), binding('locations/9002', 'Branch', '2026-10-10T00:00:00Z')] };
    const apiClient = { getGbpStatus: vi.fn().mockResolvedValue(status), unbindGbpLocation: vi.fn().mockResolvedValue({ ...status, bindings: [status.bindings[0]!] }) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    expect(await screen.findByText(/not accessible with the connected Google account/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Unbind' })[1]!);
    expect(apiClient.unbindGbpLocation).toHaveBeenCalledWith('org-A', 'locations/9002');
  });

  it('refresh and verify are server operations; the page shows only the returned status', async () => {
    const apiClient = {
      getGbpStatus: vi.fn().mockResolvedValue(connected),
      refreshGbpDiscovery: vi.fn().mockResolvedValue(connected),
      verifyGbpConnection: vi.fn().mockResolvedValue({ ...connected, health: 'HEALTHY', checkedAt: 'x' }),
    } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh locations' }));
    expect(apiClient.refreshGbpDiscovery).toHaveBeenCalledWith('org-A');
    await userEvent.click(screen.getByRole('button', { name: 'Verify connection' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Connection verified/);
  });

  it('disconnect needs confirmation; revocation is opt-in with its cross-organization warning; the outcome is reported truthfully (BD)', async () => {
    const apiClient = {
      getGbpStatus: vi.fn().mockResolvedValue(connected),
      disconnectGbp: vi.fn().mockResolvedValueOnce({ connection: null, bindings: [], candidates: [], googleRevocation: 'FAILED' }),
    } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect…' }));
    expect(apiClient.disconnectGbp).not.toHaveBeenCalled();
    const revoke = screen.getByRole('checkbox', { name: /revoke Samvardiq’s access at Google/ });
    expect(revoke).not.toBeChecked();
    expect(screen.getByRole('group', { name: 'Confirm disconnect' })).toHaveTextContent(/every Samvardiq organization connected with this Google account/);
    await userEvent.click(revoke);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(apiClient.disconnectGbp).toHaveBeenCalledWith('org-A', true);
    expect(await screen.findByRole('status')).toHaveTextContent(/Google did not confirm the revocation/);
  });

  it('a local-only disconnect says plainly that Google-side access remains', async () => {
    const apiClient = {
      getGbpStatus: vi.fn().mockResolvedValue(connected),
      disconnectGbp: vi.fn().mockResolvedValue({ connection: null, bindings: [], candidates: [], googleRevocation: 'NOT_REQUESTED' }),
    } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(apiClient.disconnectGbp).toHaveBeenCalledWith('org-A', false);
    expect(await screen.findByRole('status')).toHaveTextContent(/Google still lists Samvardiq/);
  });

  it('a non-OWNER sees the server’s denial, never data', async () => {
    const apiClient = { getGbpStatus: vi.fn().mockRejectedValue(new ApiError(403, 'Access denied.')) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A/integrations/google-business-profile', apiClient);
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an organization OWNER can manage this integration.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
