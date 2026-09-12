import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { getSession, onAuthStateChange, signIn as supabaseSignIn, signOut as supabaseSignOut } from './supabaseClient.js';

/**
 * IDENTITY-W8 — the browser session state machine (section 18/19/20).
 *
 * `status: 'authenticated'` means ONLY "Supabase proved this browser
 * holds a valid session" (section 6: browser authentication is NOT
 * organization authorization). It carries no organization, role, or
 * identity data — OrganizationContext (a separate, later step) is where
 * discovery happens, entirely independently, against the backend.
 *
 * Section 20/AL: `signOut` clears the LOCAL session only. It does not
 * and cannot claim the already-issued access token is cryptographically
 * revoked server-side — Supabase does not provide that, and this
 * codebase has never claimed otherwise (see identity-access's own
 * SupabaseIdentityProviderAdapter doc comment for the backend half of
 * this same, already-documented limitation).
 */
export type AuthState = { status: 'loading' } | { status: 'unauthenticated' } | { status: 'authenticated'; accessToken: string };

interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let active = true;

    getSession().then((session) => {
      if (!active) return;
      setState(session?.access_token ? { status: 'authenticated', accessToken: session.access_token } : { status: 'unauthenticated' });
    });

    const unsubscribe = onAuthStateChange((session) => {
      if (!active) return;
      setState(session?.access_token ? { status: 'authenticated', accessToken: session.access_token } : { status: 'unauthenticated' });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      async signIn(email, password) {
        const result = await supabaseSignIn(email, password);
        // No setState here on success — onAuthStateChange fires and updates state;
        // this avoids a race between two independent state-update paths.
        return { error: result.error };
      },
      async signOut() {
        await supabaseSignOut();
      },
    }),
    [state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
