import { z } from 'zod';

export const DIRECTIONS = ['wix_to_hubspot', 'hubspot_to_wix', 'bidirectional'] as const;
export const TRANSFORMS = ['none', 'trim', 'lowercase', 'uppercase', 'capitalize'] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type Transform = (typeof TRANSFORMS)[number];

export interface MappingRow {
  id: string;
  /** Wix field key, e.g. "firstName", "address.city" or "extended:custom.favorite-color". */
  wixField: string;
  /** HubSpot contact property internal name, e.g. "firstname". */
  hubspotProperty: string;
  direction: Direction;
  transform: Transform;
  /** Written to the target when the source value is empty. */
  defaultValue?: string;
}

export const mappingRowSchema = z.object({
  id: z.string().min(1).max(64),
  wixField: z.string().min(1).max(200),
  hubspotProperty: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_]+$/, 'invalid HubSpot property name'),
  direction: z.enum(DIRECTIONS),
  transform: z.enum(TRANSFORMS).default('none'),
  defaultValue: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const mappingListSchema = z.array(mappingRowSchema).max(100);

export const DEFAULT_MAPPINGS: MappingRow[] = [
  { id: 'default-email', wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'trim' },
  { id: 'default-first', wixField: 'firstName', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'trim' },
  { id: 'default-last', wixField: 'lastName', hubspotProperty: 'lastname', direction: 'bidirectional', transform: 'trim' },
  { id: 'default-phone', wixField: 'phone', hubspotProperty: 'phone', direction: 'bidirectional', transform: 'trim' },
  { id: 'default-company', wixField: 'company', hubspotProperty: 'company', direction: 'bidirectional', transform: 'none' },
  { id: 'default-job', wixField: 'jobTitle', hubspotProperty: 'jobtitle', direction: 'bidirectional', transform: 'none' },
];

/** Stable identity for a row's synced value, independent of the row's UI id. */
export const rowKey = (r: Pick<MappingRow, 'wixField' | 'hubspotProperty'>) => `${r.wixField}|${r.hubspotProperty}`;
export const writesToHubSpot = (r: MappingRow) => r.direction !== 'hubspot_to_wix';
export const writesToWix = (r: MappingRow) => r.direction !== 'wix_to_hubspot';

export function applyTransform(value: string, transform: Transform): string {
  switch (transform) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.trim().toLowerCase();
    case 'uppercase':
      return value.trim().toUpperCase();
    case 'capitalize':
      return value
        .trim()
        .toLowerCase()
        .replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
    default:
      return value;
  }
}

export interface MappingCatalog {
  wixFields?: Set<string>;
  hubspotProperties?: Map<string, { readOnly: boolean }>;
}

/**
 * Validates a mapping table. Rules:
 * - each Wix field → HubSpot property pair appears once;
 * - a HubSpot property can be *written* by only one row (duplicates are allowed only
 *   for rows that read from HubSpot, i.e. direction "HubSpot → Wix");
 * - likewise a Wix field can be written by only one row;
 * - read-only HubSpot properties cannot be written to.
 */
export function validateMappings(rows: MappingRow[], catalog: MappingCatalog = {}): string[] {
  const errors: string[] = [];
  const pairs = new Set<string>();
  const hubspotWriters = new Map<string, number>();
  const wixWriters = new Map<string, number>();

  rows.forEach((r, i) => {
    const label = `Row ${i + 1}`;
    const key = rowKey(r);
    if (pairs.has(key)) errors.push(`${label}: "${r.wixField}" → "${r.hubspotProperty}" is already mapped.`);
    pairs.add(key);

    if (catalog.wixFields && !catalog.wixFields.has(r.wixField)) {
      errors.push(`${label}: unknown Wix field "${r.wixField}".`);
    }
    if (catalog.hubspotProperties) {
      const prop = catalog.hubspotProperties.get(r.hubspotProperty);
      if (!prop) errors.push(`${label}: unknown HubSpot property "${r.hubspotProperty}".`);
      else if (prop.readOnly && writesToHubSpot(r)) {
        errors.push(`${label}: HubSpot property "${r.hubspotProperty}" is read-only. Use direction "HubSpot → Wix".`);
      }
    }
    if (writesToHubSpot(r)) hubspotWriters.set(r.hubspotProperty, (hubspotWriters.get(r.hubspotProperty) ?? 0) + 1);
    if (writesToWix(r)) wixWriters.set(r.wixField, (wixWriters.get(r.wixField) ?? 0) + 1);
  });

  for (const [prop, count] of hubspotWriters) {
    if (count > 1) {
      errors.push(
        `HubSpot property "${prop}" is written by ${count} rows. Map it once, or set the extra rows to "HubSpot → Wix".`,
      );
    }
  }
  for (const [field, count] of wixWriters) {
    if (count > 1) {
      errors.push(`Wix field "${field}" is written by ${count} rows. Map it once, or set the extra rows to "Wix → HubSpot".`);
    }
  }
  return errors;
}
