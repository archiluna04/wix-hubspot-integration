// Writes APP_BASE_URL (from .env or the environment) into the HubSpot project config.
// Usage: npm run hubspot:configure   (re-run whenever your public URL changes)
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';

config({ quiet: true });
const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Set APP_BASE_URL in .env to your public https:// URL first.');
  process.exit(1);
}

const files = ['hubspot-project/src/app/app-hsmeta.json', 'hubspot-project/src/app/webhooks/webhooks-hsmeta.json'];
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(/https:\/\/[^"/]+(?=\/(oauth\/hubspot\/callback|webhooks\/hubspot|dashboard)")/g, base);
  writeFileSync(file, after);
  console.log(`${file}: ${before === after ? 'unchanged' : 'updated'}`);
}
console.log(`HubSpot project now points at ${base}. Next: cd hubspot-project && hs project upload`);
