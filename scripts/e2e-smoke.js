// Playwright smoke test: starts its own server on a temp DB (password login on, sample posts stored),
// then on a phone and a desktop viewport: browse publicly (no phone digits in the DOM, details locked),
// log in as admin with APP_PASSWORD, add an area, shortlist one (swipe on phone, keyboard on desktop),
// see it on Shortlist (also after reload), pass one, restore it, render admin pages, and fail on any
// console error. Exits non-zero on failure.
//   npm run e2e            (HEADED=1 to watch)
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../src/node-server.js';
import { ingestItems } from '../src/ingest.js';
import { generateKeywords } from '../src/core/keywords.js';
import { readFileSync } from 'node:fs';

// require() so a globally installed Playwright (NODE_PATH) resolves as well as node_modules.
const { chromium } = createRequire(import.meta.url)('playwright');
const PASSWORD = 'e2e-password-0123456789';
const ARTIFACTS = 'test-results/e2e';
const SAMPLES = JSON.parse(readFileSync(new URL('../web/samples.json', import.meta.url), 'utf8'));
// Listing ids are random hex ('l_' + 16 chars); about 1 in 150 holds 10 digits in a row that look like a mobile number.
const noIds = html => html.replace(/\bl_[0-9a-f]{16}\b/g, 'l_id');
const MOBILE = /(?<!\d)(?:91|0)?[6-9]\d{9}(?!\d)|(?<!\d)[6-9]\d{4}[\s-]\d{5}(?!\d)/;

const VIEWPORTS = [
  { name: 'phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { name: 'desktop', options: { viewport: { width: 1366, height: 900 } } },
];

function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
// Touch targets of at least 44x44 px and no sideways scrolling on the phone viewport (QA).
async function phoneLayout(page, selectors) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert(sw <= iw, `no horizontal scroll (${sw} > ${iw})`);
  // Measure in one pass inside the page: the UI may re-render between Playwright calls,
  // which detaches handles (boundingBox() then returns null).
  await page.waitForTimeout(300);
  const boxes = await page.evaluate(sels => sels.flatMap(sel => [...document.querySelectorAll(sel)].map(el => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { sel, w: r.width, h: r.height, shown: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' };
  })), selectors);
  for (const b of boxes) if (b.shown) assert(b.w >= 44 && b.h >= 44, `${b.sel} is ${Math.round(b.w)}x${Math.round(b.h)}, want 44x44`);
}

