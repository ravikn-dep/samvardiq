# Provider Credential Master Keys — Runbook

**Governs:** `ARCH-020` / `ADR-PLATFORM-001`, implemented by `packages/platform-credentials` (PLATFORM-CREDENTIALS-W1).
**Audience:** the operator (Founder) who provisions and rotates the master-key ring.

This document names environment variables only. **A key value never goes into Git, a document, a chat, a log, a ticket or a screenshot.**

---

## 1. What the key ring is

Each stored provider credential (e.g. an OAuth refresh token) is encrypted with its own random data key (AES-256-GCM). That data key is encrypted ("wrapped") with a **master key**. Master keys live only in the hosting secret store (Railway variables today), never in PostgreSQL. A database dump alone therefore reveals no credential.

| Variable | Content |
|---|---|
| `PROVIDER_CREDENTIAL_MASTER_KEYS` | Comma-separated `<version>:<key>` entries. `<version>` is a positive integer; `<key>` is standard base64 of exactly 32 random bytes (44 characters, ending in `=`). |
| `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION` | The version used for every new or re-wrapped credential. Must be listed in `PROVIDER_CREDENTIAL_MASTER_KEYS`. |

The other listed versions only decrypt. The application **fails closed** if either variable is missing, if any entry is malformed or not 32 bytes, if a version repeats, if two versions share key material, or if the active version is not listed. It never generates a key by itself.

**When it is needed:** only a process that constructs the credential service. As of PLATFORM-CREDENTIALS-W1 no API route or worker does, so **staging/production need no key yet**. Provision it when the first consumer (GBP-W1) ships, before that code is deployed.

**GBP-W1 (2026-10-08):** the API constructs the credential service only when the three `GBP_OAUTH_*` variables are set. Then the key ring is mandatory, and the API refuses to start without a valid one. Set the key-ring variables and the `GBP_OAUTH_*` variables in the same change.

The key ring also derives each in-flight OAuth authorization's PKCE verifier (HKDF, domain-separated; nothing stored). Removing a key version therefore also invalidates authorizations begun under it. They live at most 15 minutes, and the OWNER simply starts again.

## 2. Initial provisioning (once per environment)

1. On a trusted machine, generate the key straight to the clipboard without displaying it (Windows):
   `node -e "process.stdout.write('1:' + require('node:crypto').randomBytes(32).toString('base64'))" | clip`
2. Paste it as the value of `PROVIDER_CREDENTIAL_MASTER_KEYS` in that environment's secret store (e.g. Railway → service → Variables). Set `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION` to `1`.
3. **Offline backup (mandatory):** paste the same value into the password manager entry *"Samvardiq <environment> provider credential master keys"*. Then clear the clipboard. Without this backup, losing the secret store's copy makes every stored credential unrecoverable (§6).
4. Each environment (staging, production) gets its **own** keys. Never copy a key between environments.

## 3. Rotation (new version)

Run when a key may be exposed, when a team member with access leaves, or on the planned schedule (not yet set).

1. **Add** — generate a new key (§2, step 1, with prefix `2:`) and append it: `PROVIDER_CREDENTIAL_MASTER_KEYS` = `1:<old>,2:<new>`. Update the password-manager backup first.
2. **Activate** — set `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION` to `2` and redeploy. **Every** process that uses credentials must run with the new ring before step 3; a process still holding only version 1 would fail with `key_unavailable` on re-wrapped rows. New credentials now use version 2; old ones still open with version 1.
3. **Re-wrap** — for each organization reported by `keyVersionUsage` (admin connection, no key needed), run `CredentialKeyRotation.rewrapOrganization(organizationId)` from a process that has the new ring and the runtime database connection. It re-wraps one credential per transaction (the encrypted secret itself is not touched), is safe to interrupt and safe to re-run. If it stops on a `credential_invalid` row, that credential is damaged: ask the clinic owner to reconnect it (re-authorization replaces it), then re-run.
4. **Verify** — `assertKeyVersionRetirable(adminDb, 1, 2)` must pass. It refuses to run on any connection subject to RLS, because an RLS-filtered count of zero would be meaningless.
5. **Retire** — only then remove `1:<old>` from `PROVIDER_CREDENTIAL_MASTER_KEYS`, redeploy, and mark the old backup entry as retired (keep it until the next rotation, then destroy it).

*Not yet built:* a packaged operator command for steps 3–4. It is deferred to the first real rotation (the library functions and their PostgreSQL proofs exist). Do not hand-edit credential rows.

## 4. Rollback

- **Code rollback:** safe. Older code never reads the credential tables.
- **Schema rollback:** not supported and not needed. Migration `platform-credentials/0000` is additive; leave the tables in place.
- **Activation rollback (during rotation):** set `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION` back to the old version but **keep both keys listed**. Rows already re-wrapped to the new version still need the new key. Re-wrapping again re-wraps everything back to whichever version is active.

## 5. Compromise

| Event | Action |
|---|---|
| A provider credential leaked (not the key) | The clinic owner revokes it at the provider, then disconnects and reconnects in Samvardiq. |
| A master key leaked, database not | Rotate (§3) promptly. |
| Master key **and** database both possibly exposed | Rotate (§3), **and** have every affected organization revoke and reconnect its provider connections. Re-wrapping does not protect a secret whose old envelope may already have been copied with the old key. |

## 6. Disaster: historical key material lost

**There is no credential backup.** Samvardiq stores provider credentials only as envelopes in PostgreSQL. A database backup without the matching master key cannot be decrypted, by design.

If every copy of a version that still wraps credentials is lost:

1. Those credentials are **permanently unrecoverable**. Use returns `key_unavailable`. Connections are *not* automatically set to NEEDS_REAUTH, because a configuration fault must not force reconnection.
2. Identify the affected organizations with `keyVersionUsage` (admin connection).
3. Provision a new key (§2), make it active, and ask each affected clinic owner to re-authorize the connection. Re-authorization replaces the credential without needing the lost key. Disconnect any that will not be re-authorized.
4. *Not yet built:* an operator tool to mark affected connections NEEDS_REAUTH in bulk. It is deferred, so today this is communicated to owners directly.

Prevention: the password-manager backup in §2/§3, updated **before** every change to the secret store.
