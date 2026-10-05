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

## 5. Configure OAuth (later, when GBP-W1 is ready)

- OAuth consent screen: Samvardiq app name, support email, privacy policy URL, and the single scope `https://www.googleapis.com/auth/business.manage`. Google offers no read-only scope; Samvardiq enforces read-only itself.
- Create an OAuth **web application** client. Its redirect URI will be the Samvardiq API callback URL provided at GBP-W1.
- Google may require **OAuth app verification** for this scope before other organizations can connect; until then the app can be used by listed test users. (Verify on the consent-screen page when you configure it.)

## 6. What never goes into chat, documents or Git

- The OAuth **client secret**.
- Any **refresh token** or **access token**.
- Google account passwords or recovery codes.

The client secret will be placed directly into the hosting secret store when GBP-W1 needs it. Tokens are only ever created and stored by Samvardiq's encrypted credential store. Non-secret values (project number, client ID, approval status, quota number) are fine to share.

## 7. What to tell Claude/ChatGPT when ready

"GBP API access approved" plus the non-secret facts: project number, quota now 300 QPM, APIs enabled. GBP-W1 then verifies access with the live API without you pasting any secret.
