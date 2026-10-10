# ADR-PLATFORM-001 — External Provider Credential Protection

**Status:** APPROVED — Founder decision A1 (PLATFORM-INTEGRATIONS-W1, 2026-10-05). Recorded as `ARCH-020` in `docs/11_Decisions.md` (verified next-available identifier — `ARCH-019` was the highest recorded).

**Depends on:** `ADR-DATA-001` (`ARCH-015`, PostgreSQL as canonical persistence, provider-portable), `ADR-IDENTITY-001` (`ARCH-016`, `TrustedOrganizationContext`, OWNER/MEMBER/VIEWER), `ADR-IDENTITY-002` (`ARCH-019`, service principals). Implements the credential parts of `docs/04_Architecture.md`'s Connector Framework ("token refresh behavior", "revocation handling"), Integration Data ("token status") and Sensitive Data ("connector credentials … highest level of protection").

**Implementation status:** IMPLEMENTED and **ACTIVE ON STAGING** (`PLATFORM-CREDENTIALS-W1`, `packages/platform-credentials`, migration `platform-credentials/0000_external_provider_credentials`; staging activation 2026-10-05/06, Railway on `0c7dabd`; evidence in `docs/infrastructure/SUPABASE_STAGING_RUNBOOK.md` §28). Dormant at runtime until a consumer ships; no master key provisioned. Production not authorized. See "Implementation" at the end.

---

## Context

Samvardiq's first external business-intelligence integration (Google Business Profile, `docs/integrations/GOOGLE_BUSINESS_PROFILE_ARCHITECTURE.md`) needs per-organization OAuth refresh tokens that are created at runtime when a clinic owner connects their Google account. Google Analytics, Gmail and Meta will need the same.

What exists today (verified against source, 2026-10-05):

- `packages/clinic-cms-connector/src/secretProvider.ts` — `ConnectorSecretProvider` / `EnvConnectorSecretProvider`: **read-only resolution of `env:NAME` references to deployment environment variables.** Suitable for a handful of operator-configured secrets; it cannot store a secret created at runtime by a user, and adding an environment variable per clinic per provider does not scale or rotate.
- `docs/integrations/CLINIC_CMS_CONNECTOR_CONTRACT.md` already lists "production secret-store integration" as deferred.
- No table, key-management code or encryption code for provider credentials exists anywhere in the repository.

## Problem

Store long-lived, per-organization provider credentials (OAuth refresh tokens, and the short-lived access tokens derived from them) so that:

1. **a compromise of the database alone does not reveal any provider credential;**
2. a credential can only ever be used for the organization and provider it was issued for;
3. no credential reaches a browser, a log, an analytics event, an audit payload, a job payload or Git;
4. keys can be rotated and credentials revoked or deleted without downtime;
5. the design does not tie Samvardiq to one hosting or database vendor.

## Decision

**Application-level envelope encryption; authenticated ciphertext stored in PostgreSQL; the master key held outside the database.**

```
platform secret store ──► master key ring (key-encryption keys, versioned)
                               │  wraps/unwraps
                               ▼
application credential boundary (in-process, server only)
   per-credential data key (random) ── AES-256-GCM ──► credential ciphertext
                               │
                               ▼
PostgreSQL: ciphertext + nonces + wrapped data key + key version + org/provider binding (RLS)
```

1. **Primitive:** AES-256-GCM (authenticated encryption) from Node's built-in `node:crypto` (`createCipheriv`/`createDecipheriv`, `setAAD`, `getAuthTag`). No custom cryptography, no third-party crypto library. A fresh random 96-bit nonce for every encryption; the 128-bit authentication tag is stored and always verified.
2. **Envelope:** each credential is encrypted with its own random 256-bit data key; the data key is encrypted ("wrapped") with the current master key. Rotating the master key re-wraps data keys only.
3. **Binding (associated data):** the authenticated associated data is `organization_id`, `provider`, `credential_id`, `credential_type` and the master-key version. A ciphertext copied to another organization's row, another provider or another credential fails authentication.
4. **Master key ring:** versioned 256-bit keys supplied by the hosting platform's secret store (Railway today) as server-only configuration, never in PostgreSQL, Git or the browser. Exactly one version is *active* for new encryption; older versions remain available only for decryption until rotation completes. Hosting is an implementation detail: any secret store or managed KMS can supply the same key ring.
5. **Separation of secrets from metadata:** two tables, following repository conventions (final names in implementation):
   - a **connection** table (non-secret): organization, provider, provider account ID, granted scopes, status (`active`, `needs_reauth`, `revoked`, `disconnected`), access-token expiry, connected by/at, last validated at;
   - a **credential** table (secret): credential ID, organization, provider, credential type (e.g. `oauth_refresh_token`), ciphertext, nonce, auth tag, wrapped data key (+ its nonce/tag), key version, created/rotated/revoked at.
   Access tokens are short-lived and kept in memory; if cached, they are stored the same way.
