# Wix ↔ HubSpot Integration

A self-hosted Wix app that lets site owners:

1. **Connect HubSpot** with OAuth 2.0 from the Wix dashboard. Tokens are stored in a secret store and are never sent to the browser.
2. **Map fields** in a table UI (Wix field, HubSpot property, direction, transform, default value) with validation.
3. **Sync contacts both ways** (create and update), with conflict handling and loop prevention.
4. **Send Wix Forms submissions to HubSpot** with UTM and source attribution, page URL, referrer and timestamp.

See **[docs/API_PLAN.md](docs/API_PLAN.md)** for the APIs used for each feature and the design decisions.

## Architecture

```
Wix site ── Embedded script ──► POST /public/attribution ─┐
Wix Dashboard ─ iframe ─► /dashboard ─► /api/* (session) ─┤
Wix webhooks (RS256 JWT) ─────► /webhooks/wix ────────────┤     ┌──────────────┐
HubSpot webhooks (HMAC v3) ───► /webhooks/hubspot ────────┼───► │ SQLite queue │──► SyncEngine / FormCapture
HubSpot OAuth popup ──────────► /oauth/hubspot/callback ──┘     └──────────────┘        │           │
                                                                                Wix REST APIs  HubSpot CRM v3
Tokens: Secret Manager (GCP) or AES-256-GCM encrypted store
```

| Path | Responsibility |
|---|---|
| `src/sync/engine.ts` | Two-way sync, conflict resolution, loop prevention, idempotency |
| `src/sync/mapping.ts`, `src/sync/wixFields.ts` | Mapping model, validation, transforms, Wix field accessors |
| `src/sync/queue.ts` | Durable job queue: debounce, dedupe, retries with backoff |
| `src/forms/formCapture.ts` | Wix form submission → HubSpot lead with attribution |
| `src/hubspot/*` | OAuth, token manager (refresh/rotation), CRM client, webhook signature |
| `src/wix/*` | App auth (client credentials), REST client, webhook JWT verification |
| `src/secrets/secretStore.ts` | GCP Secret Manager and local AES-GCM stores |
| `src/routes/*` | Dashboard API, OAuth, webhooks, public endpoints |
| `public/` | Dashboard UI, OAuth popup page, `embed/attribution.js` site script |

## Setup

### 1. HubSpot app

The HubSpot app is a **project-based app** (platform 2025.2), defined in [`hubspot-project/`](hubspot-project):

- `src/app/app-hsmeta.json`: OAuth (`auth.type: oauth`), the redirect URL, and the least-privilege scopes.
- `src/app/webhooks/webhooks-hsmeta.json`: the webhook target URL and the `contact.creation`, `contact.deletion` and `contact.propertyChange` subscriptions (`email`, `firstname`, `lastname`, `phone`, `company`, `jobtitle`). Add a subscription for any other property you map.

```bash
npm install -g @hubspot/cli
hs account auth                 # sign in with a personal access key
npm run hubspot:configure       # writes APP_BASE_URL from .env into the project files
cd hubspot-project && hs project upload
```

Then open HubSpot → **Development → Projects → wix-hubspot-sync → the app → Auth**, and copy the **Client ID** and **Client secret** into `.env`. Re-run `hubspot:configure` and `hs project upload` whenever your public URL changes.

### 2. Wix app (Custom Apps → Create App → Self-managed → Start From Scratch)

1. **Develop → OAuth**: copy the **App ID** and **App secret**.
2. **Develop → Extensions → Dashboard Page**: set the iFrame URL to `https://<APP_BASE_URL>/dashboard`.
3. **Develop → Extensions → Embedded Script** (type *Analytics*, placement *HTML Head*). Use one of these forms:
   - On a normal HTTPS host:
     ```html
     <script src="https://<APP_BASE_URL>/embed/attribution.js" data-site-key="{{siteKey}}" async></script>
     ```
   - On a free ngrok tunnel (ngrok answers browser script requests with an HTML warning page): paste the inline version printed by `npm run -s embed:snippet`.

   The app fills in `{{siteKey}}` for each site automatically.
