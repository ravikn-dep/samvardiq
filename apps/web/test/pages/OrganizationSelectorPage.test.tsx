import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationSelectorPage } from '../../src/pages/OrganizationSelectorPage.js';

const { useOrganizationMock, useAuthMock, navigateMock, signOutMock } = vi.hoisted(() => ({
  useOrganizationMock: vi.fn(),
  useAuthMock: vi.fn(),
  navigateMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock('../../src/organizations/OrganizationContext.js', () => ({ useOrganization: useOrganizationMock }));
vi.mock('../../src/auth/AuthContext.js', () => ({ useAuth: useAuthMock }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

describe('OrganizationSelectorPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    signOutMock.mockReset();
    useAuthMock.mockReturnValue({ signOut: signOutMock, state: { status: 'authenticated', accessToken: 't' } });
  });

  it('Z: lists every eligible organization with its role, keyboard-accessible', async () => {
    useOrganizationMock.mockReturnValue({
      state: {
        status: 'selecting',
        organizations: [
          { organizationId: 'org-A', name: 'Org A', role: 'OWNER' },
          { organizationId: 'org-B', name: 'Org B', role: 'VIEWER' },
        ],
      },
    });
    render(
      <MemoryRouter>
        <OrganizationSelectorPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /Org A.*OWNER/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Org B.*VIEWER/ })).toBeInTheDocument();
  });

  it('navigates to the organization route on selection — never establishes authority itself', async () => {
    useOrganizationMock.mockReturnValue({
      state: { status: 'selecting', organizations: [{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }] },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <OrganizationSelectorPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /Org A/ }));
    expect(navigateMock).toHaveBeenCalledWith('/org/org-A');
  });

  it('AK: the logout control signs out', async () => {
    useOrganizationMock.mockReturnValue({ state: { status: 'selecting', organizations: [] } });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <OrganizationSelectorPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /log out/i }));
    expect(signOutMock).toHaveBeenCalled();
  });
});
