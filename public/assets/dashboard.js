// Dashboard page, loaded inside the Wix dashboard iframe.
// Auth: Wix adds a signed `instance` query param; we exchange it for a short-lived session
// token (kept in memory only). HubSpot tokens never reach the browser.

const $ = (id) => document.getElementById(id);

const DIRECTIONS = [
  ['bidirectional', 'Both ways ⇄'],
  ['wix_to_hubspot', 'Wix → HubSpot'],
  ['hubspot_to_wix', 'HubSpot → Wix'],
];
const TRANSFORMS = [
  ['none', 'None'],
  ['trim', 'Trim spaces'],
  ['lowercase', 'Lowercase'],
  ['uppercase', 'Uppercase'],
  ['capitalize', 'Capitalize'],
];

const state = {
  token: null,
  status: null,
  fields: { wix: [], hubspot: [] },
  rows: [],
  savedRows: [],
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function createSession() {
  const params = new URLSearchParams(location.search);
  const instance = params.get('instance');
  let res;
  if (instance) {
    res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance }),
    });
  } else if (params.has('dev')) {
    res = await fetch('/api/dev-session', { method: 'POST' });
  } else {
    throw new Error('Open this page from your Wix dashboard.');
  }
  if (!res.ok) throw new Error('Your session could not be verified. Reload the page from the Wix dashboard.');
  state.token = (await res.json()).token;
}

async function api(path, { method = 'GET', body, retried = false } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    await createSession();
    return api(path, { method, body, retried: true });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.details = data?.errors;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

// ---------------------------------------------------------------------------
// Connection + settings
// ---------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  const connected = s.hubspot.connected;
  const badge = $('conn-badge');
  badge.textContent = connected ? 'HubSpot connected' : 'Not connected';
  badge.className = `badge ${connected ? 'badge-ok' : 'badge-off'}`;

  $('conn-disconnected').hidden = connected;
  $('conn-connected').hidden = !connected;
  if (connected) {
    $('portal-id').textContent = s.hubspot.portalId;
    $('connected-at').textContent = fmtTime(s.hubspot.connectedAt);
    $('linked-count').textContent = String(s.linkedContacts);
    $('props-ready').textContent = s.hubspot.propertiesReady ? 'Created' : 'Missing';
    $('repair-btn').hidden = s.hubspot.propertiesReady;
  }
  $('scope-list').replaceChildren(...s.requestedScopes.map((scope) => el('li', {}, el('code', { text: scope }))));

  $('set-sync').checked = s.settings.syncEnabled;
  $('set-conflict').value = s.settings.conflictStrategy;
  $('set-forms').checked = s.settings.formCaptureEnabled;
  $('set-lead').checked = s.settings.setLifecycleStageLead;
  $('full-sync-btn').disabled = !connected;
}

async function loadStatus() {
  state.status = await api('/status');
  renderStatus();
}

async function connectHubSpot() {
  const { url } = await api('/hubspot/connect', { method: 'POST' });
  const popup = window.open(url, 'hubspot-oauth', 'width=620,height=760');
  if (!popup) {
    toast('Your browser blocked the HubSpot window. Allow pop-ups and try again.', true);
    return;
  }
  // The callback page posts a message when done; poll as a fallback.
  const started = Date.now();
  const timer = setInterval(async () => {
    if (popup.closed || Date.now() - started > 5 * 60_000) {
      clearInterval(timer);
      await refreshAfterConnect();
    }
  }, 1000);
}

async function refreshAfterConnect() {
  await loadStatus();
  if (state.status.hubspot.connected) await loadFields();
}

window.addEventListener('message', async (event) => {
  if (event.origin !== location.origin || event.data?.type !== 'hubspot-oauth') return;
  if (event.data.status === 'success') toast('HubSpot connected.');
  else toast(event.data.message || 'HubSpot connection failed.', true);
  await refreshAfterConnect();
});

async function disconnectHubSpot() {
  if (!confirm('Disconnect HubSpot? Syncing stops and contact links are cleared. Existing data in both systems is kept.')) return;
  await api('/hubspot/disconnect', { method: 'POST' });
  toast('HubSpot disconnected.');
  await loadStatus();
  await loadFields();
}

async function saveSettings() {
  const { settings } = await api('/settings', {
    method: 'PUT',
    body: {
      syncEnabled: $('set-sync').checked,
      conflictStrategy: $('set-conflict').value,
      formCaptureEnabled: $('set-forms').checked,
      setLifecycleStageLead: $('set-lead').checked,
    },
  });
  state.status.settings = settings;
  toast('Settings saved.');
}

// ---------------------------------------------------------------------------
// Field mapping table
// ---------------------------------------------------------------------------

async function loadFields() {
  state.fields = await api('/fields');
  const warnings = [state.fields.wixError, state.fields.hubspotError].filter(Boolean);
  if (!state.status.hubspot.connected) warnings.push('Connect HubSpot to choose from your HubSpot properties.');
  $('fields-warning').textContent = warnings.join(' ');
  $('fields-warning').hidden = warnings.length === 0;
  renderRows();
}

