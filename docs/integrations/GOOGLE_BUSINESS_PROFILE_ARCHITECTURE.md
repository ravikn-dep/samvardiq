# Google Business Profile Integration — Architecture

**Status:** PRODUCT DECISIONS D1–D8 APPROVED (Founder, 2026-10-05). GBP-W1 connection decisions **G1–G4 APPROVED** (Founder, 2026-10-10; `ARCH-022`, superseding the 2026-10-08 draft). **GBP-W1 IMPLEMENTED AND VALIDATED LOCALLY — NOT ACTIVATED** (Google API access not yet confirmed; see §9–§11). GBP-W2 onward not started. Platform prerequisites governed by `ADR-PLATFORM-001` (`ARCH-020`, credentials — implemented by PLATFORM-CREDENTIALS-W1, active on staging) and `ADR-PLATFORM-002` (`ARCH-021`, jobs — implemented by PLATFORM-JOBS-W1, active on staging).

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

No new sunset was announced as of 2026-10-08. Re-verified 2026-10-10: loopback redirect URIs are exempt from Google's HTTPS and raw-IP rules for web clients; revocation is grant-wide for the project.

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
- A human **OWNER** connects a Google account (ADR-PLATFORM-001); accessible locations are listed; the OWNER **explicitly binds** one or more locations to the organization. A location visible to a Google account never implies ownership. A provider location can be bound to at most one organization.
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

`PLATFORM-CREDENTIALS-W1` → `PLATFORM-JOBS-W1` → `IDENTITY-SUPABASE-AUTH-STAGING` → GBP-W1 (connection, OAuth, service operations, multi-location binding — implemented, §9) → GBP-W2 (read-only ingestion, backfill, scheduled sync) → GBP-W3 (deterministic evidence builder) → GBP-W4 (weekly CMO brief, recommendations into approval) → GBP-W5 (approved writes) → GBP-W6 (deterministic attribution). External prerequisite: Google approval of GBP API access (`GOOGLE_BUSINESS_PROFILE_ACCESS_SETUP.md`).

## 9. GBP-W1: connection, OAuth, service operations and multi-location binding (implemented 2026-10-10)

### Founder decisions (approved 2026-10-10, `ARCH-022`)

These supersede the 8 October 2026 draft of G1 and G3, which was implemented on the unmerged `gbp-w1` branch only and never activated.

- **G1: Modified A. An OWNER requests; a service principal executes.**
  - Human OWNERs administer the connection. No human, OWNER included, ever receives plaintext credentials (ARCH-020 unchanged in that respect).
  - An OWNER may request exactly four things:
    - refresh account/location discovery;
    - verify connection health;
    - revoke access at Google;
    - disconnect.
  - Stored-credential use runs only as the organization's **GBP service principal**, through `ProviderCredentialService.useCredential`, for one allow-listed operation (`GBP_DISCOVER_LOCATIONS`, `GBP_VERIFY_CONNECTION`, `GBP_REVOKE_CONNECTION`).
  - Both the human request and the service outcome are audited.
  - Narrow ARCH-020 amendment: see `ADR-PLATFORM-001.md` → "GBP-W1 amendment".
- **G2: schema approved with safeguards.**
  - Provider-neutral, single-use OAuth state (hashed, PKCE verifier never stored).
  - Location candidates, bindings and an operation audit.
  - RLS + FORCE RLS, narrow grants, database uniqueness.
- **G3: one connection, several locations.**
  - One active GBP connection per organization (the GBP-W1 operational constraint, not permanent architecture).
  - Several explicitly bound locations per organization.
  - A location is actively bound to at most one organization globally (database-enforced).
- **G4: Option A, authenticated human callback.**
  - Google returns to a Samvardiq web page, which posts `{state, code}` to the API with the OWNER's Supabase session.
  - State alone never authorizes.

### Authority chain (G1)

```
Supabase session → verified subject → active human identity → ACTIVE membership → OWNER
  → TrustedOrganizationContext → validated operation request
  → organization's GBP service principal (resolveTrustedContext, fresh)
  → ProviderCredentialService.useCredential → allow-listed Google operation
```

