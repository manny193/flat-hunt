// Render web/icon.svg to the PNG sizes PWAs and iOS need (uses the preinstalled Playwright Chromium).
//   npm run icons
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// require() so a globally installed Playwright (NODE_PATH) resolves too; ESM import ignores NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright');

const web = fileURLToPath(new URL('../web/', import.meta.url));
const svg = readFileSync(web + 'icon.svg', 'utf8');
const browser = await chromium.launch();
try {
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: web + name, omitBackground: true });
    await page.close();
    console.log('wrote web/' + name);
  }
} finally { await browser.close(); }
