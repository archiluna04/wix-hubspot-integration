import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { emailHash, extractSubmissionFields, FormCapture } from '../src/forms/formCapture.js';
import { Store } from '../src/store.js';
import { FakeHubSpot } from './fakes.js';

describe('extractSubmissionFields', () => {
  it('maps Wix form keys, hidden UTM fields and custom fields', () => {
    const f = extractSubmissionFields({
      first_name_a1b2: 'Ada',
      last_name_c3d4: 'Lovelace',
      email_5e6f: 'ada@example.com',
      phone_77aa: '+1 555 0100',
      utm_source: 'google',
      utm_campaign: 'spring',
      company_9f1e: 'Engines Ltd',
      interests: ['math', 'poetry'],
    });
    expect(f).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+1 555 0100',
      utm: { source: 'google', campaign: 'spring' },
    });
    expect(f.custom).toEqual([
      ['company_9f1e', 'Engines Ltd'],
      ['interests', 'math, poetry'],
    ]);
  });
});

describe('FormCapture', () => {
  function setup() {
    const store = new Store(openDatabase(':memory:'));
    const inst = store.ensureInstallation('site-1');
    store.setHubSpotConnection('site-1', { portalId: '1', scopes: [] });
    store.setHubSpotPropertiesReady('site-1', true);
    const hs = new FakeHubSpot();
    const hubspot = Object.assign(hs, {
      listProperties: async () =>
        ['email', 'firstname', 'company'].map((name) => ({ name, label: name, type: 'string', fieldType: 'text', groupName: 'x' })),
    });
    const capture = new FormCapture({ store, hubspot: () => hubspot, wix: () => ({ getFormName: async () => 'Contact us' }) });
    return { store, hs, capture, siteKey: inst.siteKey };
  }

  it('creates a lead with first-touch and latest-touch attribution', async () => {
    const { store, hs, capture, siteKey } = setup();
    store.addAttributionTouch('site-1', {
      emailHash: emailHash(siteKey, 'Ada@Example.com'),
      first: { utm_source: 'newsletter', utm_medium: 'email', landing_page: 'https://site.com/', referrer: '' },
      last: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring' },
      pageUrl: 'https://site.com/contact',
      referrer: 'https://google.com/',
    });

    await capture.handle('site-1', {
      id: 'sub-1',
      formId: 'form-1',
      createdDate: new Date().toISOString(),
      submissions: { email_1a2b: 'ada@example.com', first_name_1a2b: 'Ada', company_9f1e: 'Engines', message: 'Hi' },
    });

    const [c] = [...hs.contacts.values()];
    expect(c.properties).toMatchObject({
      email: 'ada@example.com',
      firstname: 'Ada',
      company: 'Engines',
      lifecyclestage: 'lead',
      wix_original_utm_source: 'newsletter',
      wix_latest_utm_source: 'google',
      wix_latest_utm_campaign: 'spring',
      wix_last_form_name: 'Contact us',
      wix_last_form_page_url: 'https://site.com/contact',
      wix_last_form_fields: 'message: Hi',
    });
    const [event] = store.listFormEvents('site-1');
    expect(event).toMatchObject({ status: 'synced', utmSource: 'google', hubspotContactId: c.id });
  });

  it('keeps original attribution on later submissions and is idempotent per submission', async () => {
    const { hs, capture } = setup();
    hs.insert({ email: 'ada@example.com', wix_original_utm_source: 'first', lifecyclestage: 'customer' });
    const submission = {
      id: 'sub-2',
      submissions: { email: 'ada@example.com', utm_source: 'second' },
    };
    await capture.handle('site-1', submission);
    await capture.handle('site-1', submission);
    const [c] = [...hs.contacts.values()];
    expect(c.properties.wix_original_utm_source).toBe('first');
    expect(c.properties.wix_latest_utm_source).toBe('second');
    expect(c.properties.lifecyclestage).toBe('customer');
    expect(hs.writes).toBe(1);
  });
});
