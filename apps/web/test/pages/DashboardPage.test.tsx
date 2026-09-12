import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SamvardiqApiClient } from '../../src/api/SamvardiqApiClient.js';
import { ApiError } from '../../src/api/SamvardiqApiClient.js';
import { DashboardPage } from '../../src/pages/DashboardPage.js';

const { useOrganizationMock, useAuthMock, navigateMock } = vi.hoisted(() => ({
  useOrganizationMock: vi.fn(),
  useAuthMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('../../src/organizations/OrganizationContext.js', () => ({ useOrganization: useOrganizationMock }));
vi.mock('../../src/auth/AuthContext.js', () => ({ useAuth: useAuthMock }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

function renderAt(path: string, apiClient: SamvardiqApiClient) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/org/:organizationId" element={<DashboardPage apiClient={apiClient} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useAuthMock.mockReturnValue({ signOut: vi.fn(), state: { status: 'authenticated', accessToken: 't' } });
    useOrganizationMock.mockReturnValue({
      state: { status: 'selected', organizations: [{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }], selected: { organizationId: 'org-A', name: 'Org A', role: 'OWNER' } },
      refresh: vi.fn(),
    });
  });

  it('proves the real chain: calls listGoals for the URL organizationId and renders the result', async () => {
    const apiClient = { listGoals: vi.fn().mockResolvedValue([{ goalId: 'g1', organizationId: 'org-A', title: 'x', description: 'x', status: 'active' }]) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A', apiClient);

    expect(apiClient.listGoals).toHaveBeenCalledWith('org-A');
    expect(await screen.findByText(/1 goal\(s\) loaded/)).toBeInTheDocument();
    expect(screen.getByText(/Org A/)).toBeInTheDocument();
    expect(screen.getByText(/OWNER/)).toBeInTheDocument();
  });

  it('AT/AU: never displays or infers ApproverRole — only the plain organization access role is shown', async () => {
    const apiClient = { listGoals: vi.fn().mockResolvedValue([]) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A', apiClient);
    await screen.findByText(/Dashboard foundation ready/);
    expect(screen.queryByText(/approver/i)).not.toBeInTheDocument();
  });

  it('AC: a URL naming an organization the identity has no access to still calls the backend with that exact ID, and a 403 redirects to the selector rather than showing data', async () => {
    const refresh = vi.fn();
    useOrganizationMock.mockReturnValue({
      state: { status: 'selected', organizations: [{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }], selected: { organizationId: 'org-A', name: 'Org A', role: 'OWNER' } },
      refresh,
    });
    const apiClient = { listGoals: vi.fn().mockRejectedValue(new ApiError(403, 'Access denied.')) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-B', apiClient);

    expect(apiClient.listGoals).toHaveBeenCalledWith('org-B');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/organizations', { replace: true }));
    expect(screen.queryByText(/goal\(s\) loaded/)).not.toBeInTheDocument();
  });

  it('AD/AE: a 401 (stale/revoked identity or membership) also triggers refresh + redirect, never leaves protected data visible', async () => {
    const refresh = vi.fn();
    useOrganizationMock.mockReturnValue({
      state: { status: 'selected', organizations: [{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }], selected: { organizationId: 'org-A', name: 'Org A', role: 'OWNER' } },
      refresh,
    });
    const apiClient = { listGoals: vi.fn().mockRejectedValue(new ApiError(401, 'Authentication required.')) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A', apiClient);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/organizations', { replace: true }));
  });

  it('a non-auth error (e.g. 500) shows a generic message rather than redirecting', async () => {
    const apiClient = { listGoals: vi.fn().mockRejectedValue(new ApiError(500, 'Internal server error.')) } as unknown as SamvardiqApiClient;
    renderAt('/org/org-A', apiClient);
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error.');
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
