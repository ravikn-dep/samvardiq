# Google Business Profile API — Access Setup (Founder Runbook)

**Purpose:** the external steps that must happen in Google before Samvardiq can read a Business Profile. Nothing here connects an account or creates a Samvardiq credential; that happens later in GBP-W1 through the OWNER-only connection flow (`ADR-PLATFORM-001`).

**Sources (official, checked 2026-10-05):** [Prerequisites](https://developers.google.com/my-business/content/prereqs) · [Basic setup](https://developers.google.com/my-business/content/basic-setup) · [Implement OAuth](https://developers.google.com/my-business/content/implement-oauth) · [Limits](https://developers.google.com/my-business/content/limits). Google changes these pages; re-check them when you start.

---

## 1. Check eligibility (Google's requirements)

- The Business Profile is **verified and active for 60+ days**.
- The profile lists a **website** that represents the business.
- You use an email address that is an **owner or manager** of the profile.

## 2. Create the Google Cloud project

1. In the Google Cloud Console, create one project for Samvardiq (one project serves all clinics; each clinic later connects its own Google account).
2. Note the **project number** (needed for the access request).

## 3. Request Business Profile API access

1. Submit Google's Business Profile API access request form (linked from the Prerequisites page) with the project number, from the owner/manager email.
2. Wait for approval. **How to check:** in the Cloud Console, the Business Profile APIs' quota shows **0 QPM until approved** and **300 QPM after approval**.

## 4. After approval: enable the APIs

Enable the Business Profile APIs listed on Google's Basic setup page (it currently lists Google My Business API, My Business Account Management API, My Business Business Information API, My Business Notifications API, My Business Verifications API, My Business Lodging API and My Business Place Actions API), plus the **Business Profile Performance API** (metrics and search keywords). Samvardiq W1 only reads accounts, locations, performance, keywords and reviews.

## 5. Configure OAuth (GBP-W1 is implemented; do this after approval)

Re-checked against Google's documentation on 2026-10-08.

**Consent screen:**
- Samvardiq app name, support email, privacy policy URL.
- The single scope `https://www.googleapis.com/auth/business.manage`. Google offers no read-only scope; Samvardiq enforces read-only itself (architecture §9).
- No `openid`/email/profile scope is needed: Google is not a Samvardiq login.

**Publishing status "Testing":**
- Add the Google account that manages the clinic's profile as a **test user**.
- Google expires refresh tokens issued to "Testing" apps with external users **after 7 days**, so a staging connection then shows "Needs reconnection" and the OWNER reconnects. Production use needs Google's OAuth app verification for this scope (decided at production readiness, not now).

**OAuth client:**
- Create a **Web application** client.
- **Authorized redirect URIs** must match exactly, character for character. For the staging proof, register the loopback URI `http://127.0.0.1:53682/callback`; Google allows plain http only for loopback.
- When the web app is deployed, also register `https://<web app host>/integrations/google-business-profile/callback`.
- No JavaScript origin is needed: the browser never calls Google with the client.

## 6. What never goes into chat, documents or Git

- The OAuth **client secret**.
- Any **refresh token** or **access token**.
- Google account passwords or recovery codes.

The client secret will be placed directly into the hosting secret store when GBP-W1 needs it. Tokens are only ever created and stored by Samvardiq's encrypted credential store. Non-secret values (project number, client ID, approval status, quota number) are fine to share.

## 7. What to tell Claude/ChatGPT when ready

"GBP API access approved" plus the non-secret facts: project number, quota now 300 QPM, APIs enabled. GBP-W1 then verifies access with the live API without you pasting any secret.

## 8. GBP-W1 staging activation checklist (each item confirmed before any live OAuth)

1. **Google Cloud project:** owned by the Founder's Samvardiq Google account; project number noted.
2. **Business Profile API access approved:** the quota shows 300 QPM, not 0.
3. **APIs enabled:** the §4 list. W1 calls only the Account Management API (`accounts.list`) and the Business Information API (`accounts.locations.list`).
4. **Consent screen:** configured per §5, with the clinic's managing Google account as a test user.
5. **Web OAuth client:** created, with `http://127.0.0.1:53682/callback` registered exactly.
6. **Railway variables**, entered by the Founder directly in Railway, never in chat:
   - `GBP_OAUTH_CLIENT_ID`: the client ID (non-secret);
   - `GBP_OAUTH_REDIRECT_URIS`: `http://127.0.0.1:53682/callback`;
   - `GBP_OAUTH_CLIENT_SECRET`: the client secret;
   - `PROVIDER_CREDENTIAL_MASTER_KEYS` and `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION`: generated and backed up per `docs/infrastructure/PROVIDER_CREDENTIAL_KEYS_RUNBOOK.md`.

   Set all of them together. With any one missing, the API refuses to start, which is deliberate: it fails closed rather than half-enabling OAuth.
7. **Staging migrations** `platform-credentials/0001` and `google-business-profile/0000` applied through the canonical chain, before the deployment that uses them (schema first; runbook §31).