6. **Tenant isolation:** both tables are organization-scoped with RLS + FORCE RLS (`app.current_org_id`), like every other tenant table. The runtime role gets only the DML the credential lifecycle needs.
7. **Authorization:**
   - connecting, reconnecting and disconnecting a provider: human **OWNER** only (`TrustedOrganizationContext`, ADR-IDENTITY-001 — managing the organization's own external access is "managing the organization itself", the same reading as `canAdministerMembership`);
   - background use (e.g. a sync job, ADR-PLATFORM-002): only through a **capability-specific** boundary — "obtain a usable access token for connection X of organization Y" — which re-checks that the connection is `active`, runs under that organization's context, and returns the token to the caller in memory only. There is no list-all, get-all or cross-organization credential read.
8. **Plaintext handling:** decrypted values exist only in local variables for the duration of one provider call; they are never placed on objects that are logged, serialized, returned from routes, stored in job payloads or included in audit records. Errors from the credential boundary carry a fixed, sanitized class (`credential_unavailable`, `credential_invalid`, `key_unavailable`) — never key material, ciphertext or token fragments.
9. **Revocation and deletion:** disconnecting marks the connection `disconnected`, attempts provider-side revocation where the provider supports it, and **deletes** the ciphertext row (no tombstoned secret). A failed provider revocation is recorded and does not keep the secret.
10. **Audit:** connection created / re-authorized / disconnected / credential rotated / decryption failed are audited with IDs, actor and outcome only.

## Security properties and failure behaviour

| Situation | Behaviour |
|---|---|
| Database dump stolen, master key not | Credentials unreadable (data keys are wrapped by a key the database never holds) |
| Master key stolen, database not | Nothing to decrypt; rotate the key ring |
| Ciphertext moved to another organization, provider or credential row | GCM authentication fails (associated-data mismatch) → fail closed |
| Ciphertext or tag tampered/corrupted | Authentication fails → fail closed, `credential_invalid`, connection set to `needs_reauth` |
| Key version referenced but missing from the key ring | `key_unavailable` → fail closed; no fallback to another key |
| Active key missing at startup | Credential features refuse to operate (fail closed); the rest of the API is unaffected |
| Rotation interrupted | Each credential is re-wrapped in its own transaction (old version → new version, conditional on the old version); a partially rotated set is valid because every row names its version |
| Disconnected or revoked connection | Token boundary refuses (status check) before any decryption |
| Plaintext logged / in errors / returned from an API / in a job payload | Prevented by construction (no plaintext on serializable objects, sanitized errors, payloads carry IDs only) and covered by tests |
| Secret in Git | Key ring only in the platform secret store; repository secret scan in validation |

## Key management and rotation

- Key ring format and environment variable names are implementation details of `PLATFORM-CREDENTIALS-W1`; the contract is: versioned keys, one active version, older versions decrypt-only.
- **Rotation:** add new version → mark it active (new encryptions use it) → run an operator re-wrap of existing credentials (decrypt data key with old version, re-wrap with new, conditional update) → verify no row references the old version → remove the old version from the key ring.
- **Compromise of a credential (not the key):** revoke at the provider, disconnect, reconnect.
- **Compromise of the master key:** rotate the key ring and re-wrap; if database exposure is also suspected, revoke and reconnect every affected provider connection.

## Portability

The encrypted format is self-describing (key version, algorithm) and independent of Railway and Supabase. Moving the key ring to a managed KMS later means replacing "unwrap/wrap data key with master key" by a KMS call; ciphertext rows and the application boundary stay the same.

## Alternatives considered

1. **Encrypted credentials in PostgreSQL with an application/platform-held key — CHOSEN.** Meets the core property (database compromise alone reveals nothing), uses only Node's standard library, keeps PostgreSQL the single source of truth with existing RLS, and adds no new vendor.
2. **Supabase Vault — rejected for now.** Key custody and decryption live inside the database platform, so a sufficiently privileged database compromise is closer to a credential compromise; it couples credential protection to Supabase, against `ADR-DATA-001`'s portability, and duplicates RLS concerns in a second mechanism.
3. **External managed secret manager / KMS (e.g. a cloud KMS or secrets service) — deferred, not rejected.** Strongest key custody and audit, but adds a vendor, network dependency, IAM setup and cost before Samvardiq has a single live connection. The chosen format allows migrating the master-key role to a KMS later without re-architecting.
4. **Environment variable per credential (extend `EnvConnectorSecretProvider`) — rejected.** Cannot store user-created secrets at runtime, does not scale per organization, no rotation.
5. **Plaintext tokens protected only by RLS — rejected.** A database dump reveals every credential.

## Consequences

- New platform module and two tenant tables (`PLATFORM-CREDENTIALS-W1`), plus the staging verifier inventory and schema-first deployment order.
- A new platform secret (the master key ring) must be provisioned in the hosting secret store before credential features can run; losing every copy makes stored credentials unrecoverable (owners reconnect), so the key ring needs an offline backup procedure in the runbook.
- `EnvConnectorSecretProvider` remains for operator-configured secrets (e.g. CMS HMAC secrets); migrating those onto this store is a later, separate decision.

---

## Implementation (PLATFORM-CREDENTIALS-W1, 2026-10-05)

Provider-neutral; no provider API, OAuth flow, route or worker is included. Operations: [`docs/infrastructure/PROVIDER_CREDENTIAL_KEYS_RUNBOOK.md`](../infrastructure/PROVIDER_CREDENTIAL_KEYS_RUNBOOK.md).

**Module:** `packages/platform-credentials`, its own migration journal (`drizzle_platform_credentials`). It exports only the service boundary, rotation, key ring and errors; the envelope primitives and tables are internal.

**Tables (RLS + FORCE RLS, keyed on `app.current_org_id`):**

| Table | Holds | Runtime grants |
|---|---|---|
| `external_provider_connections` | organization, connection ID, provider (`^[a-z][a-z0-9_]{1,62}$`), external account ID (nullable), status `ACTIVE`/`NEEDS_REAUTH`/`DISCONNECTED`, granted scopes, connected by/at, disconnected at, updated at | SELECT, INSERT; UPDATE on lifecycle columns only; no DELETE |
| `external_provider_credentials` | envelope: ciphertext, payload nonce/tag, wrapped data key, wrap nonce/tag, key version, key check value, algorithm `AES-256-GCM`, credential type, created/rotated at | SELECT, INSERT, DELETE; UPDATE on the wrap columns only (rotation); the ciphertext is never updated in place |
| `external_provider_credential_events` | append-only audit: event type, connection/credential ID, actor, key version | SELECT, INSERT; immutable via a trigger (owner included) |

A composite foreign key (`organization_id, connection_id, provider`) keeps a credential's provider equal to its connection's. The design reduced the ADR's status list to the three statuses that have a writer. `revoked` is not a stored status: remote revocation is a connector action, not a local state.

**Cryptography:** as decided above, with these implementation details.
- The AAD is a canonical JSON array (`["samvardiq.provider-credential.v1", layer, organization, provider, credential ID, credential type(, key version)]`). JSON quoting makes it unambiguous.
- The key version is bound on the wrap layer, which is the only layer it governs. Rotation therefore re-wraps the data key and never touches the encrypted secret.
- The resolve path builds the AAD from the caller's organization, the connection's provider and the requested type, not from the row alone.
- The tag length is pinned to 16 bytes, so a truncated tag is rejected.
- A 16-byte key check value (HMAC-SHA256 of a fixed label under the master key) separates two failures. A wrong or missing key gives `key_unavailable`, an operator fault that changes no state. An altered or transplanted envelope gives `credential_invalid`, which moves the connection to NEEDS_REAUTH and is audited.

**Authorization (no new model):**
- Administration (connect, re-authorize, disconnect, inspect metadata) requires `principalType === 'human' && role === 'OWNER'`. This is the `canAdministerMembership` reading.
- Plaintext use requires `principalType === 'service'`, i.e. a `TrustedOrganizationContext` from the unmodified `resolveTrustedContext` (ADR-IDENTITY-002, Candidate A). No human, OWNER included, can obtain plaintext.
- Use is scoped to the context's organization by RLS, and any service principal of that organization may use its connections. Narrowing that to a specific service identity per connection or purpose is ADR-IDENTITY-002's deferred Candidate B, not built here.

**Plaintext lifetime:** `useCredential(actor, connectionId, type, use)` passes the plaintext Buffer to the callback and zero-fills it when the callback settles. It never returns plaintext. This is best-effort only: JavaScript cannot guarantee erasure, because V8 or the callback (e.g. an HTTP header string) may hold copies until garbage collection.

**Disconnection:** `disconnect` sets DISCONNECTED and deletes every ciphertext of the connection in one transaction, and is idempotent. It returns `remoteRevocation: 'NOT_ATTEMPTED'`: the provider connector must revoke remotely (using `useCredential`) *before* local disconnection. The generic layer never claims a remote revocation.

**Audit:** this module uses its own append-only table rather than `identity_audit_events`, whose closed CHECK lists are scoped to identity, membership and provider-link events. The table follows the same pattern as `identity_audit_events` and `conversation_handoffs`: INSERT/SELECT only, an immutability trigger, RLS, identifiers only, and the same transaction as the change it records. Events recorded:
- CONNECTION_CREATED, CREDENTIAL_STORED, CREDENTIAL_REPLACED, CREDENTIAL_DELETED and CONNECTION_DISCONNECTED (human OWNER actor);
- CONNECTION_NEEDS_REAUTH (service actor);
- CREDENTIAL_REWRAPPED (system actor).

`key_unavailable` failures are not persisted, because they are operator faults with no state change.

**Rotation:** `CredentialKeyRotation.rewrapOrganization` re-wraps one credential per transaction, conditional on the version it read. The runtime role cannot enumerate organizations, so the operator supplies them. `keyVersionUsage` and `assertKeyVersionRetirable` refuse to run on any connection subject to RLS, so they can never certify a still-referenced key as retirable.

**Verification:** 29 unit tests and 21 real-PostgreSQL tests (threat matrix A–AT). The staging verifier now expects 20 tables, 5 triggers, 5 own functions, column-level UPDATE grants, envelope columns only in `external_provider_credentials`, and behavior check B16 (the credential service as `samvardiq_app`).

---

## First consumer and GBP-W1 amendment (2026-10-10, implemented, not activated)

Founder decision G1 (`ARCH-022`, Modified A) amends this ADR **narrowly**. Everything above stays in force, in particular: no human, OWNER included, can obtain plaintext, and only service principals use credentials. The amendment adds three things.

1. **OWNER-requested service operations.**
   - A human OWNER may request a provider operation that uses the stored credential. It is executed by the organization's own service principal, never by the human.
   - The provider connector must:
     - resolve that principal fresh through `resolveTrustedContext`, for the OWNER's organization only;
     - run one allow-listed operation inside `useCredential`;
     - audit the human request and the service outcome separately.
   - For GBP, the operations are `GBP_DISCOVER_LOCATIONS`, `GBP_VERIFY_CONNECTION` and `GBP_REVOKE_CONNECTION`.
   - The principal is a dedicated per-organization identity (`samvardiq-gbp-connector` link), operator-provisioned (ADR-IDENTITY-002 Candidate A).
   - There is no generic OWNER credential-use path.
2. **Provider-rotated credentials (§7).**
   - `useCredential` hands its callback a `CredentialInUse` whose `replace(secret)` stores a provider-issued successor (e.g. a rotated OAuth refresh token) as the service principal.
   - It is a compare-and-swap: it applies only while the connection is not DISCONNECTED and the credential used is still the stored one. A concurrent rotation, an OWNER re-authorization or a disconnect is never overwritten, and a disconnected connection is never revived.
   - The successor gets a new credential ID. The swap is audited as `CREDENTIAL_DELETED` + `CREDENTIAL_REPLACED` with a service actor.
   - A NEEDS_REAUTH caused meanwhile by a concurrent use of the superseded credential is cleared.
3. **Remote revocation (§9).** The connector revokes through `useCredential` *before* the generic local disconnect, as this ADR already required, and reports the provider's outcome truthfully. The generic `disconnect` still returns `remoteRevocation: 'NOT_ATTEMPTED'`.

Provider-neutral additions to `packages/platform-credentials`:

- **`ProviderOAuthAuthorizations`** (migration `0001_provider_oauth_authorizations`, table `provider_oauth_authorizations`):
  - single-use OAuth state, human OWNER only, bound to organization, identity, provider and purpose;
  - only `SHA-256(state)` is stored;
  - consumed by `DELETE … RETURNING`;
  - 10-minute expiry, capped at 15 minutes in the database;
  - RLS + FORCE RLS; grants SELECT, INSERT, DELETE.
- **PKCE verifier:** never stored. It is re-derived with HKDF from the master key version recorded at begin, with the domain label `samvardiq.oauth-pkce.v1`, the organization and the authorization ID. The key ring is used for derivation as well as wrapping, with domain separation, just as the key check value already uses it for an HMAC.
- **`findOpenConnection(actor, provider)`:** OWNER-only, non-secret metadata of the organization's open connection to a provider.
- **`ProviderCredentialRejectedError`:** a provider connector throws it inside `useCredential` when the provider rejects the stored credential (e.g. OAuth `invalid_grant`). `useCredential` then moves the connection to NEEDS_REAUTH (same guarded, audited transition as a tampered envelope) and rethrows.
- **Duplicate-connection policy for GBP:** at most one open Google Business Profile connection per organization (G3, the GBP-W1 operational constraint). It is enforced by a partial unique index that the `google-business-profile` migration places on `external_provider_connections`. Other providers keep the generic behaviour.

Details: `docs/integrations/GOOGLE_BUSINESS_PROFILE_ARCHITECTURE.md` §9–§11.
