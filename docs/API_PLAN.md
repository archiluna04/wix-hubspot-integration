# API Plan

Which APIs the integration uses for each feature, and why.

## Platform: Wix self-hosted app

The app is a **self-hosted Wix app**: an Express server we host, registered in the Wix Dev Center.

| Wix capability | Used for |
|---|---|
| **Dashboard page extension** (iframe) | The settings UI. Wix appends a signed `instance` param; the server verifies it with HMAC-SHA256 and the app secret before issuing a session. |
| **OAuth client credentials** `POST https://www.wixapis.com/oauth2/token` | Server-to-server access token per site (`instance_id`). No Wix tokens are stored; they're cached in memory for less than 4 hours. |
| **Webhooks** (RS256 JWT, verified with the app's public key) | Change triggers. See the features below. |
| **Embedded Script extension** + `POST /apps/v1/scripts` | Puts the UTM attribution script on the site, with a per-site `siteKey` parameter. |

## Feature #1: Bi-directional contact sync

### Wix → HubSpot

| API | Why |
|---|---|
| Wix webhooks `wix.contacts.v4.contact_created`, `contact_updated`, `contact_deleted` | Push-based triggers for create, update and unlink. The webhook's `identity.appId` tells us if *this app* made the change, which we use as an origin tag. |
| Wix Contacts v4 `GET /contacts/v4/contacts/{id}?fieldsets=FULL` | Always read the fresh contact. Webhook payloads can be stale or out of order. |
| Wix Contacts v4 `POST /contacts/v4/contacts/query` | Match by `primaryInfo.email` before creating, so we don't create duplicates. Also used for backfill paging. |
| Wix Extended Fields `POST /contacts/v4/extended-fields/query` | Lists custom contact fields so they can be mapped. |
| HubSpot CRM Contacts v3 `GET/PATCH/POST /crm/v3/objects/contacts`, `POST /crm/v3/objects/contacts/search` | Read, update, create, and match by email. A `409` on create returns the existing id, which handles races. |

### HubSpot → Wix

| API | Why |
|---|---|
| **HubSpot Webhooks API** (app subscriptions `contact.creation`, `contact.propertyChange`, `contact.deletion`), signature v3 | Push-based triggers. HubSpot sends one event per changed property, so events are debounced per contact (1.5 s) and coalesced into one sync job. |
| Wix Contacts v4 `POST` / `PATCH /contacts/v4/contacts/{id}` (with `revision`) | Create and update. Revision conflicts (409) are refetched and retried. |

*Fallback:* if webhooks can't be configured, the **Sync all existing contacts** button pages through `GET /crm/v3/objects/contacts` and Wix query. The same code path could run on a schedule as polling.

### Properties API

| API | Why |
|---|---|
| HubSpot Properties v3 `GET /crm/v3/properties/contacts` | Fills the HubSpot property dropdown in the mapping UI and flags read-only and calculated properties. |
| `POST /crm/v3/properties/contacts/groups`, `POST /crm/v3/properties/contacts` | Creates the **Wix Integration** group and properties on connect. These hold the external ID (`wix_contact_id`), origin tags (`wix_sync_source`, `wix_sync_id`) and attribution. |

### Conflict handling

The default rule is **last updated wins**. It compares Wix `updatedDate` with HubSpot `updatedAt`, and ties go to HubSpot. "HubSpot always wins" and "Wix always wins" can be chosen in the dashboard. A conflict exists only when *both* sides changed the same bidirectional field since the last sync. Both directions use the same deterministic function, so they always reach the same decision.

### Infinite loop prevention

| Requirement | Implementation |
|---|---|
| External ID mapping | `contact_links` table (`wix_contact_id` ↔ `hubspot_contact_id`), mirrored to HubSpot as `wix_contact_id`. |
| Sync source + correlation ID | Each run gets a `syncId`. It is stored on the link and in the activity log, and written to HubSpot as `wix_sync_id` and `wix_sync_source`. |
| Ignore our own events | (a) Per-side "last synced value" state: an echo never differs from what we recorded, so it's never treated as a change. (b) A 2-minute dedupe window keyed by a hash of what we wrote. (c) Wix events whose `identity.appId` is this app are dropped. (d) HubSpot events for our bookkeeping properties are dropped. |
| Idempotency | We write only the fields whose current target value differs from the desired value. If nothing differs, nothing is written. |

`test/engine.test.ts` simulates webhook echoes against in-memory Wix and HubSpot fakes. It checks that one update produces exactly one write and settles, and runs again with the dedupe window disabled to show that the state check alone prevents loops.

## Feature #2: Form & lead capture (approach 2: Wix Forms → HubSpot)

| API | Why |
|---|---|
| Wix webhook `wix.forms.v4.submission_created` | Fires on every Wix Forms submission. It is enqueued with no delay, so HubSpot is updated within seconds. |
| Wix Forms `POST /form-schema-service/v4/forms/query` (namespace `wix.form_app.form`) | Form name for attribution (best effort). Apps may query forms by namespace with *View Forms*, while Get Form by id is not permitted. |
| Embedded site script → `POST /public/attribution` | Wix submissions carry no UTM data, so the script stores first and latest touch (UTMs, landing page, external referrer) and reports it when a form with an email is submitted. Only a salted SHA-256 hash of the email is stored. Hidden form fields named `utm_*`, `page_url` or `referrer` also work and take priority. |
| HubSpot Contacts v3 search + create/update | Upsert by email. Form fields go to the standard properties. A custom field whose key matches a HubSpot property name is written to that property, and other fields are collected in `wix_last_form_fields`. |

### Where attribution appears in HubSpot

| Property | Semantics |
|---|---|
| `wix_original_utm_{source,medium,campaign,term,content}`, `wix_original_landing_page`, `wix_original_referrer` | First touch. Written only while empty. |
| `wix_latest_utm_{source,medium,campaign,term,content}` | Latest touch. Overwritten on each submission. |
| `wix_last_form_id`, `wix_last_form_name`, `wix_last_form_page_url`, `wix_last_form_referrer`, `wix_last_form_submitted_at` | Context of the latest submission. |
| `lifecyclestage = lead` | Set only if the contact has no lifecycle stage (optional). |

Each submission is also recorded in `form_events` for observability (status, latency, UTM source/medium/campaign, HubSpot id) with no PII, and is shown in the dashboard.

## Security & connection

| Requirement | Implementation |
|---|---|
| OAuth 2.0 to HubSpot, no keys in the frontend | Authorization-code flow in a popup. `state` is a signed JWT bound to the Wix instance plus a one-time nonce. The code is exchanged server-side. |
| Token storage | `SECRET_STORE=gcp` uses **Google Cloud Secret Manager**: each refresh adds a new version and destroys the old ones (rotation). `SECRET_STORE=local` uses AES-256-GCM encryption at rest, with the key held in an env var and never in the DB. |
| Refresh | Proactive refresh 5 minutes before expiry, single-flight per site, plus a reactive refresh on 401. Disconnect revokes the refresh token at HubSpot. |
| Least privilege | `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`. Nothing else. No forms, marketing or other object scopes. |
| Safe logging | A JSON logger redacts token, secret and PII keys and scrubs emails, bearer tokens and long opaque strings from messages. HTTP errors never include response bodies or query strings. |
| Endpoint auth | Dashboard API: Bearer session issued only for a verified Wix instance. Webhooks: Wix RS256 JWT and HubSpot v3 HMAC with a 5-minute replay window. Beacon: rate limited, size limited and schema validated, with no raw PII stored. |
