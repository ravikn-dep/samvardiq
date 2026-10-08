# Google Business Profile Integration — Architecture

**Status:** PRODUCT DECISIONS D1–D8 APPROVED (Founder, 2026-10-05). GBP-W1 connection decisions **G1–G4 APPROVED** (Founder, 2026-10-08; `ARCH-022`). **GBP-W1 IMPLEMENTED AND VALIDATED LOCALLY — NOT ACTIVATED** (Google API access not yet confirmed; see §9–§11). GBP-W2 onward not started. Platform prerequisites governed by `ADR-PLATFORM-001` (`ARCH-020`, credentials — implemented by PLATFORM-CREDENTIALS-W1, active on staging) and `ADR-PLATFORM-002` (`ARCH-021`, jobs — implemented by PLATFORM-JOBS-W1, active on staging).

**Scope:** Samvardiq's first governed external business-intelligence source. GBP is a data source (and later an approved execution channel) feeding the CMO — not a standalone analytics product. Pilot: Dr. Deepthi Orthopaedic Clinic, Hyderabad.

**Canonical inputs:** `docs/03_PRD.md` ("Google Business Profile Intelligence"); `docs/04_Architecture.md` (Connector Framework, Integration Permission Model, Integration Data, Sensitive Data, Automation categories); `packages/marketing-intelligence` (CMO, recommendation contract, `healthcare-local-growth` skill, clinical-data boundary).

---

## 1. Current Google API facts (official documentation, checked 2026-10-05, re-verified 2026-10-08 for GBP-W1)

