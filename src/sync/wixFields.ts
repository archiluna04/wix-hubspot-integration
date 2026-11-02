/**
 * Catalog of Wix contact fields that can be mapped, with typed getters/setters
 * over the Wix Contacts v4 `info` object.
 */
export interface WixEmail {
  email?: string;
  tag?: string;
  primary?: boolean;
}
export interface WixPhone {
  phone?: string;
  countryCode?: string;
  tag?: string;
  primary?: boolean;
}
export interface WixAddress {
  addressLine?: string;
  addressLine2?: string;
  city?: string;
  subdivision?: string;
  country?: string;
  postalCode?: string;
}
export interface WixContactInfo {
  name?: { first?: string; last?: string };
  emails?: { items?: WixEmail[] };
  phones?: { items?: WixPhone[] };
  addresses?: { items?: Array<{ tag?: string; address?: WixAddress }> };
  company?: string;
  jobTitle?: string;
  birthdate?: string;
  extendedFields?: { items?: Record<string, unknown> };
}

type Section = keyof WixContactInfo;

export interface WixFieldDef {
  key: string;
  label: string;
  section: Section;
  get(info: WixContactInfo): string | undefined;
  set(info: WixContactInfo, value: string): void;
}

const primaryItem = <T extends { primary?: boolean }>(items?: T[]): T | undefined =>
  items?.find((i) => i.primary) ?? items?.[0];

function addressField(key: keyof WixAddress, label: string): WixFieldDef {
  return {
    key: `address.${key}`,
    label: `Address: ${label}`,
    section: 'addresses',
    get: (info) => info.addresses?.items?.[0]?.address?.[key],
    set: (info, value) => {
      const items = ((info.addresses ??= {}).items ??= []);
      if (!items[0]) items.push({ tag: 'HOME', address: {} });
      (items[0].address ??= {})[key] = value;
    },
  };
}

export const STANDARD_WIX_FIELDS: WixFieldDef[] = [
  {
    key: 'firstName',
    label: 'First name',
    section: 'name',
    get: (i) => i.name?.first,
    set: (i, v) => {
      (i.name ??= {}).first = v;
    },
  },
  {
    key: 'lastName',
    label: 'Last name',
    section: 'name',
    get: (i) => i.name?.last,
    set: (i, v) => {
      (i.name ??= {}).last = v;
    },
  },
  {
    key: 'email',
    label: 'Email (primary)',
    section: 'emails',
    get: (i) => primaryItem(i.emails?.items)?.email,
    set: (i, v) => {
      if (!v) return; // never strip a contact's email
      const items = ((i.emails ??= {}).items ??= []);
      const primary = primaryItem(items);
      if (primary) primary.email = v;
      else items.unshift({ email: v, tag: 'MAIN', primary: true });
    },
  },
  {
    key: 'phone',
    label: 'Phone (primary)',
    section: 'phones',
    get: (i) => primaryItem(i.phones?.items)?.phone,
    set: (i, v) => {
      const items = ((i.phones ??= {}).items ??= []);
      const primary = primaryItem(items);
      if (primary) primary.phone = v;
      else if (v) items.unshift({ phone: v, tag: 'MOBILE', primary: true });
    },
  },
  {
    key: 'company',
    label: 'Company',
    section: 'company',
    get: (i) => i.company,
    set: (i, v) => {
      i.company = v;
    },
  },
  {
    key: 'jobTitle',
    label: 'Job title',
    section: 'jobTitle',
    get: (i) => i.jobTitle,
    set: (i, v) => {
      i.jobTitle = v;
    },
  },
  {
    key: 'birthdate',
    label: 'Birthdate (YYYY-MM-DD)',
    section: 'birthdate',
    get: (i) => i.birthdate,
    set: (i, v) => {
      i.birthdate = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
    },
  },
  addressField('addressLine', 'street'),
  addressField('city', 'city'),
  addressField('subdivision', 'state / region'),
  addressField('postalCode', 'postal code'),
  addressField('country', 'country (ISO code)'),
];

export const EXTENDED_PREFIX = 'extended:';

export function extendedField(extKey: string, label: string): WixFieldDef {
  return {
    key: `${EXTENDED_PREFIX}${extKey}`,
    label,
    section: 'extendedFields',
    get: (i) => {
      const v = i.extendedFields?.items?.[extKey];
      return v == null ? undefined : String(v);
    },
    set: (i, v) => {
      ((i.extendedFields ??= {}).items ??= {})[extKey] = v;
    },
  };
}

export function getWixField(key: string): WixFieldDef | undefined {
  const std = STANDARD_WIX_FIELDS.find((f) => f.key === key);
  if (std) return std;
  if (key.startsWith(EXTENDED_PREFIX)) {
    const extKey = key.slice(EXTENDED_PREFIX.length);
    return extendedField(extKey, extKey);
  }
  return undefined;
}

export function primaryEmail(info: WixContactInfo): string | undefined {
  return primaryItem(info.emails?.items)?.email?.trim() || undefined;
}

/**
 * Builds the `info` body for a Wix Update Contact call. Only sections touched by
 * `changes` are included (copied from `current` and modified), so unrelated data
 * is never re-sent or overwritten.
 */
export function buildWixInfoPatch(
  current: WixContactInfo,
  changes: Array<{ field: string; value: string }>,
): WixContactInfo {
  const patch: WixContactInfo = {};
  for (const { field, value } of changes) {
    const def = getWixField(field);
    if (!def) continue;
    if (def.section === 'extendedFields') {
      (patch.extendedFields ??= {}).items ??= {};
    } else if (!(def.section in patch) && current[def.section] !== undefined) {
      (patch as Record<string, unknown>)[def.section] = structuredClone(current[def.section]);
    }
    def.set(patch, value);
  }
  return patch;
}
