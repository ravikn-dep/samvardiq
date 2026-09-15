# Clinic CMS Connector Contract

**Status:** IMPLEMENTED_VALIDATED (CLINIC-W1B-2).
**Purpose:** The canonical, durable record of how Samvardiq integrates with a clinic's CMS (`ravikn-dep/clinic-cms`), closing the documentation gap the CLINIC-W1B status audit found (CLINIC-W1A discovery was never previously committed to either repository — this document, written as part of W1B-2, is that missing artifact).

---

## 1. W1A Discovery Conclusions (Recorded Here for the First Time)

- The clinic's CMS already exposes a versioned, server-to-server REST API (`/api/external/v1`) with HMAC-SHA256 authentication, scoped authorization keys, idempotency, and audit logging — built and hardened independently of Samvardiq.
- **Decision: integrate exclusively through this external API.** Samvardiq never connects directly to the CMS's database and never uses its internal tRPC router. This was a discovery-stage conclusion, reaffirmed and enforced structurally by this connector (see §9).
- Two contract gaps were identified before Samvardiq could depend on the API: no endpoint existed for recording a new enquiry against an *existing* patient, and patient contact numbers were undocumented-as-masked but returned raw. Both were closed in CLINIC-W1B-1.
- `appointments:complete` (OP-completion) was identified as a scope Samvardiq should never request — the CMS treats it as a separately-authorized, higher-trust operation, and Samvardiq has no legitimate reason to mark a clinical encounter complete.

## 2. Dependency Versions