async function runViewport(browser, vp) {
  const dir = mkdtempSync(join(tmpdir(), 'flat-hunt-e2e-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'e2e.db'), quiet: true, env: { APP_PASSWORD: PASSWORD, SESSION_SECRET: 'e2e-session-secret-0123456789abcdef', AUTH_DISABLED: '', APIFY_TOKEN: '', CRON_ENABLED: '', GOOGLE_CLIENT_ID: '', ADMIN_EMAILS: 'admin@example.com' } });
  // Seed shared data as a scrape would: one area, the sample posts (with phone numbers) stored for everyone.
  await srv.repo.createArea({ name: 'Green Glen', keywords: generateKeywords('Green Glen Layout'), active: true }, Date.now());
  await ingestItems(srv.repo, SAMPLES, { source: 'apify', storeAll: true });
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
  const sub = () => page.locator('.screen-h .sub').first().textContent().then(t => t.trim());
  try {
    await step('public browse: listings without any phone digits, map or WhatsApp links in the DOM', async () => {
      await page.goto('/');
      await page.waitForSelector('#grid .lcard');
      assert(await page.locator('#grid .lcard').count() >= 4, 'cards shown');
      assert(await page.locator('#grid .masked').count() >= 1, 'phone shown as the "number hidden" pill');
      assert(await page.locator('#grid .cta-card').count() === 1, 'sign-in card in the grid');
      const html = noIds(await page.content());
      assert(!MOBILE.test(html) && !MOBILE.test(html.replace(/[\s.\-()+]/g, '')), 'no mobile number anywhere in the page');
      assert(!/wa\.me|maps\.app\.goo\.gl|tel:/.test(html), 'no contact links');
    });
    if (vp.name === 'phone') await step('public: tap targets and width', () => phoneLayout(page, ['.tabbar a', '.topbar .btn', '.fchip']));
    await step('public: details are locked; Review asks to sign in', async () => {
      await page.locator('#grid .lcard').first().click();
      await page.waitForSelector('.sheet .lock');
      assert(!MOBILE.test(noIds(await page.content())), 'detail sheet has no phone digits');
      await page.keyboard.press('Escape');
      await page.goto('/#review');
      await page.waitForSelector('.sheet .signin-title');
      await page.keyboard.press('Escape');
    });
    await step('admin login with APP_PASSWORD (break-glass): wrong password errors, right one opens the app', async () => {
      await page.goto('/login');
      await page.fill('#pw', 'wrong-password');
      await page.click('button[type=submit]');
      await page.waitForSelector('.login-err');
      await page.fill('#pw', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForURL(u => !u.pathname.startsWith('/login'));
      await page.goto('/#account');
      await page.waitForSelector('#logout');
      assert(await page.locator('a[href="#admin-scraper"]').count() >= 1, 'admin links shown');
    });
    await step('my areas: create a new area', async () => {
      await page.goto('/#areas');
      await page.waitForSelector('.achip');
      await page.fill('#area-q', 'HSR Layout');
      await page.click('#area-list [data-create]');
      await page.waitForFunction(() => [...document.querySelectorAll('.achip')].some(c => c.textContent.includes('HSR Layout')));
    });
    await step('signed-in browse shows the real numbers', async () => {
      await page.goto('/#browse');
      await page.waitForSelector('#grid .lcard .strip:not(.locked)');
      assert(MOBILE.test(await page.locator('#grid').innerText()), 'numbers visible to members');
    });
    await step('review deck has the new listings', async () => {
      await page.goto('/#review');
      await page.waitForSelector('#deck .scard.top');
      const s = await sub();
      assert(s === '4 new', 'expected 4 new (5 listings, 1 "looking for" hidden), got ' + s);
    });
    if (vp.name === 'phone') await step('review: tap targets, width, buttons above the tab bar', async () => {
      await phoneLayout(page, ['.deck-btns .rb', '.tabbar a', '#deck .scard.top .info-btn']);
      const [btnBottom, tabTop] = await page.evaluate(() => [document.querySelector('.deck-btns').getBoundingClientRect().bottom, document.querySelector('.tabbar').getBoundingClientRect().top]);
      assert(btnBottom <= tabTop, `deck buttons (${Math.round(btnBottom)}) above the tab bar (${Math.round(tabTop)})`);
    });
    const topLabel = async () => (await page.locator('#deck .scard.top').getAttribute('aria-label')) || '';
    let kept = '';
    await step(vp.name === 'phone' ? 'swipe right to shortlist' : 'press → to shortlist', async () => {
      kept = await topLabel();
      const patch = page.waitForResponse(r => r.url().includes('/api/listings/') && r.request().method() === 'PATCH' && r.ok());
      if (vp.name === 'phone') {
        const box = await page.locator('#deck .scard.top').boundingBox();
        const y = box.y + box.height * 0.3;
        await page.mouse.move(box.x + box.width * 0.2, y);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * 0.2 + i * 25, y + i);
        await page.mouse.up();
      } else {
        await page.keyboard.press('ArrowRight');
      }
      await patch;
      await page.waitForFunction(() => document.querySelector('.screen-h .sub')?.textContent.trim() === '3 new');
    });
    await step('shortlisted listing is on Shortlist, also after reload', async () => {
      await page.goto('/#shortlist');
      await page.waitForSelector('.srow');
      await page.reload();
      await page.waitForSelector('.srow');
      assert(await page.locator('.srow').count() === 1, 'one shortlisted row');
      assert(await page.locator('.srow .stage-pill').inputValue() === 'To call', 'stage To call');
      const rent = kept.split(' a month')[0].replace(/[₹,]/g, '');
      const mini = (await page.locator('.srow .mini b').textContent()).replace('k', '');
      assert(rent.startsWith(mini.replace('.', '')) || Number(rent) === Number(mini) * 1000, `row shows the rent ${rent}: ${mini}`);
      if (vp.name === 'phone') await phoneLayout(page, ['.srow .stage-pill', '.srow .btn']);
    });
    await step(vp.name === 'phone' ? 'tap Pass on the next card' : 'press ← to pass', async () => {
      await page.goto('/#review');
      await page.waitForSelector('#deck .scard.top');
      const patch = page.waitForResponse(r => r.url().includes('/api/listings/') && r.request().method() === 'PATCH' && r.ok());
      if (vp.name === 'phone') await page.click('.rb.passb');
      else await page.keyboard.press('ArrowLeft');
      await patch;
      await page.waitForFunction(() => document.querySelector('.screen-h .sub')?.textContent.trim() === '2 new');
    });
    await step(vp.name === 'desktop' ? 'restore from Passed' : 'open a card\'s details from the deck', async () => {
      if (vp.name === 'desktop') {
        await page.goto('/#passed'); await page.waitForSelector('.srow');
        assert(await page.locator('.srow').count() === 1, 'one passed row');
        await page.click('.srow [data-restore]');
        await page.waitForSelector('.empty');
      } else {
        await page.goto('/#review'); await page.waitForSelector('#deck .scard.top');
        await page.click('#deck .scard.top .info-btn');
        await page.waitForSelector('.sheet .contact');
        await page.keyboard.press('Escape');
      }
    });
    await step('admin pages render (scraper charts, users)', async () => {
      await page.goto('/#admin-scraper');
      await page.waitForSelector('.kpis .kpi');
      await page.waitForSelector('#ch1 svg.chart');
      await page.goto('/#admin-users');
      await page.waitForSelector('tr[data-id]');
      if (vp.name === 'phone') { const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); assert(sw <= iw, `no horizontal scroll on admin (${sw} > ${iw})`); }
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
