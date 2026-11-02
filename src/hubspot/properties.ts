/**
 * Custom HubSpot contact properties created on connect (group "Wix Integration").
 * They hold the external ID mapping, sync origin tags and form/UTM attribution.
 */
import type { HubSpotClient } from './client.js';

export const PROPERTY_GROUP = { name: 'wix_integration', label: 'Wix Integration' };

const text = (name: string, label: string, description: string) => ({
  name,
  label,
  description,
  type: 'string',
  fieldType: 'text',
  groupName: PROPERTY_GROUP.name,
});

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

export const INTEGRATION_PROPERTIES = [
  // External ID mapping + origin tagging (loop prevention / observability)
  text('wix_contact_id', 'Wix contact ID', 'ID of the linked Wix contact.'),
  text('wix_sync_source', 'Last sync source', 'System that produced the last write made by the Wix integration.'),
  text('wix_sync_id', 'Last sync ID', 'Correlation ID of the last write made by the Wix integration.'),
  // First-touch attribution: set once, never overwritten
  ...UTM_KEYS.map((k) => text(`wix_original_utm_${k}`, `Original UTM ${k} (Wix)`, `First-touch utm_${k} captured on the Wix site.`)),
  text('wix_original_landing_page', 'Original landing page (Wix)', 'First page the visitor landed on.'),
  text('wix_original_referrer', 'Original referrer (Wix)', 'External referrer of the first visit.'),
  // Latest-touch attribution: updated on every form submission
  ...UTM_KEYS.map((k) => text(`wix_latest_utm_${k}`, `Latest UTM ${k} (Wix)`, `utm_${k} of the most recent attributed visit.`)),
  text('wix_last_form_id', 'Last Wix form ID', 'ID of the last Wix form submitted.'),
  text('wix_last_form_name', 'Last Wix form name', 'Name of the last Wix form submitted.'),
  text('wix_last_form_page_url', 'Last form page URL', 'Page URL where the last form was submitted.'),
  text('wix_last_form_referrer', 'Last form referrer', 'Referrer at the time of the last form submission.'),
  {
    name: 'wix_last_form_submitted_at',
    label: 'Last Wix form submitted at',
    description: 'Timestamp of the last Wix form submission.',
    type: 'datetime',
    fieldType: 'date',
    groupName: PROPERTY_GROUP.name,
  },
  {
    name: 'wix_last_form_fields',
    label: 'Last Wix form fields',
    description: 'Other fields of the last Wix form submission that are not mapped to a property.',
    type: 'string',
    fieldType: 'textarea',
    groupName: PROPERTY_GROUP.name,
  },
];

/** Internal properties that should not be offered in the mapping UI. */
export const INTERNAL_PROPERTIES = new Set(['wix_contact_id', 'wix_sync_source', 'wix_sync_id']);

/** Idempotently creates the property group and any missing properties. */
export async function ensureIntegrationProperties(client: HubSpotClient): Promise<void> {
  const existing = new Set((await client.listProperties()).map((p) => p.name));
  await client.createPropertyGroup(PROPERTY_GROUP.name, PROPERTY_GROUP.label);
  for (const def of INTEGRATION_PROPERTIES) {
    if (!existing.has(def.name)) await client.createProperty(def);
  }
}