| API / source | Fact |
|---|---|
| [Performance API — DailyMetric](https://developers.google.com/my-business/reference/performance/rest/v1/DailyMetric) | `BUSINESS_IMPRESSIONS_DESKTOP_MAPS`, `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`, `BUSINESS_IMPRESSIONS_MOBILE_MAPS`, `BUSINESS_IMPRESSIONS_MOBILE_SEARCH` (multiple impressions by one user in a day count once), `CALL_CLICKS` ("call button was clicked"), `WEBSITE_CLICKS`, `BUSINESS_DIRECTION_REQUESTS`, `BUSINESS_BOOKINGS` (Reserve with Google); `BUSINESS_CONVERSATIONS` and `BUSINESS_FOOD_ORDERS` deprecated |
| [fetchMultiDailyMetricsTimeSeries](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries) | Daily date/value series for a date range; maximum history **not documented** |
| [searchkeywords.impressions.monthly.list](https://developers.google.com/my-business/reference/performance/rest/v1/locations.searchkeywords.impressions.monthly/list) | Monthly; `pageSize` ≤ 100; each keyword has an exact value **or a threshold** |
| [Reviews (v4)](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews) | `list`, `get` (read); `updateReply`, `deleteReply` (write). Fields: `reviewId`, `starRating`, `comment`, `createTime`, `updateTime`, `reviewReply`; reviewer name/photo only when not anonymous; list returns `averageRating`, `totalReviewCount` |
| [Deprecation schedule](https://developers.google.com/my-business/content/sunset-dates) | `reportInsights` and its metrics (`QUERIES_DIRECT`, `QUERIES_INDIRECT`, `VIEWS_*`, `ACTIONS_*`) discontinued 2023-03-30; Q&A API discontinued 2025-11-03 (no replacement); Business Calls API discontinued 2023-05-30; health-provider attributes and insurance networks discontinued 2024-07-01 |
| [Prerequisites](https://developers.google.com/my-business/content/prereqs) | API access requires Google approval (profile verified and active 60+ days, website on the profile, request from an owner/manager email with the Cloud project number); quota 0 QPM until approved, 300 QPM after |
| [Basic setup](https://developers.google.com/my-business/content/basic-setup) / [OAuth](https://developers.google.com/my-business/content/implement-oauth) | OAuth 2.0; **single scope `https://www.googleapis.com/auth/business.manage` (read and write — no read-only scope)**; refresh tokens stored server-side; client secret never client-side |
| [Limits](https://developers.google.com/my-business/content/limits) | 300 QPM per project; 10 edits/minute per profile; HTTP 429 when exceeded |
| [accounts.list](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/list) | `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts`, `pageSize` ≤ 20; resource name `accounts/{id}` (immutable); `type` `PERSONAL` / `LOCATION_GROUP` / `USER_GROUP` / `ORGANIZATION`; the authorizing user's personal account is listed first |
| [accounts.locations.list](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list) | `GET https://mybusinessbusinessinformation.googleapis.com/v1/{parent=accounts/*}/locations`; **`readMask` required**; `pageSize` ≤ 100; resource name `locations/{id}`; a personal account returns only directly owned locations |
| [OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server) / [PKCE](https://developers.google.com/identity/protocols/oauth2/native-app) | `access_type=offline` returns a refresh token on the first exchange (`prompt=consent` forces one); PKCE `S256` supported; `state` must be verified; redirect URIs must **exactly match** a registered URI and use HTTPS except loopback; denial returns `error=access_denied`; revocation endpoint `https://oauth2.googleapis.com/revoke` |
| [Refresh-token expiry](https://developers.google.com/identity/protocols/oauth2#expiration) | Invalidated when the user revokes, after 6 months unused, beyond 100 live tokens per account per client, and **after 7 days while the consent screen is "Testing" with external users** |

No new sunset was announced as of 2026-10-08.

**Not verified yet (verify at GBP-W1 activation / GBP-W2 against the live API):** the exact location-ID alphabet (W1 accepts `[A-Za-z0-9_-]{1,64}` and fails closed otherwise); Business Information / Account Management field-level details; posts (`localPosts`) and media; maximum metric and keyword history; whether `business.manage` requires Google OAuth app verification for production.

**Not available through a current official API — not built, no scraping:** Q&A; competitor profiles; the direct/discovery search split.

## 2. Product decisions (approved)

- **D1 — Read-only W1.** Google's scope permits writes, so read-only is enforced by Samvardiq: no write methods on the connector, no write routes, no autonomous GBP mutation.
- **D2 — P0 dataset:** the four Search/Maps × desktop/mobile impression metrics; `CALL_CLICKS`; `WEBSITE_CLICKS`; `BUSINESS_DIRECTION_REQUESTS`; monthly search keywords; review rating, count, timestamps and reply status; location identity and binding. P1: review text (per D4), categories, hours, website, phone. P2: bookings, posts, media.
- **D3 — Backfill:** request the useful history the provider supports; persist only what Google returns; record gaps explicitly; never invent history.
- **D4 — Review text:** retained for reputation/theme intelligence with a **365-day configurable** retention default. No reviewer identity stored; never matched to CMS patients; never used to infer patient status or diagnosis; treated as untrusted input; not given to external skills by default; never treated as instructions by any model.
- **D6 — Sync cadence (configurable):** daily performance metrics (with a rolling overlap for late corrections); monthly keywords plus a previous-month refresh; reviews every 6 hours.
- **D7 — Future writes documented, not implemented** (see §7).
- **D8 — Withdrawn metrics removed:** direct/discovery searches are no longer modelled; visibility uses Search and Maps impressions with desktop/mobile where available. Corrected in the PRD, `04_Architecture.md`, `GbpSnapshot` and the `healthcare-local-growth` skill on 2026-10-05.

## 3. Authorization and tenancy

- Google OAuth proves access to Google resources only; Samvardiq remains the identity and authorization authority (ADR-IDENTITY-001).
- A human **OWNER** connects a Google account (ADR-PLATFORM-001); accessible locations are listed; the OWNER **explicitly binds** a location to the organization. A location visible to a Google account never implies ownership. A provider location can be bound to at most one organization.
- Sync runs as background jobs under the organization's context (ADR-PLATFORM-002).
- **Prerequisite (met on staging, 2026-10-07):** an authenticated Samvardiq OWNER through Supabase Auth. The Founder is the staging OWNER of `samvardiq-staging-clinic` (staging runbook §30). GBP OAuth must begin from that already-authenticated, OWNER-authorized human; it never creates that authority.

## 4. Data contract (tenant tables, RLS + FORCE RLS)

- Provider connection (non-secret) and credential (encrypted) — ADR-PLATFORM-001.
- **Business location:** organization, connection, provider location ID (unique per provider), display name, primary category, address, phone, website, time zone, status, bound by/at.
- **Metric observation:** location, metric code (Google's identifier verbatim), metric date, value, value state (`reported`, `zero`, `missing`), fetched at, sync run. Missing is never stored as zero. Upsert on location + metric + date.
- **Keyword observation:** location, month, keyword, value **or** threshold, fetched at.
- **Review observation:** provider review ID, rating, created/updated times, has owner reply, reply time, text (D4); no reviewer identity.
- **Sync run:** run status (`succeeded`, `partial`, `failed`), period, counts, sanitized error class, started/finished. Raw provider payloads are kept only as a bounded reference for debugging (short retention), never indefinitely.

## 5. Provenance and attribution

Every observation records organization, location, provider, metric code, period, fetch time, sync run and value state, so staleness and completeness are visible. Evidence older than 48 hours without a successful sync is stale; a CMO brief on stale or partial evidence is flagged or withheld.

| Class | Allowed claims |
|---|---|
| **Direct provider attribution** | Impressions, call-button clicks, website clicks, direction requests, keyword impressions, reviews — exactly as Google defines them |
| **Samvardiq deterministic attribution (later)** | A governed GBP link (website or WhatsApp) → W2 conversation → CMS enquiry/appointment by ID; a tracked call number (future; needs provider API and Google policy verification) |
| **Inference — never presented as fact** | Call-click = call; direction request = visit; website click = appointment; "GBP produced N consultations" |

## 6. CMO use

A deterministic evidence builder computes week-over-week / month-over-month changes and rolling averages for impressions (by surface and device), engagement actions (absolute and per 1,000 impressions), keyword themes, and reputation (rating, count, velocity, unanswered reviews, reply latency). The existing CMO, recommendation contract (evidence, confidence, effort, risk, approval level, success metric, review date) and Approval & Governance layer are reused; no parallel CMO is built.

## 7. Future write actions (D7 — documented, not implemented)

All writes go through Approval & Governance; none is autonomous.

| Risk tier | Examples |
|---|---|
| Lower | Approved corrections to profile metadata (e.g. a wrong website URL) |
| Medium | Posts and content |
| Higher | Public review replies; changes to hours or contact details that affect patient access |

Review replies must never confirm that a person is a patient or disclose clinical information, and never respond to negative reviews with retaliation or profiling.

## 8. Implementation waves

`PLATFORM-CREDENTIALS-W1` → `PLATFORM-JOBS-W1` → `IDENTITY-SUPABASE-AUTH-STAGING` → GBP-W1 (connection, OAuth, location binding — implemented, §9) → GBP-W2 (read-only ingestion, backfill, scheduled sync) → GBP-W3 (deterministic evidence builder) → GBP-W4 (weekly CMO brief, recommendations into approval) → GBP-W5 (approved writes) → GBP-W6 (deterministic attribution). External prerequisite: Google approval of GBP API access (`GOOGLE_BUSINESS_PROFILE_ACCESS_SETUP.md`).

## 9. GBP-W1: connection, OAuth and location binding (implemented 2026-10-08)

### Founder decisions (2026-10-08, `ARCH-022`)

- **G1 (option A): no ARCH-020 amendment.**
  - Using the credential remains service-principal-only.
  - Discovery happens only inside the OWNER's authenticated OAuth completion, using the access token just received from Google, held in memory. Only non-secret account and location references are kept.
  - Refreshing the candidate list in W1 means reconnecting. This is a W1 limitation, not a platform rule.
  - Disconnect is local. Samvardiq deletes its own credential and **never claims to have revoked access at Google**.
- **G2: schema approved with safeguards.**
  - Provider-neutral, single-use OAuth state.
  - GBP candidate and binding persistence.
  - RLS + FORCE RLS, narrow grants, hashed state.
  - The PKCE verifier is protected. Here it is never stored at all.
- **G3 (option A, pilot).**
  - One open Google connection and one bound location per organization.
  - A location is actively bound to at most one organization.
  - The same Google account may re-authorize. A different account requires a controlled disconnect first.
  - Disconnect ends the binding and keeps its history.
  - The two per-organization limits are W1 restrictions, not architecture (see "Multi-location expansion").
- **G4 (option A): authenticated completion.**
  - Google redirects to the Samvardiq web app (or, for the staging proof, an operator's loopback listener).
  - That page posts `{state, code}` to the API **with the OWNER's session**.
  - The API completes only for the same human OWNER and organization that began the flow.

### Flow

Base path: `/v1/organizations/:org/integrations/google-business-profile`.

1. **Begin:** `POST …/authorizations {redirectUri}`, human OWNER only.
   - `redirectUri` must exactly equal an entry in `GBP_OAUTH_REDIRECT_URIS`.
   - `platform-credentials` stores a single-use authorization: the SHA-256 of a 256-bit state, the initiating identity, organization, provider, purpose, redirect URI and key version.
   - It expires after 10 minutes; the database caps the lifetime at 15.
   - The response is Google's consent URL with `scope=business.manage`, `access_type=offline`, `prompt=consent` and `code_challenge_method=S256`.
2. **Complete:** Google redirects to the web callback page, which sends `POST …/authorizations/complete` with `{state, code}` or `{state, error}` and the session. The API then:
   1. re-authenticates (fresh Supabase verification, identity, ACTIVE membership, human OWNER);
   2. **consumes the state first**, with `DELETE … RETURNING`. The delete matches organization, identity, provider and purpose. So a denial, failure or replay always uses up the state, and a different OWNER cannot complete it or use it up;
   3. exchanges the code using the PKCE verifier;
   4. lists accounts and locations (`GET` only);
   5. stores the refresh token through ARCH-020: `connect` for a new connection, or `reauthorize` for the same Google account;
   6. replaces the candidates. A bound location that the account no longer returns is unbound (`LOCATION_NOT_RETURNED`).
3. **Bind, unbind, disconnect:**
   - `POST …/binding {locationName}` accepts only a location among this organization's candidates for its current **ACTIVE** connection. The connection row is share-locked for the transaction, so a concurrent disconnect cannot interleave.
   - `DELETE …/binding` ends the binding.
   - `POST …/disconnect` runs the ARCH-020 local disconnect, then ends bindings of disconnected connections (`CONNECTION_DISCONNECTED`) and removes their candidates. It is idempotent: re-running it finishes an interrupted run. The response includes `googleAuthorization: "NOT_REVOKED"`.
4. **Status:** `GET …/google-business-profile` returns:
   - the connection status (`ACTIVE` or `NEEDS_REAUTH`);
   - the Google account resource name;
   - the binding and the candidates.

   It is non-secret metadata only; response schemas strip anything else.

### PKCE verifier protection

The verifier is never stored. It is computed as:

```
verifier = base64url(HKDF-SHA256(master key[version], ["samvardiq.oauth-pkce.v1", organization, authorization ID]))
```

- At completion it is recomputed using the key version recorded when the flow began.
- A database dump alone cannot produce it.
- A retired key version fails closed.

### Google account identity (G3)

- The connection's `external_account_id` is the `PERSONAL` account resource name from `accounts.list`. Google lists the authorizing user's own account first.
- No `openid` scope is requested, because Google sign-in is not a Samvardiq login.
- If there is no `PERSONAL` account, the flow fails closed.

### Read-only enforcement (D1)

- `GbpReadClient` has exactly two methods, `listAccounts` and `listLocations`.
- Its only request primitive issues `GET` to the two documented read endpoints.
- The package's only `POST` goes to the OAuth token endpoint.
- Tests fail if any of these appears anywhere in the package source:
  - a write verb;
  - a mutating resource (`updateReply`, `localPosts`, media, `:patch`, …);
  - a revocation call;
  - a withdrawn API (Q&A, Business Calls, `reportInsights`).
- An end-to-end test asserts every Business Profile request was a GET.

### Token refresh (service principal only)

- `GbpConnectionService.validateConnection(service, connectionId)` is the W2 entry point. No W1 route calls it.
- It refreshes inside ARCH-020's `useCredential` and makes one read call.
- Access tokens are never stored.
- Google's `invalid_grant` becomes `ProviderCredentialRejectedError`. `useCredential` turns that into `NEEDS_REAUTH`, audited with the service principal as actor. Re-authorizing with the same Google account fixes it.
- Google does not rotate refresh tokens on refresh, so a returned one is ignored. If the old one ever stops working, the same path asks for reconnection.
- Concurrent refreshes are independent, because there is no shared mutable token state.

### Schema (migration authority: G2)

| Table (package, migration) | Holds | Runtime grants |
|---|---|---|
| `provider_oauth_authorizations` (platform-credentials `0001`) | Organization, authorization ID, `state_hash` (SHA-256 hex, globally unique), provider, purpose (`connect`), identity, redirect URI, key version, created and expires (at most 15 min, CHECK) | SELECT, INSERT, DELETE |
| `gbp_location_candidates` (google-business-profile `0000`) | Organization, connection, provider (= `google_business_profile`), `locations/{id}`, `accounts/{id}`, account display name, title, address summary (display text, at most 200/300 characters), discovered at | SELECT, INSERT, DELETE |
| `gbp_location_bindings` (google-business-profile `0000`) | One row per binding episode: organization, binding ID, connection, provider, location, account, title snapshot, bound by/at, unbound by/at, unbind reason (`OWNER_UNBOUND` / `CONNECTION_DISCONNECTED` / `LOCATION_NOT_RETURNED`) | SELECT, INSERT; UPDATE only of `unbound_at`, `unbound_by_identity_id` and `unbind_reason`. History is never deleted |

All three tables have RLS + FORCE RLS on `app.current_org_id`. Candidates and bindings reference the ARCH-020 connection by `(organization_id, connection_id, provider)`.

Partial unique indexes:
- `gbp_location_bindings_active_location_key`: a location is actively bound to only one organization. Permanent (§3).
- `gbp_location_bindings_active_organization_key`: one active binding per organization. **G3 pilot.**
- `gbp_one_open_connection_per_organization`, on `external_provider_connections`: one non-DISCONNECTED GBP connection per organization. **G3 pilot**; other providers are unaffected.

The canonical migration chain runs `google-business-profile` last, because it depends on `platform-credentials`.

### Multi-location expansion (future, not W1)

- Drop `gbp_location_bindings_active_organization_key` to allow several bound locations per organization.
- Drop `gbp_one_open_connection_per_organization` to allow several Google accounts.

Neither step changes identity, credential ownership, tenant isolation, the cross-organization location rule or the binding history. The UX and W2 sync would then iterate over bindings.

### API-hosted callback (evaluated, not built)

- **Benefit:** a `GET` callback on the API, plus a short-lived, single-use handoff to the web session, would keep the authorization code out of the web host's URLs and logs.
- **Cost:** it needs a second single-use token and cookie/redirect handling.
- **Why not now:** the code is already single-use and useless without both the client secret and the server-derived PKCE verifier. G4-A as built is enough for W1.
- Adopting the API-hosted design later is a deviation from G4-A and needs Founder approval.

### Configuration (server only, never in the browser)

Variables:
- `GBP_OAUTH_CLIENT_ID`;
- `GBP_OAUTH_CLIENT_SECRET`;
- `GBP_OAUTH_REDIRECT_URIS`: comma-separated exact URIs; https, or http on 127.0.0.1/localhost; no query or fragment;
- ARCH-020's `PROVIDER_CREDENTIAL_MASTER_KEYS` and `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION`.

Behaviour:
- **None set:** the integration is off. Routes answer 503 after authentication.
- **Partial or malformed, or GBP set without a valid key ring:** the API refuses to start.
- The credential store and the GBP tables share one extra single-connection pool.

### W1 limits

- Discovery reads one page of accounts (at most 20) and at most 5 pages of 100 locations per account. Beyond that it fails closed.
- Provider titles and addresses are display text only: control, zero-width and bidi characters are stripped and length is capped. They are never authority.
- A `409` on binding tells an OWNER that a location they can see is bound by another organization. This is inherent to the cross-organization rule.

## 10. GBP-W1 threat matrix

| | Threat | Control (test) |
|---|---|---|
| A | Unauthenticated initiation | 401 on every route (api `googleBusinessProfile.test.ts`) |
| B, C | VIEWER / MEMBER | `canAdministerProviderConnections` → 403, indistinguishable from a foreign organization |
| D | Service principal | Refused for every OWNER operation; may only `validateConnection` |
| E | OWNER initiation | Full flow, at package and HTTP level |
| F, G, AL | Missing, altered or malformed state | Fastify schema plus `OAuthAuthorizationInvalidError`; the stored authorization is untouched |
| H, N | State or code replay | State row deleted on first use; Google codes are single-use (emulated) |
| I | Expired state | `expires_at > now()` in the consuming DELETE; database cap of 15 min |
| J | Wrong organization | Organization from the route + RLS; another organization's OWNER cannot complete it |
| K, Z | Wrong human / login confusion | Identity is part of the consuming predicate. A different OWNER can neither complete the state nor use it up. Completion needs the session (G4) |
| L, P | Denial / provider error | `{state, error}` consumes the state, stores nothing, returns 400 |
| M | Missing code | Schema `oneOf`; 400 |
| O | Wrong redirect URI | Exact allow-list at begin; the stored URI is reused for the exchange; Google requires an exact match |
| Q | Token-exchange failure | `invalid_grant` → 400; 5xx or network → 503; client errors → 502; nothing stored |
| R | Malformed provider response | Strict token/account/location parsing → 502; nothing stored |
| S, T, U | Credential or connection persistence failure; partial recovery | Sanitized `CredentialStoreError`, nothing stored; an interrupted disconnect finishes when re-run |
| V, W, X, Y | Token leakage (database, logs, errors, browser) | Dump scans in every encoding; captured request logs; errors carry no cause or body; responses schema-stripped. Tokens never leave the server; the browser only holds state and code in transit |
| AA | Enumeration before authorization | Every route authenticates and requires OWNER before any lookup; candidates are RLS-scoped |
| AB, AC | Binding a location not returned, or from another Google account | Must be a candidate of this organization's current ACTIVE connection |
| AD | Cross-organization connection reuse | RLS + composite foreign keys to the organization's own connection |
| AE | Duplicate callbacks | Atomic consume: exactly one of N concurrent completions succeeds. The G3 unique index keeps one open connection under concurrent first connections |
| AF | Refresh race | No stored access token and no rotation, so concurrent refreshes are independent (tested ×3) |
| AG, AI | Revoked credential / refresh failure | `invalid_grant` → `ProviderCredentialRejectedError` → NEEDS_REAUTH (audited); use refused until re-authorized |
| AH | Expired access token | Never stored; every service use refreshes |
| AJ, AK | Google unavailable / rate-limited | 503, nothing stored |
| AM | Metadata injection | Display-text sanitization; only stable resource names act as identity; React renders text |
| AN | Duplicate location binding | Partial unique indexes (location across organizations; one per organization) |
| AO | Disconnect while background work exists | No W1 jobs; `useCredential` refuses a DISCONNECTED connection; bind share-locks the connection |
| AP | Stale OAuth session after membership revocation | Completion re-resolves authority; a revoked OWNER gets 403 before any code exchange |
| (Ponytail) | React StrictMode sending the callback twice | One-shot guard; tested under `StrictMode` |
| (Ponytail) | A Google write capability added later | Source-scan tests fail on write verbs, mutating resources or revoke |

## 11. Activation state

Source implemented and validated locally (real PostgreSQL, emulated Google).

**Not activated:**
- Google Business Profile API access has not been confirmed as approved;
- no Google OAuth client exists;
- no provider-credential master key is provisioned on staging;
- the two migrations are not applied to staging.

Activation steps: `GOOGLE_BUSINESS_PROFILE_ACCESS_SETUP.md` §5–§8 and `docs/infrastructure/SUPABASE_STAGING_RUNBOOK.md` §31.