async function loadMappings() {
  const { rows } = await api('/mappings');
  state.rows = structuredClone(rows);
  state.savedRows = structuredClone(rows);
}

function groupedSelect(options, value, onChange, { valueKey, labelOf, extraLabel }) {
  const select = el('select', { onchange: (e) => onChange(e.target.value) });
  const groups = new Map();
  for (const o of options) {
    if (!groups.has(o.group)) groups.set(o.group, []);
    groups.get(o.group).push(o);
  }
  // Keep a saved value selectable even if the catalog can't currently be loaded.
  if (value && !options.some((o) => o[valueKey] === value)) {
    select.append(el('option', { value, text: `${value} (saved)` }));
  }
  if (!value) select.append(el('option', { value: '', text: 'Select…' }));
  for (const [group, items] of groups) {
    const og = el('optgroup', { label: group || 'Other' });
    for (const o of items) {
      og.append(el('option', { value: o[valueKey], text: labelOf(o) + (extraLabel ? extraLabel(o) : '') }));
    }
    select.append(og);
  }
  select.value = value || '';
  return select;
}

function simpleSelect(options, value, onChange) {
  const select = el('select', { onchange: (e) => onChange(e.target.value) });
  for (const [v, label] of options) select.append(el('option', { value: v, text: label }));
  select.value = value;
  return select;
}

/** Client-side mirror of the server rules, for instant feedback. */
function validateRows(rows) {
  const errors = [];
  const invalid = new Set();
  const pairs = new Map();
  const hsWriters = new Map();
  const wixWriters = new Map();
  const readOnly = new Set(state.fields.hubspot.filter((p) => p.readOnly).map((p) => p.name));

  rows.forEach((r, i) => {
    if (!r.wixField || !r.hubspotProperty) {
      errors.push(`Row ${i + 1}: choose both a Wix field and a HubSpot property.`);
      invalid.add(i);
      return;
    }
    const pair = `${r.wixField}|${r.hubspotProperty}`;
    if (pairs.has(pair)) {
      errors.push(`Row ${i + 1}: duplicates row ${pairs.get(pair) + 1}.`);
      invalid.add(i);
    } else pairs.set(pair, i);
    if (r.direction !== 'hubspot_to_wix') {
      if (readOnly.has(r.hubspotProperty)) {
        errors.push(`Row ${i + 1}: "${r.hubspotProperty}" is read-only in HubSpot. Use "HubSpot → Wix".`);
        invalid.add(i);
      }
      hsWriters.set(r.hubspotProperty, [...(hsWriters.get(r.hubspotProperty) || []), i]);
    }
    if (r.direction !== 'wix_to_hubspot') wixWriters.set(r.wixField, [...(wixWriters.get(r.wixField) || []), i]);
  });
  for (const [prop, idx] of hsWriters) {
    if (idx.length > 1) {
      errors.push(`HubSpot property "${prop}" is mapped more than once. Keep one row, or set the others to "HubSpot → Wix".`);
      idx.forEach((i) => invalid.add(i));
    }
  }
  for (const [field, idx] of wixWriters) {
    if (idx.length > 1) {
      errors.push(`Wix field "${field}" is written by more than one row. Keep one, or set the others to "Wix → HubSpot".`);
      idx.forEach((i) => invalid.add(i));
    }
  }
  return { errors, invalid };
}

function showErrors(errors) {
  const list = $('mapping-errors');
  list.replaceChildren(...errors.map((e) => el('li', { text: e })));
  list.hidden = errors.length === 0;
}

function renderRows() {
  const { errors, invalid } = validateRows(state.rows);
  const body = $('mapping-rows');
  body.replaceChildren(
    ...state.rows.map((row, i) => {
      const update = (key) => (value) => {
        row[key] = value;
        renderRows();
      };
      return el('tr', { class: invalid.has(i) ? 'invalid' : '' }, [
        el(
          'td',
          {},
          groupedSelect(state.fields.wix, row.wixField, update('wixField'), {
            valueKey: 'key',
            labelOf: (o) => o.label,
          }),
        ),
        el(
          'td',
          {},
          groupedSelect(state.fields.hubspot, row.hubspotProperty, update('hubspotProperty'), {
            valueKey: 'name',
            labelOf: (o) => `${o.label} (${o.name})`,
            extraLabel: (o) => (o.readOnly ? ' (read-only)' : ''),
          }),
        ),
        el('td', {}, simpleSelect(DIRECTIONS, row.direction, update('direction'))),
        el('td', {}, simpleSelect(TRANSFORMS, row.transform || 'none', update('transform'))),
        el(
          'td',
          {},
          el('input', {
            type: 'text',
            value: row.defaultValue || '',
            placeholder: 'Optional',
            'aria-label': 'Default value',
            oninput: (e) => {
              row.defaultValue = e.target.value;
            },
          }),
        ),
        el(
          'td',
          {},
          el('button', {
            class: 'btn-icon',
            type: 'button',
            title: 'Remove row',
            'aria-label': 'Remove row',
            text: '✕',
            onclick: () => {
              state.rows.splice(i, 1);
              renderRows();
            },
          }),
        ),
      ]);
    }),
  );
  if (!state.rows.length) {
    body.append(el('tr', {}, el('td', { colspan: '6', class: 'empty', text: 'No fields mapped. Add a row to start.' })));
  }
  showErrors(errors);
  $('save-mapping-btn').disabled = errors.length > 0;
}

