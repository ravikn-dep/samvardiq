import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationSummary, SamvardiqApiClient } from '../../src/api/SamvardiqApiClient.js';
import { OrganizationProvider, useOrganization } from '../../src/organizations/OrganizationContext.js';

/** Y, Z, AA, AB of the IDENTITY-W8 adversarial matrix — discovery/selection UX state, never authority. */

function fakeClient(organizations: OrganizationSummary[], onFetch?: () => void): SamvardiqApiClient {
  return {
    listMyOrganizations: vi.fn(async () => {
      onFetch?.();
      return organizations;
    }),
  } as unknown as SamvardiqApiClient;
}

function Probe() {
  const { state, select, refresh } = useOrganization();
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      {state.status === 'selected' && <span data-testid="selected">{state.selected.organizationId}</span>}
      {(state.status === 'selecting' || state.status === 'selected') && (
        <ul>
          {state.organizations.map((o) => (
            <li key={o.organizationId}>
              <button onClick={() => select(o.organizationId)}>{o.organizationId}</button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={refresh}>refresh</button>
      <button onClick={() => select('org-does-not-exist')}>select-invalid</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('OrganizationProvider', () => {
  it('no-access: an empty discovery list produces the no-access state', async () => {
    render(
      <OrganizationProvider apiClient={fakeClient([])}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('no-access'));
  });

  it('Y: exactly one eligible organization auto-selects', async () => {
    render(
      <OrganizationProvider apiClient={fakeClient([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }])}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('selected'));
    expect(screen.getByTestId('selected').textContent).toBe('org-A');
  });

  it('Z: multiple organizations require explicit selection, then switching works', async () => {
    const user = userEvent.setup();
    render(
      <OrganizationProvider
        apiClient={fakeClient([
          { organizationId: 'org-A', name: 'Org A', role: 'OWNER' },
          { organizationId: 'org-B', name: 'Org B', role: 'VIEWER' },
        ])}
      >
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('selecting'));

    await user.click(screen.getByText('org-A'));
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('org-A'));

    await user.click(screen.getByText('org-B'));
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('org-B'));
  });

  it('AB: attempting to select an organization outside the discovered list is silently ignored — never becomes the selection', async () => {
    const user = userEvent.setup();
    render(
      <OrganizationProvider apiClient={fakeClient([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }])}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('org-A'));

    await user.click(screen.getByText('select-invalid'));
    // Still org-A — a forged/invalid organizationId can never become the active selection client-side.
    expect(screen.getByTestId('selected').textContent).toBe('org-A');
  });

  it('AA: the last selection is remembered as a UX preference across a remount, but re-validated against a fresh discovery result', async () => {
    const organizations = [
      { organizationId: 'org-A', name: 'Org A', role: 'OWNER' as const },
      { organizationId: 'org-B', name: 'Org B', role: 'VIEWER' as const },
    ];
    const client = fakeClient(organizations);
    const user = userEvent.setup();
    const { unmount } = render(
      <OrganizationProvider apiClient={client}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('selecting'));
    await user.click(screen.getByText('org-B'));
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('org-B'));
    unmount();

    // Remount with a FRESH discovery call — org-B is still eligible, so the remembered preference applies.
    render(
      <OrganizationProvider apiClient={fakeClient(organizations)}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('org-B'));
  });

  it('a stale remembered selection for an organization no longer in a fresh discovery result (e.g. revoked) is dropped, not kept', async () => {
    localStorage.setItem('samvardiq.lastSelectedOrganizationId', 'org-revoked');
    render(
      <OrganizationProvider apiClient={fakeClient([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }])}>
        <Probe />
      </OrganizationProvider>,
    );
    // org-A is the only eligible org and there's exactly one, so it still auto-selects —
    // proving the stale 'org-revoked' preference was discarded, not honored.
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('org-A'));
  });

  it('refresh() re-runs discovery (section 28 — recovering from a revoked membership mid-session)', async () => {
    const fetchSpy = vi.fn();
    const user = userEvent.setup();
    render(
      <OrganizationProvider apiClient={fakeClient([{ organizationId: 'org-A', name: 'Org A', role: 'OWNER' }], fetchSpy)}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText('refresh'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it('a discovery failure fails safe to no-access rather than showing stale/partial data', async () => {
    const client = { listMyOrganizations: vi.fn().mockRejectedValue(new Error('network down')) } as unknown as SamvardiqApiClient;
    render(
      <OrganizationProvider apiClient={client}>
        <Probe />
      </OrganizationProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('no-access'));
  });
});
