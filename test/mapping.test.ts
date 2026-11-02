import { describe, expect, it } from 'vitest';
import { applyTransform, DEFAULT_MAPPINGS, validateMappings, type MappingRow } from '../src/sync/mapping.js';
import { buildWixInfoPatch } from '../src/sync/wixFields.js';

const row = (p: Partial<MappingRow>): MappingRow => ({
  id: Math.random().toString(36),
  wixField: 'firstName',
  hubspotProperty: 'firstname',
  direction: 'bidirectional',
  transform: 'none',
  ...p,
});

describe('validateMappings', () => {
  it('accepts the default mapping', () => {
    expect(validateMappings(DEFAULT_MAPPINGS)).toEqual([]);
  });

  it('rejects a HubSpot property written by two rows', () => {
    const errors = validateMappings([row({}), row({ wixField: 'lastName' })]);
    expect(errors.join()).toMatch(/"firstname" is written by 2 rows/);
  });

  it('allows a duplicate HubSpot property when the extra rows only read from HubSpot', () => {
    expect(validateMappings([row({}), row({ wixField: 'company', direction: 'hubspot_to_wix' })])).toEqual([]);
  });

  it('rejects the exact same pair twice', () => {
    expect(validateMappings([row({}), row({})]).join()).toMatch(/already mapped/);
  });

  it('rejects writes to read-only HubSpot properties and unknown fields', () => {
    const errors = validateMappings([row({ hubspotProperty: 'hs_object_id' }), row({ wixField: 'nope', hubspotProperty: 'x' })], {
      wixFields: new Set(['firstName']),
      hubspotProperties: new Map([['hs_object_id', { readOnly: true }]]),
    });
    expect(errors.join()).toMatch(/read-only/);
    expect(errors.join()).toMatch(/unknown Wix field "nope"/);
    expect(errors.join()).toMatch(/unknown HubSpot property "x"/);
  });
});

describe('applyTransform', () => {
  it('handles each transform', () => {
    expect(applyTransform('  Ada  ', 'trim')).toBe('Ada');
    expect(applyTransform(' ADA@Example.COM ', 'lowercase')).toBe('ada@example.com');
    expect(applyTransform('ada', 'uppercase')).toBe('ADA');
    expect(applyTransform("mary-jane o'neil", 'capitalize')).toBe("Mary-Jane O'Neil");
    expect(applyTransform(' x ', 'none')).toBe(' x ');
  });
});

describe('buildWixInfoPatch', () => {
  it('only includes touched sections and preserves sibling values', () => {
    const current = {
      name: { first: 'Ada', last: 'Lovelace' },
      emails: { items: [{ email: 'a@x.com', primary: true }, { email: 'b@x.com' }] },
      company: 'Old',
    };
    const patch = buildWixInfoPatch(current, [
      { field: 'firstName', value: 'Augusta' },
      { field: 'email', value: 'new@x.com' },
    ]);
    expect(patch).toEqual({
      name: { first: 'Augusta', last: 'Lovelace' },
      emails: { items: [{ email: 'new@x.com', primary: true }, { email: 'b@x.com' }] },
    });
    expect(current.name.first).toBe('Ada'); // not mutated
  });

  it('writes extended fields by key', () => {
    expect(buildWixInfoPatch({}, [{ field: 'extended:custom.plan', value: 'Pro' }])).toEqual({
      extendedFields: { items: { 'custom.plan': 'Pro' } },
    });
  });
});
