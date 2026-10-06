# Google Business Profile Integration — Architecture

**Status:** PRODUCT DECISIONS D1–D8 APPROVED (Founder, 2026-10-05). **Implementation not started.** Platform prerequisites governed by `ADR-PLATFORM-001` (`ARCH-020`, credentials — implemented by PLATFORM-CREDENTIALS-W1, active on staging) and `ADR-PLATFORM-002` (`ARCH-021`, jobs — not implemented).

**Scope:** Samvardiq's first governed external business-intelligence source. GBP is a data source (and later an approved execution channel) feeding the CMO — not a standalone analytics product. Pilot: Dr. Deepthi Orthopaedic Clinic, Hyderabad.

**Canonical inputs:** `docs/03_PRD.md` ("Google Business Profile Intelligence"); `docs/04_Architecture.md` (Connector Framework, Integration Permission Model, Integration Data, Sensitive Data, Automation categories); `packages/marketing-intelligence` (CMO, recommendation contract, `healthcare-local-growth` skill, clinical-data boundary).

---

## 1. Current Google API facts (official documentation, checked 2026-10-05)

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

**Not verified yet (verify during GBP-W1/W2 against the live API):** Business Information / Account Management field-level details; posts (`localPosts`) and media; maximum metric and keyword history; whether `business.manage` requires Google OAuth app verification for production.

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
- **Prerequisite:** an authenticated Samvardiq OWNER requires Supabase Auth on staging (not yet configured).

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

`PLATFORM-CREDENTIALS-W1` → `PLATFORM-JOBS-W1` → `IDENTITY-SUPABASE-AUTH-STAGING` → GBP-W1 (connection, OAuth, location binding) → GBP-W2 (read-only ingestion, backfill, scheduled sync) → GBP-W3 (deterministic evidence builder) → GBP-W4 (weekly CMO brief, recommendations into approval) → GBP-W5 (approved writes) → GBP-W6 (deterministic attribution). External prerequisite: Google approval of GBP API access (`GOOGLE_BUSINESS_PROFILE_ACCESS_SETUP.md`).