**The service principal:**
- is a `principalType: 'service'` identity `svc-gbp-<organization>`;
- has provider link `samvardiq-gbp-connector` with subject = the organization ID;
- has an ACTIVE `MEMBER` membership in that organization only, and no approver role.

**Provisioning and kill switch:**
- It is provisioned once per organization by an operator (`apps/api/scripts/provisionGbpServicePrincipal.ts`, ADR-IDENTITY-002 Candidate A); it is never created by a request.
- Suspending or revoking its membership is the kill switch: every provider operation then answers 503 before any Google call, and connecting is refused before consent.

**`GbpConnectionService.#execute`, the single path to a stored credential:**
1. Audit the OWNER's request as `REQUESTED` (human actor).
2. Resolve the service principal **for the OWNER's own organization**. The organization is never a parameter, a body field or Google data. A resolver result naming another organization, or a human, is refused (confused deputy).
3. Call `useCredential`. Under RLS, it re-checks the organization, connection ownership and ACTIVE status.
4. Run the operation.
5. Audit `SUCCEEDED`, or `FAILED` with a fixed failure class (service actor).

There is no generic execute or proxy method, and no OWNER decryption path.

### Flow

Base path: `/v1/organizations/:org/integrations/google-business-profile`. Every route authenticates fresh and requires a human OWNER, and no body may name an organization or identity.

| Route | Effect |
|---|---|
| `GET …` | Status: connection (`ACTIVE`/`NEEDS_REAUTH`), Google account resource name, active bindings (with `accessLostAt`), candidates |
| `POST …/authorizations {redirectUri}` | Begin. Exact redirect allow-list; the service principal must resolve; single-use state (10 min, 15-min database cap); consent URL with `business.manage`, `access_type=offline`, `prompt=consent`, PKCE `S256` |
| `POST …/authorizations/complete {state, code \| error}` | Complete (below) |
| `POST …/discovery` | `GBP_DISCOVER_LOCATIONS` |
| `POST …/verify` | `GBP_VERIFY_CONNECTION`: refresh, `accounts.list`, same Google account → `HEALTHY` |
| `POST …/bindings {locationNames[1..25], confirm: true}` | Bind several, all or nothing |
| `DELETE …/bindings/:locationId` | Unbind one (history kept) |
| `POST …/disconnect {revokeGoogleAccess}` | Optional `GBP_REVOKE_CONNECTION`, then local disconnect |

**Completion:**
1. Re-authenticate.
2. Refuse if the service principal no longer resolves, before the state is consumed and the code exchanged.
3. Consume the state with `DELETE … RETURNING`, matching organization, identity, provider and purpose. A denial, failure or replay therefore always uses it up, and a different OWNER can neither complete nor burn it.
4. Exchange the code with the PKCE verifier.
5. Identify the Google account (`PERSONAL` account from `accounts.list`, in-memory token).
6. A different account than the open connection's is refused (`409`) with nothing changed.
7. For the same account, mark every active binding `access_lost_at` (pending revalidation), then `reauthorize`. A new connection uses `connect`.
8. Run `GBP_DISCOVER_LOCATIONS` **on the stored credential** as the service principal.

**Recovery (external side effect):** the token exchange cannot join a transaction.
- If anything after it fails, nothing partial is stored (`connect` is one transaction), the tokens are dropped from memory, and the OWNER starts again.
- If the failure is after a re-authorization, the bindings stay marked unusable until a discovery succeeds (fail closed).
- Samvardiq does **not** auto-revoke a dropped grant, because Google revocation is grant-wide (see revocation below).

### OAuth state and PKCE (G2)

- **State:** 256 random bits. Only its SHA-256 is stored (globally unique), bound to organization, initiating identity, provider, purpose `connect`, redirect URI and key version.
- **Expiry:** 10 minutes (database CHECK ≤ 15).
- **Consumption:** atomic. Exactly one of N concurrent completions wins (tested).
- **PKCE verifier:** never stored:

```
verifier = base64url(HKDF-SHA256(master key[version], ["samvardiq.oauth-pkce.v1", organization, authorization ID]))
```

  It is recomputed at completion, so a database dump alone cannot produce it, and a retired key version fails closed.

### Discovery and binding lifecycle (G3)

