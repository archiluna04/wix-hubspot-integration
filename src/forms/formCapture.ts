/**
 * Feature #2: Wix Forms submission -> HubSpot contact/lead with attribution.
 *
 * Attribution sources (later wins):
 *  1. Touch reported by the embedded site script (first + latest UTM, landing page, referrer),
 *     matched by a salted hash of the submitted email.
 *  2. Hidden form fields named utm_source / utm_medium / utm_campaign / utm_term / utm_content,
 *     page_url, referrer.
 *
 * HubSpot structure (see docs/API_PLAN.md):
 *  - wix_original_utm_* / wix_original_landing_page / wix_original_referrer: first touch, set only if empty
 *  - wix_latest_utm_*: overwritten on every submission
 *  - wix_last_form_* : form id/name, page URL, referrer, timestamp, unmapped fields
 *  - lifecyclestage = "lead" when the contact has no stage yet (optional setting)
 */
import { createHash } from 'node:crypto';
import { errorInfo, log } from '../lib/logger.js';
import type { HubSpotProperty } from '../hubspot/client.js';
import type { Store } from '../store.js';
import { ContactExistsError, type HubSpotContact, type HubSpotContactsPort } from '../sync/engine.js';

export interface WixSubmission {
  id: string;
  formId?: string;
  submissions?: Record<string, unknown>;
  createdDate?: string;
  submitter?: { contactId?: string };
  contactId?: string;
}

export interface FormCaptureDeps {
  store: Store;
  hubspot(instanceId: string): HubSpotContactsPort & { listProperties(): Promise<HubSpotProperty[]> };
  wix(instanceId: string): { getFormName(formId: string): Promise<string | null> };
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;
type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function emailHash(siteKey: string, email: string): string {
  return createHash('sha256').update(`${siteKey}:${email.trim().toLowerCase()}`).digest('hex');
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringify).filter(Boolean).join(', ');
  return JSON.stringify(value).slice(0, 500);
}

export interface ExtractedFields {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  utm: Utm;
  pageUrl?: string;
  referrer?: string;
  custom: Array<[string, string]>;
}

/** Maps Wix form field keys (e.g. "first_name_ab12", "email_3f9c") to contact fields. */
export function extractSubmissionFields(values: Record<string, unknown>): ExtractedFields {
  const out: ExtractedFields = { utm: {}, custom: [] };
  for (const [key, raw] of Object.entries(values)) {
    const value = stringify(raw);
    if (!value) continue;
    const k = key.toLowerCase();
    const utm = k.match(/^utm_(source|medium|campaign|term|content)$/);
    if (utm) out.utm[utm[1] as keyof Utm] = value.slice(0, 200);
    else if (/^(page_?url|landing_?page)$/.test(k)) out.pageUrl = value;
    else if (/^referr?er$/.test(k)) out.referrer = value;
    else if (!out.email && /e-?mail/.test(k) && EMAIL_RE.test(value)) out.email = value;
    else if (!out.firstName && /^first[_\s-]?name/.test(k)) out.firstName = value;
    else if (!out.lastName && /^last[_\s-]?name/.test(k)) out.lastName = value;
    else if (!out.phone && /(phone|mobile|^tel)/.test(k)) out.phone = value;
    else out.custom.push([key, value]);
  }
  if (!out.email) {
    const idx = out.custom.findIndex(([, v]) => EMAIL_RE.test(v));
    if (idx >= 0) out.email = out.custom.splice(idx, 1)[0][1];
  }
  return out;
}

/** Field key -> HubSpot property name: exact match, or with Wix's auto id suffix ("company_1a2b") removed. */
function matchProperty(key: string, writable: Set<string>): string | undefined {
  const k = key.toLowerCase();
  if (writable.has(k)) return k;
  const m = k.match(/^(.+)_([0-9a-f]{4,})$/);
  if (m && /\d/.test(m[2]) && writable.has(m[1])) return m[1];
  return undefined;
}

export class FormCapture {
  private propertyCache = new Map<string, { names: Set<string>; until: number }>();

  constructor(private readonly deps: FormCaptureDeps) {}

  private async writableProperties(instanceId: string): Promise<Set<string>> {
    const cached = this.propertyCache.get(instanceId);
    if (cached && cached.until > Date.now()) return cached.names;
    const props = await this.deps.hubspot(instanceId).listProperties();
    const names = new Set(
      props
        .filter((p) => !p.hidden && !p.calculated && !p.modificationMetadata?.readOnlyValue && !p.name.startsWith('wix_'))
        .map((p) => p.name),
    );
    this.propertyCache.set(instanceId, { names, until: Date.now() + 10 * 60_000 });
    return names;
  }

