import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { OrganizationSummary, SamvardiqApiClient } from '../api/SamvardiqApiClient.js';

const STORAGE_KEY = 'samvardiq.lastSelectedOrganizationId';

/**
 * IDENTITY-W8 — organization discovery/selection state (section 7/11/12).
 *
 * Structurally cannot hold organization AUTHORITY: every field here is
 * either the plain discovery list (`GET /v1/me/organizations` — never a
 * `TrustedOrganizationContext`) or a UX-preference string. Selecting an
 * organization changes ONLY which route/API calls the rest of the app
 * makes NEXT — it never skips, caches, or shortcuts the server's own
 * fresh authorization check on each of those calls (section 11).
 *
 * `lastSelectedOrganizationId` is read from `localStorage` for UX
 * convenience only (remembering the last choice across a page reload)
 * and is ALWAYS re-validated against a fresh discovery result before
 * being trusted for anything — an org that is no longer in the eligible
 * list (membership revoked, role changed, etc. — section 12/28) is
 * silently dropped, never kept as the active selection.
 */
export type OrganizationState =
  | { status: 'loading' }
  | { status: 'no-access' }
  | { status: 'selecting'; organizations: OrganizationSummary[] }
  | { status: 'selected'; organizations: OrganizationSummary[]; selected: OrganizationSummary };

interface OrganizationContextValue {
  state: OrganizationState;
  select: (organizationId: string) => void;
  /** Re-runs discovery — call after a protected request comes back 401/403 while a dashboard is open (section 28: stale membership/identity handling). */
  refresh: () => void;
}

const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

function readStoredSelection(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSelection(organizationId: string | null): void {
  try {
    if (organizationId) localStorage.setItem(STORAGE_KEY, organizationId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-browsing/storage-disabled — UX convenience only, safe to ignore.
  }
}

export function OrganizationProvider({ apiClient, children }: { apiClient: SamvardiqApiClient; children: ReactNode }) {
  const [state, setState] = useState<OrganizationState>({ status: 'loading' });
  const [refreshCounter, setRefreshCounter] = useState(0);

  const applyDiscoveryResult = useCallback((organizations: OrganizationSummary[]) => {
    if (organizations.length === 0) {
      writeStoredSelection(null);
      setState({ status: 'no-access' });
      return;
    }

    const storedId = readStoredSelection();
    const storedMatch = storedId ? organizations.find((o) => o.organizationId === storedId) : undefined;

    // Section 24: exactly one eligible organization may auto-select for UX — never authorization.
    const autoSelect = organizations.length === 1 ? organizations[0] : undefined;
    const toSelect = storedMatch ?? autoSelect;

    if (toSelect) {
      writeStoredSelection(toSelect.organizationId);
      setState({ status: 'selected', organizations, selected: toSelect });
    } else {
      writeStoredSelection(null);
      setState({ status: 'selecting', organizations });
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .listMyOrganizations()
      .then((organizations) => {
        if (active) applyDiscoveryResult(organizations);
      })
      .catch(() => {
        // Section 37: a discovery failure must fail safe, never show stale/partial data.
        if (active) setState({ status: 'no-access' });
      });
    return () => {
      active = false;
    };
  }, [apiClient, applyDiscoveryResult, refreshCounter]);

  const value = useMemo<OrganizationContextValue>(
    () => ({
      state,
      select(organizationId) {
        setState((current) => {
          if (current.status !== 'selecting' && current.status !== 'selected') return current;
          const match = current.organizations.find((o) => o.organizationId === organizationId);
          if (!match) return current; // section 21/AB: cannot select an organization outside the discovered, eligible list
          writeStoredSelection(match.organizationId);
          return { status: 'selected', organizations: current.organizations, selected: match };
        });
      },
      refresh() {
        setState({ status: 'loading' });
        setRefreshCounter((n) => n + 1);
      },
    }),
    [state],
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization(): OrganizationContextValue {
  const ctx = useContext(OrganizationContext);
  if (!ctx) throw new Error('useOrganization must be used within an OrganizationProvider');
  return ctx;
}
