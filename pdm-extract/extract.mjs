// Pixel Dudes Maker extractor — run locally where itch.io is reachable.
// Usage: node extract.mjs ./out
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const OUT = process.argv[2] || './out';
const PAGE = 'https://0x72.itch.io/pixeldudesmaker';
const saved = new Map();

function localPathFor(u) {
  const url = new URL(u);
  let p = url.pathname;
  if (p.endsWith('/') || p === '') p += 'index.html';
  return join(OUT, url.host, decodeURIComponent(p.replace(/^\//, '')));
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();

async function record(resp) {
  try {
    const u = resp.url();
    if (!/^https?:/.test(u) || saved.has(u)) return;
    let body;
    try { body = await resp.body(); } catch { return; }
    const ct = resp.headers()['content-type'] || '';
    saved.set(u, { status: resp.status(), ct, bytes: body.length });
    const path = localPathFor(u);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  } catch {}
}
ctx.on('response', record);

const page = await ctx.newPage();
console.log('Loading', PAGE);
await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });

for (const sel of ['.load_iframe_btn', '.iframe_placeholder button', 'button.button', 'a.button']) {
  const el = await page.$(sel);
  if (el) { try { await el.click({ timeout: 5000 }); console.log('clicked', sel); break; } catch {} }
}
await page.waitForTimeout(4000);

let iframeUrl = null;
for (const f of page.frames()) {
  if (/itch\.zone|hwcdn|html-classic|index\.html/.test(f.url())) { iframeUrl = f.url(); break; }
}
if (!iframeUrl) {
  iframeUrl = await page.getAttribute('.iframe_placeholder', 'data-iframe')
    .then(a => a && JSON.parse(a.replace(/&quot;/g, '"')).src).catch(() => null);
}
console.log('game bundle url:', iframeUrl);

if (iframeUrl) {
  const gp = await ctx.newPage();
  gp.on('response', record);
  await gp.goto(iframeUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log(e.message));
  await gp.waitForTimeout(6000);
}

console.log('\nCaptured', saved.size, 'files:');
for (const [u, m] of saved) console.log(m.status, String(m.bytes).padStart(8), (m.ct.split(';')[0] || '').padEnd(26), u);
writeFileSync(join(OUT, '_manifest.json'), JSON.stringify(Object.fromEntries(saved), null, 2));
await browser.close();