  async handle(instanceId: string, submission: WixSubmission): Promise<void> {
    const { store } = this.deps;
    const started = Date.now();
    const base = {
      submissionId: submission.id,
      formId: submission.formId ?? null,
      formName: null as string | null,
      hubspotContactId: null as string | null,
      utmSource: null as string | null,
      utmMedium: null as string | null,
      utmCampaign: null as string | null,
      latencyMs: null as number | null,
      submittedAt: submission.createdDate ?? null,
      reason: null as string | null,
    };

    if (store.getFormEventStatus(instanceId, submission.id) === 'synced') return; // idempotent on redelivery
    const inst = store.getInstallation(instanceId);
    if (!inst?.hubspotPortalId) {
      store.upsertFormEvent(instanceId, { ...base, status: 'skipped', reason: 'hubspot_not_connected' });
      return;
    }
    if (!inst.settings.formCaptureEnabled) {
      store.upsertFormEvent(instanceId, { ...base, status: 'skipped', reason: 'form_capture_disabled' });
      return;
    }

    const fields = extractSubmissionFields(submission.submissions ?? {});
    if (!fields.email) {
      store.upsertFormEvent(instanceId, { ...base, status: 'skipped', reason: 'no_email' });
      return;
    }

    const submittedAtMs = Date.parse(submission.createdDate ?? '') || Date.now();
    const touch = store.findAttributionTouch(
      instanceId,
      emailHash(inst.siteKey, fields.email),
      submittedAtMs - ATTRIBUTION_WINDOW_MS,
    );
    const latest: Utm = {};
    const original: Utm = {};
    for (const k of UTM_KEYS) {
      const l = fields.utm[k] || touch?.last?.[`utm_${k}`];
      const o = touch?.first?.[`utm_${k}`] || l;
      if (l) latest[k] = l;
      if (o) original[k] = o;
    }
    const pageUrl = fields.pageUrl || touch?.pageUrl || '';
    const referrer = fields.referrer || touch?.referrer || touch?.last?.referrer || '';

    const hubspot = this.deps.hubspot(instanceId);
    const formName = submission.formId ? await this.deps.wix(instanceId).getFormName(submission.formId) : null;

    const props: Record<string, string> = { email: fields.email };
    if (fields.firstName) props.firstname = fields.firstName;
    if (fields.lastName) props.lastname = fields.lastName;
    if (fields.phone) props.phone = fields.phone;

    const unmapped: string[] = [];
    let writable = new Set<string>();
    try {
      writable = await this.writableProperties(instanceId);
    } catch (err) {
      log.warn('could not load hubspot properties', { instanceId, error: errorInfo(err) });
    }
    for (const [key, value] of fields.custom) {
      const prop = matchProperty(key, writable);
      if (prop && !(prop in props)) props[prop] = value;
      else unmapped.push(`${key}: ${value}`);
    }

    const existingProps = [
      'lifecyclestage',
      ...UTM_KEYS.map((k) => `wix_original_utm_${k}`),
      'wix_original_landing_page',
      'wix_original_referrer',
    ];
    const existing: HubSpotContact | null = await hubspot.findContactByEmail(fields.email, existingProps);
    const isEmpty = (p: string) => !existing?.properties[p];

    if (inst.hubspotPropertiesReady) {
      for (const k of UTM_KEYS) {
        if (latest[k]) props[`wix_latest_utm_${k}`] = latest[k]!;
        if (original[k] && isEmpty(`wix_original_utm_${k}`)) props[`wix_original_utm_${k}`] = original[k]!;
      }
      if (touch?.first?.landing_page && isEmpty('wix_original_landing_page')) {
        props.wix_original_landing_page = touch.first.landing_page;
      }
      if (touch?.first?.referrer && isEmpty('wix_original_referrer')) props.wix_original_referrer = touch.first.referrer;
      if (submission.formId) props.wix_last_form_id = submission.formId;
      if (formName) props.wix_last_form_name = formName;
      if (pageUrl) props.wix_last_form_page_url = pageUrl;
      if (referrer) props.wix_last_form_referrer = referrer;
      props.wix_last_form_submitted_at = String(submittedAtMs);
      if (unmapped.length) props.wix_last_form_fields = unmapped.join('\n').slice(0, 10_000);
      const wixContactId = submission.submitter?.contactId ?? submission.contactId;
      if (wixContactId) props.wix_contact_id = wixContactId;
    }
    if (inst.settings.setLifecycleStageLead && isEmpty('lifecyclestage')) props.lifecyclestage = 'lead';

    let written: HubSpotContact;
    try {
      written = existing ? await hubspot.updateContact(existing.id, props) : await hubspot.createContact(props);
    } catch (err) {
      if (!(err instanceof ContactExistsError)) throw err;
      written = await hubspot.updateContact(err.existingId, props);
    }

    store.upsertFormEvent(instanceId, {
      ...base,
      formName,
      status: 'synced',
      hubspotContactId: written.id,
      utmSource: latest.source ?? null,
      utmMedium: latest.medium ?? null,
      utmCampaign: latest.campaign ?? null,
      latencyMs: Date.now() - started,
    });
    log.info('form submission synced', {
      instanceId,
      submissionId: submission.id,
      hubspotContactId: written.id,
      created: !existing,
      attributed: !!(touch || Object.keys(fields.utm).length),
    });
  }
}
