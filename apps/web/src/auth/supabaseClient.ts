import { createClient, type Session } from '@supabase/supabase-js';

/**
 * IDENTITY-W8 — the ONE place `@supabase/supabase-js` is imported
 * (ADR-FRONTEND-001 frontend-boundary rule 5). Every component gets a
 * session/token through this module's functions, never through the raw
 * Supabase client directly.
 *
 * This client proves authentication ONLY (section 6/16) — it never
 * decides organization access. Backend independently re-verifies every
 * token via the existing W3 `SupabaseIdentityProviderAdapter`; this
 * module's only job is obtaining/refreshing the browser's own session.
 *
 * Uses Supabase's own supported session persistence (`localStorage`
 * under Supabase's own key, managed entirely by the SDK) — no second,
 * custom token store is introduced (section 17).
 */
const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export interface AuthResult {
  session: Session | null;
  error?: string;
}

/** Email/password sign-in (section 15 — minimum acceptable pilot login). Never logs the password or the returned token. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { session: null, error: sanitizeAuthError(error.message) };
  return { session: data.session };
}

/**
 * Section 20: invokes Supabase's own sign-out (clears its managed local
 * session). This does NOT claim server-side cryptographic revocation of
 * an already-issued, still-unexpired access token — Supabase does not
 * provide that, and this function never pretends otherwise (see
 * AuthContext's own doc comment for where that limitation is surfaced to
 * the rest of the app).
 */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Current session, if any restorable one exists (section 18 — session restoration on app load). */
export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/**
 * Section 19 (token refresh): used as `SamvardiqApiClient`'s access-token
 * provider. Always reads the CURRENT session via `getSession()` at call
 * time — never a value captured earlier — so a background token refresh
 * (handled entirely by the SDK's own `autoRefreshToken`) is picked up
 * automatically on the very next API call, with no manual refresh logic
 * of this app's own.
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token ?? null;
}

/**
 * Section 19: subscribes to Supabase's own session lifecycle (sign-in,
 * sign-out, and token refresh). The callback receives the CURRENT
 * session on every change — callers never need to manually implement
 * refresh logic; the SDK's own supported behavior handles it.
 */
export function onAuthStateChange(callback: (session: Session | null) => void): () => void {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => subscription.unsubscribe();
}

/** Never surfaces raw Supabase/provider error internals to the UI (section 37). */
function sanitizeAuthError(_rawMessage: string): string {
  return 'Invalid email or password.';
}