| Repository | Commit SHA | Role |
|---|---|---|
| `ravikn-dep/clinic-cms` | `87e3302a37ec104e5d07b7e9315f6eb690573e4b` | External API contract source of truth (CLINIC-W1B-1 merged) |
| `ravikn-dep/samvardiq` | (recorded at the CLINIC-W1B-2 git checkpoint — see the session's final report) | This connector's implementation |

If clinic-cms's external API contract changes materially, this document and `packages/clinic-cms-connector` must be re-verified against the new SHA before any further connector work proceeds — never assumed compatible.

## 3. Authority Path

```
authenticated principal (Supabase session)
  -> existing Samvardiq authentication/authorization boundary (ADR-IDENTITY-001, unmodified)
  -> TrustedOrganizationContext (the only sanctioned organization-authority object)
  -> application-services/clinicOperationsHandler.ts
       -> ClinicCmsConnectionRepository.getEnabledForOrganization(context.organizationId)
       -> ConnectorSecretProvider.getSecret(connection.secretReference)
       -> ClinicOperationsConnector (packages/clinic-cms-connector)
       -> HMAC-signed HTTP call to the clinic's external API
```

`context.organizationId` — never a raw, caller-supplied organization id — is the only value used to look up a clinic connection. No code path resolves a connection, secret, or connector from anything other than an already-established `TrustedOrganizationContext`. The connector package itself (`packages/clinic-cms-connector`) has no concept of organizations, memberships, or Samvardiq authentication at all — it is handed an already-resolved `{ baseUrl, keyId, secret }` and knows nothing else.

## 4. Source-of-Truth Boundary

| Owned by Clinic CMS | Owned by Samvardiq |
|---|---|
| Patient identity/record, consultant identity, appointment schedule and operational status, checked-in/completed state, enquiry identity and lifecycle | Organization authority, which organization's CMS connection to use, connector execution evidence, cross-channel attribution, future Executive reasoning |

Samvardiq always requests availability and appointment state from the CMS; it never recomputes or caches an independent copy of scheduling logic.

## 5. Supported Operations

| Operation | CMS endpoint | Required scope |
|---|---|---|
| Health check | `GET /health` | `health:read` |
| List consultants | `GET /consultants` | `consultants:read` |
| Read availability | `GET /consultants/:id/slots?date=` | `appointments:read` |
| Find patients | `GET /patients/search?query=` | `patients:read` |
| Register patient | `POST /patients` | `patients:write` |
| Create enquiry for an existing patient | `POST /patients/:patientId/enquiries` | `enquiries:write` |
| Create appointment | `POST /appointments` | `appointments:write` |
| Read appointment | `GET /appointments/:id` | `appointments:read` |
| Reschedule appointment | `POST /appointments/:id/reschedule` | `appointments:write` |
| Cancel appointment | `POST /appointments/:id/cancel` | `appointments:write` |

Only `listConsultants` and `getAvailableSlots` are exposed as Samvardiq Fastify routes today (`GET /v1/organizations/:organizationId/clinic/consultants[...]/slots`) — the remaining operations exist at the connector/application-service layer, fully implemented and tested, but deliberately not yet wired to any route. CLINIC-W1B-2 is connector foundation, not booking UI.

## 6. Explicitly Excluded Operations

`completeAppointment`, `checkIn`, `markNoShow`, and anything billing/consultation/clinical-record-shaped do not exist anywhere in `ClinicOperationsConnector` — not stubbed, not planned, not reachable. `appointments:complete` is never a scope any Samvardiq connection requests.

## 7. Least-Privilege Scopes

A Samvardiq clinic connection should request only the scopes its actual usage needs: `health:read`, `patients:read`, `patients:write`, `consultants:read`, `appointments:read`, `appointments:write`, `enquiries:write`. Never `appointments:complete`.

## 8. HMAC Contract

Exact mirror of the CMS's own algorithm (verified against source, not documentation alone): `HMAC-SHA256(timestamp.requestId.METHOD.path.rawBody)`, lowercase hex digest. `path` excludes the query string (the CMS signs `req.originalUrl.split("?")[0]`). `rawBody` is the exact JSON string sent on the wire — `"{}"` for a bodyless request — serialized exactly once and reused for both signing and the wire body. See `packages/clinic-cms-connector/src/hmacClient.ts` and its reference-vector tests.

## 9. Replay and Idempotency Semantics

Every HTTP attempt — including retries — generates a fresh `x-request-id`, `x-external-timestamp`, and signature; a previous signed attempt is never resent. Logical idempotency (`Idempotency-Key`, stable across retried attempts of the *same* logical mutation) is used for `registerPatient`, `createEnquiry`, and `createAppointment` — the three CMS operations that support it. `rescheduleAppointment` and `cancelAppointment` have no CMS-side idempotency guard; a network-level failure during either is surfaced as `AmbiguousMutationOutcomeError` and never silently retried.

## 10. Retry Policy

Reads and idempotency-keyed writes retry up to 3 attempts with bounded exponential backoff and jitter, only on network failure or a retryable CMS response (429, retryable 5xx). Authentication, authorization, validation, not-found, slot-conflict, and idempotency-conflict responses are never retried.

## 11. Secret Boundary

`ClinicCmsConnection` never stores a raw secret — only a `secretReference` (e.g. `env:CLINIC_ACME_SECRET`), resolved at the point of use by a `ConnectorSecretProvider`. The interim implementation (`EnvConnectorSecretProvider`) resolves from an environment variable; production secret-store selection is explicitly deferred (see "Deferred" in the session's final report) and does not block this connector's use today.

## 12. Data Minimization

Every connector response is a whitelist-projected DTO (`packages/clinic-cms-connector/src/responseValidation.ts`) — built field-by-field from the raw CMS response, never a spread/pass-through. An unexpected or clinical-shaped field in a CMS response can never reach a Samvardiq caller; a required field's absence fails closed with `ConnectorProtocolError` rather than propagating a partial object.

## 13. Error Normalization

Connector-layer failures (`packages/clinic-cms-connector/src/errors.ts`) are classified separately from Samvardiq's existing identity/organization error taxonomy (`application-services/src/clinicErrors.ts`) — a CMS credential/scope/outage problem is a Samvardiq connection misconfiguration, never the calling user's fault, and is never confused with the existing 401/403 "you are not authorized for this organization" vocabulary.

## 14. Connector Execution Evidence

Every connector call records organization-scoped, RLS-protected evidence (`clinic_cms_connector_evidence`): organization, connection, operation, correlation id, safe resource type/id, outcome, retry count, safe error category. No secret, signature, raw request, or raw response is ever a field of this evidence — structurally, not by convention (the schema has no such column).

## 15. Healthcare Data Boundary

No clinical, diagnostic, prescription, treatment, billing, or file/transcript data is modeled, stored, or transmitted anywhere in this connector. Proven adversarially: response projectors are tested against payloads deliberately poisoned with clinical-shaped fields and shown to discard them.

## 16. Testing

- `packages/clinic-cms-connector`: 43 unit tests (HMAC reference vectors, response-validation whitelisting, retry/idempotency/replay against a faithful local re-implementation of the CMS contract, secret provider, connection repository) + 6 real-PostgreSQL RLS integration tests.
- `packages/application-services`: 10 new tests proving the full authority-to-connector orchestration, evidence recording, and fail-closed behavior for missing/disabled connections and unresolved secrets.
- `apps/api`: 8 new tests proving the protected read-slice Fastify routes through the real request pipeline (`.inject()`), including that no route exists for any write or excluded operation.

## 17. Known Limitations / Deferred

- Production secret-store integration (env-backed resolution only, today).
- Write operations (patient registration, enquiry creation, appointment create/reschedule/cancel) have no Fastify route yet — connector-and-application-service layer only.
- No UI of any kind.
- No production clinic connection has been created or activated — this is a foundation, not a live integration.
