// Playwright smoke test: starts its own server on a temp DB (password login on), then on a phone and a
// desktop viewport: log in, add an area, import the sample posts, shortlist one (swipe on phone,
// keyboard on desktop), see it on Shortlist (also after reload), pass one, see it on Passed,
// open Settings, and fail on any console error. Exits non-zero on failure.
//   npm run e2e            (HEADED=1 to watch)
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../src/node-server.js';

// require() so a globally installed Playwright (NODE_PATH) resolves as well as node_modules.
const { chromium } = createRequire(import.meta.url)('playwright');
const PASSWORD = 'e2e-password-0123456789';
const ARTIFACTS = 'test-results/e2e';

const VIEWPORTS = [
  { name: 'phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { name: 'desktop', options: { viewport: { width: 1366, height: 900 } } },
];

function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }

async function runViewport(browser, vp) {
  const dir = mkdtempSync(join(tmpdir(), 'flat-hunt-e2e-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'e2e.db'), quiet: true, env: { APP_PASSWORD: PASSWORD, SESSION_SECRET: 'e2e-session-secret-0123456789abcdef', AUTH_DISABLED: '', APIFY_TOKEN: '', CRON_ENABLED: '' } });
  const context = await browser.newContext({ ...vp.options, baseURL: srv.url, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  // No network in CI sandboxes: answer Google Fonts locally so the page behaves as if fonts loaded.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: r.request().url().includes('googleapis') ? 'text/css' : 'font/woff2', body: '' }));
  const step = async (name, fn) => {
    try { await fn(); console.log(`  ok  ${vp.name}: ${name}`); }
    catch (e) { mkdirSync(ARTIFACTS, { recursive: true }); await page.screenshot({ path: `${ARTIFACTS}/${vp.name}-failure.png`, fullPage: true }).catch(() => {}); throw new Error(`${vp.name}: ${name}: ${e.message}`); }
  };
  try {
    await step('unauthenticated visit lands on /login', async () => {
      await page.goto('/');
      await page.waitForURL(/\/login/);
    });
    await step('wrong password shows an error, right password opens the app', async () => {
      await page.fill('#pw', 'wrong-password');
      await page.click('button[type=submit]');
      await page.waitForSelector('.login-err');
      await page.fill('#pw', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForURL(u => !u.pathname.startsWith('/login'));
      await page.waitForSelector('#first-area');
    });
    await step('add an area (keywords generated)', async () => {
      await page.fill('#first-area', 'Green Glen Layout');
      await page.press('#first-area', 'Enter');
      await page.waitForSelector('#btn-samples');
      const brand = await page.locator('.brand-area').first().textContent();
      assert(/Green Glen Layout/.test(brand), 'brand shows the area, got ' + brand);
    });
    await step('import the sample posts', async () => {
      await page.click('#btn-samples');
      await page.waitForSelector('#deck .scard.top');
      const sub = await page.locator('.shead .sub').textContent();
      assert(sub.trim() === '4 new', 'expected 4 new (5 listings, 1 "looking for" hidden), got ' + sub);
    });
    const topLabel = async () => (await page.locator('#deck .scard.top').getAttribute('aria-label')) || '';
    let kept = '';
    await step(vp.name === 'phone' ? 'swipe right to shortlist' : 'press → to shortlist', async () => {
      kept = await topLabel();
      const patch = page.waitForResponse(r => r.url().includes('/api/listings/') && r.request().method() === 'PATCH' && r.ok());
      if (vp.name === 'phone') {
        const box = await page.locator('#deck .scard.top').boundingBox();
        const y = box.y + box.height * 0.4;
        await page.mouse.move(box.x + box.width * 0.3, y);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * 0.3 + i * 28, y + i);
        await page.mouse.up();
      } else {
        await page.locator('body').click({ position: { x: 5, y: 890 } }).catch(() => {});
        await page.keyboard.press('ArrowRight');
      }
      await patch;
      await page.waitForFunction(() => document.querySelector('.shead .sub')?.textContent.trim() === '3 new');
    });
    await step('shortlisted listing is on Shortlist, also after reload', async () => {
      await page.goto('/#shortlist');
      await page.waitForSelector('.lrow');
      await page.reload();
      await page.waitForSelector('.lrow');
      assert(await page.locator('.lrow').count() === 1, 'one shortlisted row');
      const rent = kept.split(' a month')[0];
      const rowText = await page.locator('.lrow').first().textContent();
      assert(rowText.includes(rent.replace(/^₹/, '')) || rowText.includes(rent), `row shows ${rent}: ${rowText.slice(0, 80)}`);
      assert(await page.locator('.lrow .stage-pill').inputValue() === 'To call', 'stage To call');
    });
    await step(vp.name === 'phone' ? 'tap Pass on the next card' : 'press ← to pass', async () => {
      await page.goto('/#review');
      await page.waitForSelector('#deck .scard.top');
      const patch = page.waitForResponse(r => r.url().includes('/api/listings/') && r.request().method() === 'PATCH' && r.ok());
      if (vp.name === 'phone') await page.click('.rb.passb');
      else await page.keyboard.press('ArrowLeft');
      await patch;
      await page.waitForFunction(() => document.querySelector('.shead .sub')?.textContent.trim() === '2 new');
    });
    await step('passed listing is on Passed', async () => {
      await page.goto('/#passed');
      await page.waitForSelector('.lrow.muted');
      assert(await page.locator('.lrow.muted').count() === 1, 'one passed row');
    });
    await step(vp.name === 'desktop' ? 'restore from Passed' : 'tap a card to open its details', async () => {
      await page.goto('/#review');
      await page.waitForSelector('#deck .scard.top');
      if (vp.name === 'desktop') {
        await page.goto('/#passed'); await page.waitForSelector('.lrow.muted');
        await page.click('.lrow.muted [data-set="new"]');
        await page.waitForSelector('.empty');
      } else {
        await page.locator('#deck .scard.top .ptext').click();
        await page.waitForSelector('.sheet .statusbar');
        await page.keyboard.press('Escape');
      }
    });
    await step('settings show the area editor', async () => {
      await page.goto('/#review');
      await page.click(vp.name === 'phone' ? '.topbar [data-go="settings"]' : '.rail [data-go="settings"]');
      await page.waitForSelector('.area-card');
      const kw = await page.locator('.area-card textarea').inputValue();
      assert(kw.includes('green glen') && kw.includes('greenglen'), 'generated keywords shown: ' + kw);
    });
    await step('no console errors', async () => { assert(errors.length === 0, errors.join('\n')); });
  } finally {
    await context.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const browser = await chromium.launch({ headless: !process.env.HEADED });
let failed = false;
try {
  for (const vp of VIEWPORTS) {
    try { await runViewport(browser, vp); }
    catch (e) { failed = true; console.error('FAIL', e.message); }
  }
} finally { await browser.close(); }
console.log(failed ? 'e2e: FAILED' : 'e2e: all passed');
process.exit(failed ? 1 : 0);