async function saveMapping() {
  const rows = state.rows.map((r) => ({
    id: r.id,
    wixField: r.wixField,
    hubspotProperty: r.hubspotProperty,
    direction: r.direction,
    transform: r.transform || 'none',
    ...(r.defaultValue ? { defaultValue: r.defaultValue } : {}),
  }));
  try {
    const res = await api('/mappings', { method: 'PUT', body: { rows } });
    state.rows = structuredClone(res.rows);
    state.savedRows = structuredClone(res.rows);
    renderRows();
    toast('Mapping saved. New syncs use these rules.');
  } catch (err) {
    if (err.details) showErrors(err.details);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const pill = (status) => el('span', { class: `pill pill-${status}`, text: status });

async function loadActivity() {
  const data = await api('/activity');
  $('queue-info').textContent =
    `${data.linkedContacts} linked contacts · ${data.queue.pending} pending jobs` +
    (data.queue.failed ? ` · ${data.queue.failed} failed` : '');

  const syncRows = data.syncEvents.map((e) =>
    el('tr', {}, [
      el('td', { text: fmtTime(e.createdAt) }),
      el('td', { text: e.source === 'wix' ? 'Wix' : 'HubSpot' }),
      el('td', {}, [pill(e.action), e.reason ? el('span', { class: 'reason', text: e.reason.replace(/_/g, ' ') }) : null]),
      el('td', { class: 'wrap', text: e.fields.join(', ') }),
      el('td', { text: e.wixContactId || '' }),
      el('td', { text: e.hubspotContactId || '' }),
    ]),
  );
  $('sync-log').replaceChildren(
    ...(syncRows.length ? syncRows : [el('tr', {}, el('td', { colspan: '6', class: 'empty', text: 'No sync activity yet.' }))]),
  );

  const formRows = data.formEvents.map((e) =>
    el('tr', {}, [
      el('td', { text: fmtTime(e.createdAt) }),
      el('td', { text: e.formName || e.formId || '' }),
      el('td', {}, [pill(e.status), e.reason ? el('span', { class: 'reason', text: e.reason.replace(/_/g, ' ') }) : null]),
      el('td', { class: 'wrap', text: [e.utmSource, e.utmMedium, e.utmCampaign].map((v) => v || '-').join(' / ') }),
      el('td', { text: e.hubspotContactId || '' }),
      el('td', { text: e.latencyMs != null ? `${e.latencyMs} ms` : '' }),
    ]),
  );
  $('form-log').replaceChildren(
    ...(formRows.length ? formRows : [el('tr', {}, el('td', { colspan: '6', class: 'empty', text: 'No form submissions yet.' }))]),
  );
}

function selectTab(which) {
  for (const name of ['sync', 'forms']) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === which));
    $(`panel-${name}`).hidden = name !== which;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function wireEvents() {
  $('connect-btn').addEventListener('click', (e) => withBusy(e.currentTarget, connectHubSpot));
  $('disconnect-btn').addEventListener('click', (e) => withBusy(e.currentTarget, disconnectHubSpot));
  $('repair-btn').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      await api('/hubspot/repair-properties', { method: 'POST' });
      toast('HubSpot properties created.');
      await loadStatus();
    }),
  );
  $('save-settings-btn').addEventListener('click', (e) => withBusy(e.currentTarget, saveSettings));
  $('add-row-btn').addEventListener('click', () => {
    state.rows.push({
      id: crypto.randomUUID(),
      wixField: '',
      hubspotProperty: '',
      direction: 'bidirectional',
      transform: 'none',
    });
    renderRows();
  });
  $('reset-rows-btn').addEventListener('click', () => {
    state.rows = structuredClone(state.savedRows);
    renderRows();
  });
  $('save-mapping-btn').addEventListener('click', (e) => withBusy(e.currentTarget, saveMapping));
  $('refresh-btn').addEventListener('click', (e) => withBusy(e.currentTarget, loadActivity));
  $('full-sync-btn').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      await api('/sync/full', { method: 'POST', body: { system: 'both' } });
      toast('Full sync started. Progress appears under Activity.');
      setTimeout(loadActivity, 3000);
    }),
  );
  $('tab-sync').addEventListener('click', () => selectTab('sync'));
  $('tab-forms').addEventListener('click', () => selectTab('forms'));
}

async function boot() {
  try {
    await createSession();
    await Promise.all([loadStatus(), loadMappings()]);
    wireEvents();
    $('boot').hidden = true;
    $('app').hidden = false;
    await Promise.all([loadFields(), loadActivity()]);
    setInterval(() => loadActivity().catch(() => {}), 15_000);
  } catch (err) {
    $('boot').textContent = err.message;
    $('boot').classList.add('error');
    $('conn-badge').hidden = true;
  }
}

boot();