- **Discovery** lists every account the grant reaches and every location of each (deduplicated, `readMask=name,title,storefrontAddress`, paginated). Then, in one transaction, and only while the connection is still ACTIVE (share-locked, so a concurrent disconnect wins):
  - the candidates are replaced;
  - active bindings that Google returned get `access_lost_at = null`;
  - active bindings that Google did not return get `access_lost_at = now()` (fail closed for that location only).
- **Discovery never deletes, unbinds or transfers a binding.** A marked binding still holds its location globally, so it is never silently released to another organization.
- **Binding** requires an explicit list plus `confirm: true`. Each location must be a candidate of this organization's current ACTIVE connection. Stable resource names are the only identity; titles and addresses are display metadata and never authority.
- A location already bound in this organization → `409 already_bound`. Bound to another organization → `409 bound_elsewhere` (partial unique index, also under concurrency).
- **Unbind** is per location and idempotent. **Disconnect** ends every binding (`CONNECTION_DISCONNECTED`) and removes candidates. Binding rows are never deleted.
- **Unsupported in W1:** an organization whose locations span several Google accounts can bind only the locations reachable from its one connected Google account. Several connections per organization need a future decision. The schema already keys bindings by connection, so lifting the limit drops one index (`gbp_one_open_connection_per_organization`).

### Token refresh and rotation

- Access tokens are never stored. Each service operation that needs one refreshes inside `useCredential`.
- **Rotation:** Google normally keeps refresh tokens. If a refresh response carries a new one, it is stored via `CredentialInUse.replace`, a compare-and-swap that applies only while the connection is not DISCONNECTED and the credential used is still the stored one. A concurrent rotation, an OWNER re-authorization or a disconnect is therefore never overwritten by an older value, and a disconnected connection is never revived (BF/BN, tested at both layers). A NEEDS_REAUTH set meanwhile by a concurrent use of the superseded token is cleared, because the provider just issued its successor.
- `invalid_grant` → `ProviderCredentialRejectedError` → NEEDS_REAUTH (audited, service actor). Discovery, verify and binding are then refused until a same-account re-authorization heals it.

### Revocation and disconnect

- Local disconnect and Google-side revocation are separate. The OWNER chooses `revokeGoogleAccess` explicitly.
- **Revocation is grant-wide.** Google's documentation says revocation "removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued access or refresh tokens for all clients registered under that project". Revoking therefore also breaks any other Samvardiq organization connected with the same Google user; that organization fails closed to NEEDS_REAUTH. The UI states this before the OWNER confirms.
- **Order:**
  1. Revoke (service principal, stored refresh token, `POST https://oauth2.googleapis.com/revoke`) while the credential still exists.
  2. Run the ARCH-020 local disconnect: DISCONNECTED and ciphertext deleted, so no further Samvardiq use whatever Google answered.
  3. End the bindings and remove the candidates.
- **Outcome `googleRevocation`:**
  - `REVOKED`: only on Google's documented `200`;
  - `FAILED`: any other answer, audited with failure class `gbp_revocation_failed`;
  - `NOT_ATTEMPTED`: no usable credential or service principal;
  - `NOT_REQUESTED`: the OWNER chose a local-only disconnect.
  It is never reported as revoked otherwise.
- Disconnect is idempotent and convergent: re-running it finishes an interrupted cleanup.

### Read-only enforcement (D1)

- `GbpReadClient` has exactly `listAccounts` and `listLocations`, and issues only `GET` to the two documented read endpoints.
- `GoogleOAuthClient` has exactly `authorizationUrl`, `exchangeCode`, `refreshAccessToken` and `revoke`.
- The package's only `POST`s go to `oauth2.googleapis.com/token` and `/revoke`.
- Source-scan tests fail on any write verb, mutating resource (`updateReply`, `localPosts`, media, `:patch`, …) or withdrawn API.
- An end-to-end test asserts every Business Profile request was a GET (BJ).

### Schema (migration authority: G2)

