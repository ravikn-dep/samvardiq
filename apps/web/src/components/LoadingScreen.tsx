/** Section 18: shown while auth/session state is resolving — never flash a protected screen before that resolves. */
export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
      {label}
    </div>
  );
}
