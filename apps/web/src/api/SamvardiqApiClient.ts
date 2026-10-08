/**
 * IDENTITY-W8 — the ONE place components call the Fastify API
 * (ADR-FRONTEND-001 frontend-boundary rule 4). No component calls
 * `fetch` directly against `apps/api`.
 *
 * Never constructs a `TrustedOrganizationContext` — it only attaches
 * whatever bearer token `getAccessToken` currently returns and lets the
 * backend do every authentication/authorization decision fresh, exactly
 * as W5-W8 already require (section 11: "server verification -> fresh
 * identity check -> fresh ACTIVE membership check").
 */

export interface OrganizationSummary {
  organizationId: string;
  name: string;
  role: 'OWNER' | 'MEMBER' | 'VIEWER';
}

export interface Goal {
  goalId: string;
  organizationId: string;
  title: string;
  description: string;
  status: string;
}

/** GBP-W1: the OWNER-visible Google Business Profile state — non-secret metadata only (no token, code or raw Google response ever reaches the browser). */
export interface GbpCandidate {
  locationName: string;
  accountName: string;
  accountDisplayName: string;
  title: string;
  addressSummary: string | null;
}

export interface GbpStatus {
  connection: { connectionId: string; status: 'ACTIVE' | 'NEEDS_REAUTH' | 'DISCONNECTED'; googleAccountId: string | null; grantedScopes: string[]; connectedAt: string; updatedAt: string } | null;
  binding: { locationName: string; accountName: string; title: string; boundByIdentityId: string; boundAt: string } | null;
  candidates: GbpCandidate[];
}

/** Thrown for any non-2xx response. `message` is always the backend's own already-sanitized error text (never a raw exception, never SQL/token/internal-ID detail — see apps/api's classifyError). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type AccessTokenProvider = () => Promise<string | null>;

export class SamvardiqApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAccessToken: AccessTokenProvider,
  ) {}

  async listMyOrganizations(): Promise<OrganizationSummary[]> {
    return this.request<OrganizationSummary[]>('GET', '/v1/me/organizations');
  }

  async listGoals(organizationId: string): Promise<Goal[]> {
    return this.request<Goal[]>('GET', `/v1/organizations/${encodeURIComponent(organizationId)}/goals`);
  }

  // ---- GBP-W1 (OWNER-only on the server; the server decides, never this client) ----
  getGbpStatus(organizationId: string): Promise<GbpStatus> {
    return this.request<GbpStatus>('GET', gbpPath(organizationId));
  }

  beginGbpAuthorization(organizationId: string, redirectUri: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
    return this.request('POST', `${gbpPath(organizationId)}/authorizations`, { redirectUri });
  }

  /** Forwards Google's redirect parameters, with this session, to the API (G4-A). Exactly one of code/error. */
  completeGbpAuthorization(organizationId: string, input: { state: string; code: string } | { state: string; error: string }): Promise<GbpStatus> {
    return this.request<GbpStatus>('POST', `${gbpPath(organizationId)}/authorizations/complete`, input);
  }

  bindGbpLocation(organizationId: string, locationName: string): Promise<GbpStatus> {
    return this.request<GbpStatus>('POST', `${gbpPath(organizationId)}/binding`, { locationName });
  }

  unbindGbpLocation(organizationId: string): Promise<GbpStatus> {
    return this.request<GbpStatus>('DELETE', `${gbpPath(organizationId)}/binding`);
  }

  disconnectGbp(organizationId: string): Promise<GbpStatus & { googleAuthorization: 'NOT_REVOKED' }> {
    return this.request('POST', `${gbpPath(organizationId)}/disconnect`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) throw new ApiError(401, 'Not signed in.');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? { Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Network failure (offline, DNS, CORS preflight rejection, etc.) —
      // never surface the raw fetch/TypeError to the UI (section 37).
      throw new ApiError(0, 'Unable to reach the Samvardiq API. Check your connection and try again.');
    }

    if (!response.ok) {
      const body = await safeParseJson(response);
      const message = typeof body?.error === 'string' ? body.error : 'Something went wrong. Please try again.';
      throw new ApiError(response.status, message);
    }

    return (await response.json()) as T;
  }
}

const gbpPath = (organizationId: string) => `/v1/organizations/${encodeURIComponent(organizationId)}/integrations/google-business-profile`;

async function safeParseJson(response: Response): Promise<{ error?: unknown } | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