| Table (package, migration) | Holds | Runtime grants |
|---|---|---|
| `provider_oauth_authorizations` (platform-credentials `0001`) | Organization, authorization ID, `state_hash`, provider, purpose (`connect`), identity, redirect URI, key version, created/expires (≤ 15 min CHECK) | SELECT, INSERT, DELETE |
| `gbp_location_candidates` (google-business-profile `0000`) | Organization, connection, provider, `locations/{id}`, `accounts/{id}`, account display name, title, address summary (display text, capped), discovered at | SELECT, INSERT, DELETE |
| `gbp_location_bindings` (google-business-profile `0000`) | One row per binding episode: organization, binding ID, connection, provider, location, account, title snapshot, bound by/at, unbound by/at, unbind reason (`OWNER_UNBOUND` / `CONNECTION_DISCONNECTED`), `access_lost_at` | SELECT, INSERT; UPDATE only of `unbound_at`, `unbound_by_identity_id`, `unbind_reason`, `access_lost_at`. Never deleted |
| `gbp_operation_events` (google-business-profile `0000`) | Append-only audit: organization, event, request (correlation), connection, operation (CHECK: the three allow-listed), phase `REQUESTED` (human) / `SUCCEEDED` / `FAILED` (service, fixed `failure_class`), actor, time | SELECT, INSERT; immutable even for the owner (trigger `prevent_gbp_operation_event_mutation`) |

- All four tables have RLS + FORCE RLS on `app.current_org_id`.
- The GBP tables reference the ARCH-020 connection by `(organization_id, connection_id, provider)`.
- Partial unique indexes:
  - `gbp_location_bindings_active_location_key`: a location is actively bound to one organization globally;
  - `gbp_one_open_connection_per_organization` (on `external_provider_connections`): one open GBP connection per organization (G3); other providers are unaffected.
- The canonical migration chain runs `google-business-profile` after `platform-credentials`.

### Configuration (server only, never in the browser)

**Variables:**
- `GBP_OAUTH_CLIENT_ID` and `GBP_OAUTH_CLIENT_SECRET` (a Google "Web application" client);
- `GBP_OAUTH_REDIRECT_URIS`: comma-separated exact URIs. HTTPS, or http on 127.0.0.1/localhost, which Google exempts from its HTTPS and raw-IP rules for web clients. No query or fragment;
- ARCH-020's `PROVIDER_CREDENTIAL_MASTER_KEYS` and `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION`.

**Behaviour:**
- **None set:** the integration is off; routes answer 503 after authentication.
- **Partial or malformed, or without a valid key ring:** the API refuses to start.
- **Pool budget:** the credential store and GBP tables share one extra single-connection pool, so the staging total is 4 × 3 + 1 (jobs) + 1 (GBP) = 14 of the 15-connection pooler budget. No new pool was added.

### W1 limits

- Discovery reads at most 20 accounts and 5 pages of 100 locations per account. Beyond that it fails closed.
- Binding accepts at most 25 locations per request.
- A `409 bound_elsewhere` tells an OWNER that a location they can see is bound by another organization. This is inherent to the global rule.

## 10. GBP-W1 threat matrix

Tests: `packages/google-business-profile/test/integration/gbpConnection.test.ts` (P), `packages/platform-credentials/test/integration/credentials.test.ts` (C), `apps/api/test/integration/googleBusinessProfile.test.ts` (H), `apps/api/test/integration/humanOwnerProvisioning.test.ts` (S), `apps/web/test/pages/GoogleBusinessProfile.test.tsx` (W), verifier B18 (V).

