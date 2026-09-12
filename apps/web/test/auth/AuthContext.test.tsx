import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js';

const { getSessionMock, onAuthStateChangeMock, signInMock, signOutMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(),
  signInMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock('../../src/auth/supabaseClient.js', () => ({
  getSession: getSessionMock,
  onAuthStateChange: onAuthStateChangeMock,
  signIn: signInMock,
  signOut: signOutMock,
}));

/** U-AL, AL, AV of the IDENTITY-W8 adversarial matrix — the session state machine, mocking only the Supabase boundary (section 42: never mock the layer under test). */

function Probe() {
  const { state, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      {state.status === 'authenticated' && <span data-testid="token">{state.accessToken}</span>}
      <button onClick={() => void signOut()}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset().mockReturnValue(() => {});
    signInMock.mockReset();
    signOutMock.mockReset();
  });

  it('W: starts loading, then restores an existing session (session restoration)', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'restored-token' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId('status').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(screen.getByTestId('token').textContent).toBe('restored-token');
  });

  it('V: no restorable session -> unauthenticated', async () => {
    getSessionMock.mockResolvedValue(null);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
  });

  it('a later auth-state change (e.g. token refresh or sign-in) updates state reactively', async () => {
    getSessionMock.mockResolvedValue(null);
    let capturedCallback: ((session: { access_token: string } | null) => void) | undefined;
    onAuthStateChangeMock.mockImplementation((cb) => {
      capturedCallback = cb;
      return () => {};
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));

    act(() => {
      capturedCallback?.({ access_token: 'fresh-token' });
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(screen.getByTestId('token').textContent).toBe('fresh-token');
  });

  it('AK: signOut invokes the underlying provider sign-out', async () => {
    getSessionMock.mockResolvedValue({ access_token: 'token' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    screen.getByText('logout').click();
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
  });
});
