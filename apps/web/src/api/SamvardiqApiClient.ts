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

  private async request<T>(method: string, path: string): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) throw new ApiError(401, 'Not signed in.');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
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

async function safeParseJson(response: Response): Promise<{ error?: unknown } | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