| | Threat | Control (test) |
|---|---|---|
| A | Unauthenticated initiation | 401 on every route (H) |
| B, C, AA | MEMBER / VIEWER, enumeration | 403 on every route, indistinguishable from a foreign organization (H, P) |
| D | Service principal initiation | Refused for every OWNER operation (P) |
| E | OWNER initiation | Full flow at package and HTTP level (P, H) |
| F, G, I | Missing / altered / expired state | `OAuthAuthorizationInvalidError` before any Google call (P) |
| H, N | State / code replay | State deleted on first use; codes single-use (P) |
| J, K, Z | Wrong organization / human, login confusion | Identity + organization in the consuming predicate; completion needs the session (P) |
| L, M, P | Denial, missing code, provider error | State consumed, nothing stored, 400 (P, H) |
| O | Wrong redirect URI | Exact allow-list; stored URI reused for the exchange (P) |
| Q, R | Exchange failure, malformed response | Classified 400/502/503; nothing stored (P) |
| S, T, U | Persistence failure, partial recovery | Sanitized error, nothing stored, state burned, retry works; interrupted disconnect converges; failed revalidation leaves bindings unusable (P) |
| V, W, X, AU, AV, BM | Token / state leakage (DB, audit, logs, errors, responses) | Dump scans in every encoding incl. `gbp_operation_events`; raw state never stored; captured request logs; schema-stripped responses (P, H) |
| Y, BI | Browser exposure, Supabase Data API from browser | No token reaches the browser; only state/code in transit; the web app uses Supabase only for auth (existing web tests); `anon`/`authenticated` fully revoked (verifier E1) |
| AB, AL | Invalid / malformed location | Must be a candidate; a mixed request binds nothing (P) |
| AC, AY | Wrong / different Google account | Different account refused with nothing changed; candidates RLS-scoped (P) |
| AD, AR | Cross-organization access | RLS + composite FKs; a resolver naming another organization is refused; another organization's principal sees no credential (P) |
| AE, BE | Duplicate / concurrent callbacks | Exactly one completes; one open connection (P) |
| AF, AH, BF | Concurrent refresh, expired access token, stale overwrite | Access tokens never stored; rotation by compare-and-swap; one current credential remains (P, C) |
| AG, AI | Revoked credential, refresh failure | NEEDS_REAUTH (audited); operations refused until re-authorized (P) |
| AJ, AK | Google unavailable / rate-limited | 503; service failures audited with class (P) |
| AM | Metadata injection | Display-text sanitization; React renders text (P, W) |
| AN, AW | Duplicate binding / one location in two organizations | Partial unique index, also under concurrency (P, V) |
| AO, BN | Disconnect during operation, revival race | Discovery writes only under a share lock on an ACTIVE connection; CAS never revives (P, C) |
| AP, BO | Membership revoked / role changed before callback | Re-authorization at completion → 403 before any exchange (H, P) |
| AQ | Service operation without valid OWNER context | Refused before any audit or Google call (P, H) |
| AS | Unapproved operation | Closed TypeScript union, no generic execute, database CHECK on `operation` (P) |
| AT | Human direct credential use | `useCredential` refuses humans (P, C) |
| AX | Several locations in one organization | Bound in one confirmed request (P, H, V) |
| AZ, BA | Same-account reauth; location removed at Google | Bindings revalidated by discovery; a missing location is marked unusable, kept and restored when it returns (P) |
| BB, BP | Candidate treated as binding; binding without confirmation | Discovery never binds; `confirm: true` + explicit list required (P, H, W) |
| BC | Disconnect fails to end bindings | All bindings ended; interrupted run converges (P) |
| BD | Revocation failure reported as success | `REVOKED` only on 200; otherwise `FAILED`, audited distinctly, local disconnect still done (P, W) |
| BG | Verifier modifies persistent Founder data | D5 persistent-data tests pass with the new table (`stagingVerifier.test.ts`) |
| BH | New pool exceeds budget | No new pool; one shared single-connection pool (composition root) |
| BJ | Google write endpoint reachable | Source scans + end-to-end GET-only assertion (P) |
| BK, BL | Worker claims unregistered type; operator script exits 0 on failure | Unchanged from PLATFORM-JOBS-W1 / identity activation (existing tests); the new provisioning script sets `exitCode = 1` on failure |
| (Ponytail) | Kill switch engaged between begin and complete | Refused before the code is exchanged; nothing stored (P) |
| (Ponytail) | Rotation race leaves a valid successor discarded | CAS clears a NEEDS_REAUTH caused by the superseded token (C) |
| (Ponytail) | React StrictMode sends the callback twice | One-shot guard (W) |

## 11. Activation state

Source implemented and validated locally (real PostgreSQL, emulated Google).

**Not activated:**
- Google Business Profile API access is not confirmed as approved;
- no Google OAuth client exists;
- no provider-credential master key is provisioned on staging;
- the migrations are not applied to staging;
- no GBP service principal is provisioned.

Activation steps: `GOOGLE_BUSINESS_PROFILE_ACCESS_SETUP.md` §5–§8 and `docs/infrastructure/SUPABASE_STAGING_RUNBOOK.md` §31.