4. **Develop → Permissions** (least privilege):

   | Permission | Scope | Used for |
   |---|---|---|
   | Manage Contacts | `SCOPE.DC-CONTACTS.MANAGE-CONTACTS` | Read, create and update contacts |
   | Manage Contact Extended Fields | `SCOPE.DC-CONTACTS.MANAGE-EX-FIELDS` | List custom contact fields for the mapping UI (Wix offers no read-only scope) |
   | Read Submissions | `SCOPE.DC-FORMS.READ-SUBMISSIONS` | Wix Forms submission webhook |
   | View Forms | `SCOPE.FORMS.VIEW-FORM` | Form name for attribution |
   | Manage Embedded Scripts | `SCOPE.DC-APPS.MANAGE-EMBEDDED-SCRIPTS` | Turn on the attribution script |

   After changing permissions, open **Test App** again and accept the update on the site.
5. **Develop → Webhooks**: set the callback URL to `https://<APP_BASE_URL>/webhooks/wix` for *App Installed*, *App Removed*, *Contact Created / Updated / Deleted* and *Submission Created* (Wix Forms). Click **Get Public Key** and put it in `WIX_PUBLIC_KEY`.
6. **Test App → Test on dev site** to install it, then open **HubSpot Sync** in the site dashboard.

### 3. Run

```bash
npm install
cp .env.example .env      # fill in values (see comments in the file)
npm run dev               # or: npm run build && npm start
npm test                  # unit + loop-prevention simulation tests
```

Wix and HubSpot must reach the server over HTTPS. For local development, run `ngrok http 3000` and set `APP_BASE_URL` to the tunnel URL. With `DEV_LOGIN_ENABLED=true`, `/dashboard?dev=1` opens the UI without Wix, which is useful for testing the HubSpot connection and the mapping UI.

### 4. Deploy (example: Cloud Run + Secret Manager)

```bash
gcloud run deploy wix-hubspot --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,SECRET_STORE=gcp,GCP_PROJECT_ID=<project>,APP_BASE_URL=https://<service-url> \
  --set-secrets SESSION_SECRET=session-secret:latest,WIX_APP_SECRET=wix-app-secret:latest,HUBSPOT_CLIENT_SECRET=hubspot-client-secret:latest \
  --set-env-vars WIX_APP_ID=...,HUBSPOT_CLIENT_ID=...,WIX_PUBLIC_KEY=...
```

The service account needs `roles/secretmanager.admin` on the project, so it can create a secret per site and rotate its versions. SQLite holds no secrets. For multiple instances, mount a persistent volume or move the `Store` to Postgres; the store is the only persistence layer.

## Using the app

1. Install the app on a Wix site and open it from the dashboard.
2. Click **Connect HubSpot** and approve the permissions in the popup. The app creates the **Wix Integration** property group in HubSpot.
3. Adjust the **Field mapping** and click **Save mapping**. Sync applies the new rules right away, with no code changes.
4. Optionally click **Sync all existing contacts** to backfill.
5. Edit a contact on either side. The change appears on the other side within a few seconds, and the **Activity** tab shows each sync, including skipped echoes (`no mapped changes`, `own write echo`, `origin is this app`).
6. Submit a Wix form from a URL with `?utm_source=…&utm_campaign=…`. The HubSpot contact gets the `wix_latest_utm_*` and `wix_original_utm_*` properties, and the **Form submissions** tab shows the result.

## Behaviour notes

- **Identity**: contacts are matched by the link table first, then by email. A contact without an email is not synced.
- **Deletes** remove the link only. They never delete a contact in the other system.
- **First link**: when two existing contacts are linked, blank values never overwrite filled ones, and differing values follow the conflict rule.
- **Disconnect** revokes the HubSpot refresh token, deletes the stored secret, and clears the links. Uninstalling the app deletes all of the site's data.
- **Mapping validation**: a HubSpot property (or Wix field) can be written by only one row. Extra rows for the same property are allowed only in the read direction. Read-only HubSpot properties can only be mapped HubSpot → Wix.
