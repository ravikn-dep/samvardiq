import { useState, type FormEvent } from 'react';

import { useAuth } from '../auth/AuthContext.js';

/**
 * Section 15/38: minimum acceptable pilot login (email/password),
 * labeled fields, keyboard-accessible, disabled submit + loading state
 * while authenticating, generic error feedback (section 37 — never a
 * distinguishing "wrong password" vs "no such user" message; Supabase's
 * own error is never shown raw).
 */
export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await signIn(email, password);
    setSubmitting(false);
    if (result.error) setError(result.error);
    // On success, AuthContext's own onAuthStateChange subscription updates
    // app-wide state — this component does not navigate itself.
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '20rem' }} aria-label="Sign in to Samvardiq">
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Samvardiq</h1>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
        />

        {error && (
          <p role="alert" style={{ color: '#b00020' }}>
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
