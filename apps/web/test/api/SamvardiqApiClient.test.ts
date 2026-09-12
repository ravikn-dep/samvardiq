import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, SamvardiqApiClient } from '../../src/api/SamvardiqApiClient.js';

/** AM/AN/AO of the IDENTITY-W8 adversarial matrix at the client layer — token attachment, no-token behavior, and error sanitization. */

describe('SamvardiqApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the current access token as a Bearer header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const getAccessToken = vi.fn().mockResolvedValue('token-abc');
    const client = new SamvardiqApiClient('https://api.example', getAccessToken);

    await client.listMyOrganizations();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/v1/me/organizations',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } }),
    );
  });

  it('AN: never calls the API at all when no access token is available — fails closed locally', async () => {
    const getAccessToken = vi.fn().mockResolvedValue(null);
    const client = new SamvardiqApiClient('https://api.example', getAccessToken);

    await expect(client.listMyOrganizations()).rejects.toThrow(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AO: a non-2xx response surfaces only the backend\'s own sanitized error message, never raw response detail', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Access denied.' }), { status: 403 }));
    const client = new SamvardiqApiClient('https://api.example', async () => 'token');

    await expect(client.listGoals('org-A')).rejects.toMatchObject({ status: 403, message: 'Access denied.' });
  });

  it('a network failure never leaks a raw fetch/TypeError to the caller', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new SamvardiqApiClient('https://api.example', async () => 'token');

    await expect(client.listGoals('org-A')).rejects.toMatchObject({ status: 0 });
    try {
      await client.listGoals('org-A');
    } catch (error) {
      expect((error as Error).message).not.toMatch(/TypeError|Failed to fetch/);
    }
  });

  it('organizationId is URL-encoded in the goals path', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const client = new SamvardiqApiClient('https://api.example', async () => 'token');
    await client.listGoals('org with spaces');
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/v1/organizations/org%20with%20spaces/goals', expect.anything());
  });
});
