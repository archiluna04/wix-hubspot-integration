import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { resolveConflict, SyncEngine, type SyncResult } from '../src/sync/engine.js';
import { DEFAULT_MAPPINGS, type MappingRow } from '../src/sync/mapping.js';
import { FakeHubSpot, FakeWix } from './fakes.js';

const INSTANCE = 'site-1';

function setup(opts: { dedupeWindowMs?: number; rows?: MappingRow[] } = {}) {
  const store = new Store(openDatabase(':memory:'));
  store.ensureInstallation(INSTANCE);
  store.setHubSpotConnection(INSTANCE, { portalId: '999', scopes: [] });
  if (opts.rows) store.saveMappings(INSTANCE, opts.rows);
  const wix = new FakeWix();
  const hs = new FakeHubSpot();
  const engine = new SyncEngine({ store, wix: () => wix, hubspot: () => hs, dedupeWindowMs: opts.dedupeWindowMs });
  const results: SyncResult[] = [];

  /** Delivers all pending webhooks (deduped per contact like the queue does) until quiet. */
  async function pump(maxRounds = 20) {
    for (let round = 0; round < maxRounds; round++) {
      if (!wix.events.length && !hs.events.length) return round;
      const wixIds = [...new Set(wix.events.splice(0))];
      const hsIds = [...new Set(hs.events.splice(0))];
      for (const id of wixIds) await run(await engine.syncFromWix(INSTANCE, id));
      for (const id of hsIds) await run(await engine.syncFromHubSpot(INSTANCE, id));
    }
    throw new Error('sync did not settle: ping-pong detected');
  }
  async function run(r: SyncResult) {
    results.push(r);
    if (r.followUp?.system === 'hubspot') hs.events.push(r.followUp.contactId);
    if (r.followUp?.system === 'wix') wix.events.push(r.followUp.contactId);
  }
  return { store, wix, hs, engine, pump, results };
}

const wixInfo = (first: string, email = 'ada@example.com') => ({
  name: { first, last: 'Lovelace' },
  emails: { items: [{ email, primary: true }] },
});

