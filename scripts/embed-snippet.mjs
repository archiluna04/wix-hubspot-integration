// Prints the inline Embedded Script snippet for the Wix Dev Center, with APP_BASE_URL from .env.
// Usage: npm run -s embed:snippet
// Use this instead of the <script src> form when browsers can't load scripts from your host
// (free ngrok tunnels answer browser requests with an HTML warning page).
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';

config({ quiet: true });
const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Set APP_BASE_URL in .env to your public https:// URL first.');
  process.exit(1);
}

const code = readFileSync('public/embed/attribution.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
  .replace(/^\s*\/\/.*$/gm, '') // line comments
  .replace(/\n\s*\n+/g, '\n')
  .trim();

process.stdout.write(
  `<script data-site-key="{{siteKey}}" data-endpoint="${base}/public/attribution">\n${code}\n</script>\n`,
);
