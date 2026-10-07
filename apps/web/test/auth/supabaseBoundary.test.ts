import { describe, expect, it } from 'vitest';

/**
 * IDENTITY-SUPABASE-AUTH-STAGING / ADR-FRONTEND-001: the browser may use
 * Supabase ONLY to obtain and refresh an authentication session. All business
 * data goes through the Samvardiq API, never through Supabase's Data API, and
 * only the publishable (browser-safe) key may ever be referenced.
 */
const raw = import.meta.glob('../../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sources = Object.entries(raw).map(([path, text]) => ({ path: path.replace('../../src/', ''), text }));

describe('frontend Supabase boundary', () => {
  it('exactly one module imports @supabase/supabase-js', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.filter((s) => s.text.includes("from '@supabase/supabase-js'")).map((s) => s.path)).toEqual(['auth/supabaseClient.ts']);
  });

  it('that module uses only auth session calls — no Data API (.from / .rpc / storage / functions / raw /rest/v1)', () => {
    const client = sources.find((s) => s.path === 'auth/supabaseClient.ts')!.text;
    const calls = [...client.matchAll(/supabase\.(\w+)(?:\.(\w+))?/g)].map((m) => `${m[1]}${m[2] ? `.${m[2]}` : ''}`);
    expect(new Set(calls)).toEqual(new Set(['auth.signInWithPassword', 'auth.signOut', 'auth.getSession', 'auth.onAuthStateChange']));
    for (const s of sources) expect(s.text, s.path).not.toMatch(/\.(from|rpc)\(\s*['"`]|\/rest\/v1|\.storage\.|\.functions\./);
  });

  it('only the publishable key is referenced — never a service-role or secret key', () => {
    const env = new Set(sources.flatMap((s) => [...s.text.matchAll(/import\.meta\.env\.(\w+)/g)].map((m) => m[1])));
    expect(env).toEqual(new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SAMVARDIQ_API_URL']));
    for (const s of sources) expect(s.text, s.path).not.toMatch(/service_role|SERVICE_ROLE|SUPABASE_SECRET|sb_secret_/i);
  });
});