describe('bi-directional sync', () => {
  for (const dedupeWindowMs of [120_000, 0]) {
    describe(dedupeWindowMs ? 'with dedupe window' : 'without dedupe window (state-based only)', () => {
      it('creates a HubSpot contact from a new Wix contact without echoing back', async () => {
        const { wix, hs, pump } = setup({ dedupeWindowMs });
        wix.insert(wixInfo('Ada'));
        await pump();
        expect(hs.writes).toBe(1);
        expect(wix.writes).toBe(0);
        const [contact] = [...hs.contacts.values()];
        expect(contact.properties).toMatchObject({ email: 'ada@example.com', firstname: 'Ada', lastname: 'Lovelace' });
      });

      it('a single Wix update causes exactly one HubSpot write and no ping-pong', async () => {
        const { wix, hs, pump } = setup({ dedupeWindowMs });
        const c = wix.insert(wixInfo('Ada'));
        await pump();
        const before = { hs: hs.writes, wix: wix.writes };

        wix.userEdit(c.id, (info) => (info.name!.first = 'Augusta'));
        const rounds = await pump();

        expect(hs.writes - before.hs).toBe(1);
        expect(wix.writes - before.wix).toBe(0);
        expect(rounds).toBeLessThanOrEqual(2);
        expect([...hs.contacts.values()][0].properties.firstname).toBe('Augusta');
      });

      it('a single HubSpot update causes exactly one Wix write and no ping-pong', async () => {
        const { wix, hs, pump } = setup({ dedupeWindowMs });
        const c = wix.insert(wixInfo('Ada'));
        await pump();
        const hsId = [...hs.contacts.keys()][0];
        const before = { hs: hs.writes, wix: wix.writes };

        hs.userEdit(hsId, { lastname: 'King', company: 'Analytical Engines' });
        await pump();

        expect(wix.writes - before.wix).toBe(1);
        expect(hs.writes - before.hs).toBe(0);
        expect(wix.contacts.get(c.id)!.info).toMatchObject({ name: { last: 'King' }, company: 'Analytical Engines' });
      });

      it('creates a Wix contact from a new HubSpot contact', async () => {
        const { wix, hs, pump } = setup({ dedupeWindowMs });
        hs.insert({ email: 'grace@example.com', firstname: 'Grace', lastname: 'Hopper' });
        await pump();
        expect(wix.writes).toBe(1);
        expect(hs.writes).toBe(0);
        const [created] = [...wix.contacts.values()];
        expect(created.info.name).toEqual({ first: 'Grace', last: 'Hopper' });
      });
    });
  }

  it('links existing contacts by email instead of creating duplicates', async () => {
    const { wix, hs, pump, store } = setup();
    hs.insert({ email: 'ada@example.com', firstname: 'Ada', lastname: 'Lovelace' });
    hs.events.length = 0;
    const c = wix.insert(wixInfo('Ada'));
    await pump();
    expect(hs.contacts.size).toBe(1);
    expect(hs.writes).toBe(0); // identical values: idempotent, nothing written
    expect(store.getLinkByWix(INSTANCE, c.id)?.hubspotContactId).toBe([...hs.contacts.keys()][0]);
  });

  it('ignores Wix updates to unmapped fields', async () => {
    const { wix, hs, pump, results } = setup();
    const c = wix.insert(wixInfo('Ada'));
    await pump();
    const writes = hs.writes;
    wix.userEdit(c.id, (info) => (info.birthdate = '1815-12-10')); // birthdate is not mapped by default
    await pump();
    expect(hs.writes).toBe(writes);
    expect(results.at(-1)).toMatchObject({ action: 'skipped', reason: 'no_mapped_changes' });
  });

  it('applies transforms without causing extra round trips', async () => {
    const rows: MappingRow[] = [
      { id: 'e', wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'trim' },
      { id: 'f', wixField: 'firstName', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'uppercase' },
    ];
    const { wix, hs, pump } = setup({ rows });
    wix.insert(wixInfo('ada'));
    await pump();
    expect([...hs.contacts.values()][0].properties.firstname).toBe('ADA');
    expect(hs.writes).toBe(1);
    expect(wix.writes).toBe(0);
  });

  it('respects one-way mappings', async () => {
    const rows: MappingRow[] = [
      { id: 'e', wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'none' },
      { id: 'c', wixField: 'company', hubspotProperty: 'company', direction: 'hubspot_to_wix', transform: 'none' },
    ];
    const { wix, hs, pump } = setup({ rows });
    const c = wix.insert({ ...wixInfo('Ada'), company: 'Wix Co' });
    await pump();
    expect([...hs.contacts.values()][0].properties.company).toBeUndefined();
    hs.userEdit([...hs.contacts.keys()][0], { company: 'HubSpot Co' });
    await pump();
    expect(wix.contacts.get(c.id)!.info.company).toBe('HubSpot Co');
  });

  it('applies default values when the source is empty', async () => {
    const rows: MappingRow[] = [
      ...DEFAULT_MAPPINGS,
      { id: 'ls', wixField: 'address.country', hubspotProperty: 'country', direction: 'wix_to_hubspot', transform: 'none', defaultValue: 'US' },
    ];
    const { wix, hs, pump } = setup({ rows });
    wix.insert(wixInfo('Ada'));
    await pump();
    expect([...hs.contacts.values()][0].properties.country).toBe('US');
  });

  it('conflict: last updated wins, and both sides converge without looping', async () => {
    const { wix, hs, engine, pump } = setup();
    const c = wix.insert(wixInfo('Ada'));
    await pump();
    const hsId = [...hs.contacts.keys()][0];

    // Both sides edit the same field before either webhook is processed; HubSpot edits last.
    wix.userEdit(c.id, (info) => (info.name!.first = 'FromWix'));
    hs.userEdit(hsId, { firstname: 'FromHubSpot' });
    wix.events.length = 0;
    hs.events.length = 0;

    const fromWix = await engine.syncFromWix(INSTANCE, c.id);
    expect(fromWix.reason).toMatch(/conflict_hubspot_won/);
    const fromHs = await engine.syncFromHubSpot(INSTANCE, hsId);
    expect(fromHs.action).toBe('updated');
    await pump();

    expect(wix.contacts.get(c.id)!.info.name!.first).toBe('FromHubSpot');
    expect(hs.contacts.get(hsId)!.properties.firstname).toBe('FromHubSpot');
  });

  it('conflict: "Wix wins" strategy overrides timestamps', async () => {
    const { wix, hs, engine, pump, store } = setup();
    const inst = store.getInstallation(INSTANCE)!;
    store.updateSettings(INSTANCE, { ...inst.settings, conflictStrategy: 'wix_wins' });
    const c = wix.insert(wixInfo('Ada'));
    await pump();
    const hsId = [...hs.contacts.keys()][0];

    wix.userEdit(c.id, (info) => (info.name!.first = 'FromWix'));
    hs.userEdit(hsId, { firstname: 'FromHubSpot' });
    wix.events.length = 0;
    hs.events.length = 0;
    await engine.syncFromHubSpot(INSTANCE, hsId);
    await engine.syncFromWix(INSTANCE, c.id);
    await pump();

    expect(wix.contacts.get(c.id)!.info.name!.first).toBe('FromWix');
    expect(hs.contacts.get(hsId)!.properties.firstname).toBe('FromWix');
  });

  it('skips when HubSpot is not connected or sync is disabled', async () => {
    const { wix, hs, engine, store } = setup();
    const c = wix.insert(wixInfo('Ada'));
    store.updateSettings(INSTANCE, { ...store.getInstallation(INSTANCE)!.settings, syncEnabled: false });
    expect((await engine.syncFromWix(INSTANCE, c.id)).reason).toBe('sync_disabled');
    store.setHubSpotConnection(INSTANCE, null);
    expect((await engine.syncFromWix(INSTANCE, c.id)).reason).toBe('hubspot_not_connected');
    expect(hs.writes).toBe(0);
  });
});

describe('resolveConflict', () => {
  it('is deterministic', () => {
    expect(resolveConflict('last_updated_wins', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('wix');
    expect(resolveConflict('last_updated_wins', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toBe('hubspot');
    expect(resolveConflict('last_updated_wins', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('hubspot');
    expect(resolveConflict('hubspot_wins', '2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z')).toBe('hubspot');
    expect(resolveConflict('wix_wins', '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toBe('wix');
  });
});
