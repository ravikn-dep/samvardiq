/**
 * Sanitized credential errors (ADR-PLATFORM-001 §8). Every message is fixed
 * and every error carries only a stable `code` — never an identifier,
 * ciphertext, wrapped key, key material, plaintext or an underlying crypto
 * or database error (no `cause` is attached, so nothing leaks through it).
 */
export type CredentialErrorCode =
  | 'access_denied'
  | 'connection_not_found'
  | 'connection_conflict'
  | 'invalid_input'
  | 'credential_unavailable'
  | 'credential_invalid'
  | 'key_unavailable'
  | 'key_ring_invalid'
  | 'key_version_in_use'
  | 'authorization_invalid'
  | 'credential_rejected'
  | 'store_failure';

export abstract class CredentialError extends Error {
  abstract readonly code: CredentialErrorCode;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Wrong principal type or role for the operation. Says nothing about whether the connection exists. */
export class CredentialAccessDeniedError extends CredentialError {
  readonly code = 'access_denied';
  constructor() {
    super('This principal may not perform this credential operation.');
  }
}

/** Not visible under the caller's organization — identical for "another organization's" and "never existed" (RLS hides both). */
export class ConnectionNotFoundError extends CredentialError {
  readonly code = 'connection_not_found';
  constructor() {
    super('The provider connection was not found.');
  }
}

/** A lifecycle operation that the connection's current status does not allow (e.g. attaching a credential to a disconnected connection). */
export class ConnectionConflictError extends CredentialError {
  readonly code = 'connection_conflict';
  constructor() {
    super('The provider connection is not in a state that allows this operation.');
  }
}

export class InvalidCredentialInputError extends CredentialError {
  readonly code = 'invalid_input';
  constructor(field: 'provider' | 'credentialType' | 'externalAccountId' | 'grantedScopes' | 'secret' | 'purpose' | 'redirectUri') {
    super(`Invalid ${field}.`);
  }
}

/** Runtime resolution refused: connection missing, not ACTIVE, or holds no credential of that type. Collapsed into one class so a worker learns nothing it could not act on. */
export class CredentialUnavailableError extends CredentialError {
  readonly code = 'credential_unavailable';
  constructor() {
    super('No usable credential is available for this connection.');
  }
}

/** Authentication failed or the stored envelope is malformed — tampering, transplantation or corruption. */
export class CredentialInvalidError extends CredentialError {
  readonly code = 'credential_invalid';
  constructor() {
    super('The stored credential could not be authenticated.');
  }
}

/** The envelope names a master-key version the key ring does not hold. Never falls back to another key. */
export class KeyUnavailableError extends CredentialError {
  readonly code = 'key_unavailable';
  constructor() {
    super('The master key required for this credential is not available.');
  }
}

/** Key-ring configuration is missing or invalid. Names only the variable, never its value. */
export class KeyRingConfigurationError extends CredentialError {
  readonly code = 'key_ring_invalid';
  constructor(detail: string) {
    super(`Credential master-key configuration is invalid: ${detail}.`);
  }
}

/**
 * Any database failure inside the credential boundary. Replaces the original
 * error because the ORM's query errors embed the statement's parameters —
 * which here include ciphertext and wrapped keys. Keeps only the SQLSTATE.
 */
export class CredentialStoreError extends CredentialError {
  readonly code = 'store_failure';
  constructor(readonly sqlState: string | undefined) {
    super('The credential store operation failed.');
  }
}

function sqlStateOf(error: unknown): string | undefined {
  for (let e = error, depth = 0; typeof e === 'object' && e !== null && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** Runs one credential-store step; a CredentialError passes through, anything else becomes a parameter-free CredentialStoreError. */
export async function sanitizeStoreErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialStoreError(sqlStateOf(error));
  }
}

/** An OAuth state that is unknown, already used, expired, or bound to another organization, human, provider or purpose — deliberately one indistinguishable error. */
export class OAuthAuthorizationInvalidError extends CredentialError {
  readonly code = 'authorization_invalid';
  constructor() {
    super('The authorization request is invalid or has expired. Start again.');
  }
}

/**
 * Thrown BY a provider connector inside a `useCredential` callback when the
 * provider itself rejects the stored credential (e.g. OAuth `invalid_grant`:
 * revoked, expired or replaced at the provider). `useCredential` then moves
 * the connection to NEEDS_REAUTH (audited) and rethrows. Carries nothing from
 * the provider's response.
 */
export class ProviderCredentialRejectedError extends CredentialError {
  readonly code = 'credential_rejected';
  constructor() {
    super('The provider rejected the stored credential. The connection must be re-authorized.');
  }
}

/** A master-key version still wraps stored credentials (or usage could not be proven complete), so it must not be retired. */
export class KeyVersionInUseError extends CredentialError {
  readonly code = 'key_version_in_use';
  constructor(detail: string) {
    super(`The master-key version cannot be retired: ${detail}.`);
  }
}
