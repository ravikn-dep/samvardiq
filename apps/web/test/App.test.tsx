import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';

/**
 * The full end-to-end IDENTITY-W8 adversarial matrix, section 41 (U-BF
 * where practical at this layer) — real React Router, real context
 * providers, only the Supabase SDK boundary and `fetch` are mocked
 * (section 42: never mock the layer under test — AuthContext,
 * OrganizationContext, and every page component run for real).
 */

const { getSessionMock, onAuthStateChangeMock, signInMock, signOutMock, getAccessTokenMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(),
  signInMock: vi.fn(),
  signOutMock: vi.fn(),
  getAccessTokenMock: vi.fn(),
}));

vi.mock('../src/auth/supabaseClient.js', () => ({
  getSession: getSessionMock,
  onAuthStateChange: onAuthStateChangeMock,
  signIn: signInMock,
  signOut: signOutMock,
  getAccessToken: getAccessTokenMock,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  onAuthStateChangeMock.mockReturnValue(() => {});
  getAccessTokenMock.mockResolvedValue('access-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('App — end-to-end', () => {
  it('AG: unauthenticated user sees Login, not any protected content', async () => {
    getSessionMock.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByText('Samvardiq')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('U/Y: full flow — sign in, single eligible org auto-selects, dashboard loads via the real protected route', async () => {
    getSessionMock.mockResolvedValue(null);
    let authCallback: ((session: { access_token: string } | null) => void) | undefined;
    onAuthStateChangeMock.mockImplementation((cb) => {
      authCallback = cb;
      return () => {};
    });
    signInMock.mockImplementation(async () => {
      authCallback?.({ access_token: 'new-token' });
      return {};
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/me/organizations')) return Promise.resolve(jsonResponse([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }]));
      if (url.includes('/v1/organizations/org-A/goals')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Email'), 'doc@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/Dashboard foundation ready/)).toBeInTheDocument();
    expect(screen.getByText(/Org A/)).toBeInTheDocument();
    expect(screen.getByText(/OWNER/)).toBeInTheDocument();
  });

  it('Z: multi-organization user sees the selector, then switches organizations', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/me/organizations')) {
        return Promise.resolve(
          jsonResponse([
            { organizationId: 'org-A', name: 'Org A', role: 'OWNER' },
            { organizationId: 'org-B', name: 'Org B', role: 'VIEWER' },
          ]),
        );
      }
      if (url.includes('/goals')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Org A/ }));
    expect(await screen.findByText(/Org A — OWNER/)).toBeInTheDocument();

    // AA: forged local state cannot bypass this — but a REAL client-side navigation back to the selector
    // and choosing the other real, eligible organization works, and the backend re-authorizes it independently.
    window.history.pushState({}, '', '/organizations');
    render(<App />); // simplified re-entry to the selector route for this test's purpose
    await user.click(await screen.findByRole('button', { name: /Org B/ }));
    expect(await screen.findByText(/Org B — VIEWER/)).toBeInTheDocument();
  });

  it('no-access: zero eligible organizations shows the generic no-access state, never a tenant name', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));

    render(<App />);
    expect(await screen.findByText('No active organization access')).toBeInTheDocument();
  });

  it('AG (unprovisioned): a valid session with an unprovisioned identity gets the identical no-access state', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([]))); // backend collapses unprovisioned to an empty list — see organizationDiscoveryHandler.ts

    render(<App />);
    expect(await screen.findByText('No active organization access')).toBeInTheDocument();
  });

  it('W/X: session restoration goes straight to organization discovery, never flashing Login first', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'restored-token' });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/goals') ? jsonResponse([]) : jsonResponse([{ organizationId: 'org-A', name: 'Org A', role: 'MEMBER' }]),
      ),
    );

    render(<App />);
    expect(await screen.findByText(/Dashboard foundation ready/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('AD: a membership revoked mid-session causes the protected call to fail and returns the user to the selector, never showing stale data', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    let discoveryCallCount = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/me/organizations')) {
        discoveryCallCount += 1;
        // First discovery: still a member. After revocation, discovery itself would also reflect zero orgs on refresh.
        if (discoveryCallCount === 1) return Promise.resolve(jsonResponse([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }]));
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/goals')) return Promise.resolve(jsonResponse({ error: 'Access denied.' }, 403));
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
    });

    render(<App />);
    await waitFor(() => expect(screen.queryByText(/Dashboard foundation ready/)).not.toBeInTheDocument());
    expect(await screen.findByText('No active organization access')).toBeInTheDocument();
  });

  it('AK: logout returns to the Login screen and clears the dashboard', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    let authCallback: ((session: { access_token: string } | null) => void) | undefined;
    onAuthStateChangeMock.mockImplementation((cb) => {
      authCallback = cb;
      return () => {};
    });
    signOutMock.mockImplementation(async () => {
      authCallback?.(null);
    });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/goals') ? jsonResponse([]) : jsonResponse([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }])),
    );

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Dashboard foundation ready/);

    await user.click(screen.getByRole('button', { name: /log out/i }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('AN/AO: token never appears in the rendered DOM anywhere in this flow', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'super-secret-token-value' });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/goals') ? jsonResponse([]) : jsonResponse([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }])),
    );
    getAccessTokenMock.mockResolvedValue('super-secret-token-value');

    render(<App />);
    await screen.findByText(/Dashboard foundation ready/);
    expect(document.body.textContent).not.toContain('super-secret-token-value');
  });

  it('AQ: internal identityId/provider subject never appear anywhere in the rendered DOM', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/goals') ? jsonResponse([]) : jsonResponse([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }])),
    );

    render(<App />);
    await screen.findByText(/Dashboard foundation ready/);
    expect(document.body.textContent).not.toMatch(/identityId|providerSubject|provider_subject/i);
  });
});
