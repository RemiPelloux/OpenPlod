// Isolated UI regression suite: serves built assets only, mocks hardware/API in the
// test browser, blocks external traffic. Never opens a vault or talks to a recorder.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { chromium } from 'playwright-core';
const root = resolve('web/dist');
const screenshots = process.env.OPENPLOD_SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true, mode: 0o700 });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = resolve(root, '.' + new URL(request.url).pathname);
  if (!path.startsWith(root + '/') && path !== root) return new Response('', { status: 403 });
  const file = Bun.file(path);
  return new Response(await file.exists() && extname(path) ? file : Bun.file(join(root, 'index.html')));
}});
const origin = `http://127.0.0.1:${server.port}`;
const axe = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 1180, 390, 320]) for (const theme of ['dark', 'light']) for (const motion of ['reduce', 'no-preference']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: motion, locale: 'fr-FR' });
    await context.addInitScript(({ theme }) => { localStorage.setItem('openplod.locale', 'fr'); localStorage.setItem('theme', theme); }, { theme });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [], unexpected = [];
    let phase = 'downloading', percent = 42, resumedBytes = 0, cancelled = false, unauthorized = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.slice(4);
      let data;
      if (path === '/plaud/status') data = { deviceDetected: true, connectionVerified: true, directTransferAvailable: true, deviceName: 'Plaud test fixture', deviceSerial: '0000000000000001', deviceIdentifier: 'AA:BB:CC:DD:EE:FF' };
      else if (path === '/plaud/device-recordings') data = [{ sessionId: 1, size: 100 * 1048576, scene: 0, timezone: 0, recordingId: null, retentionState: null }];
      else if (path === '/plaud/device-import') data = { id: 'synthetic-job' };
      else if (path === '/plaud/device-import/synthetic-job') data = { state: 'running', progress: { stage: phase, percent, receivedBytes: 42 * 1048576, totalBytes: 100 * 1048576, resumedBytes } };
      else if (path === '/plaud/device-cancel') { cancelled = true; data = {}; }
      else if (path === '/plaud/identity') {
        if (route.request().method() === 'POST') return route.fulfill({ status: 400, json: { success: false, error: 'Your Plaud session has expired. Sign in again.' } });
        data = { authorized: !unauthorized, serial: '0000000000000001', identifier: 'AA:BB:CC:DD:EE:FF', deviceType: 'notepro' };
      }
      else if (path === '/plaud/identity/cancel') data = {};
      else if (path === '/plaud/environment') data = { ready: true, platform: 'darwin', arch: 'arm64', backend: 'corebluetooth', checks: [] };
      else if (path === '/plaud/auto-import') data = { enabled: false, events: [] };
      else if (path === '/plaud/authorizations') data = [];
      else if (path === '/plaud/cloud') data = { linked: false, account: null, recordings: [], totals: { count: 0, bytes: 0, trashCount: 0, importedCount: 0 } };
      else if (path === '/recordings/stats/summary') data = { byStatus: {}, totalDurationSeconds: 0 };
      else if (path === '/onboarding') data = { completedAt: '2026-01-01', skipped: true };
      else if (path === '/v1/collections') data = [];
      else if (path === '/settings') data = { autoTranscribe: false, autoSummarize: false, transcriptionEngine: 'whisper' };
      else if (['/recordings', '/jobs', '/collections', '/notifications'].includes(path)) data = [];
      else { unexpected.push(path); return route.fulfill({ status: 500, json: { error: `Unhandled isolated fixture: ${path}` } }); }
      return route.fulfill({ json: { success: true, data } });
    });
    await page.goto(`${origin}/devices`);
    await page.getByRole('button', { name: 'Connecter le Note Pro', exact: true }).click();
    await page.getByRole('button', { name: 'Importer l’enregistrement 1', exact: true }).click();
    await page.getByRole('button', { name: 'Importer 1 enregistrement', exact: true }).click();
    const progress = page.locator('.plaud-live-progress');
    await page.getByRole('progressbar', { name: 'Téléchargement depuis le Plaud' }).waitFor();
    assert.equal(await progress.locator('.plaud-progress-ring > strong').textContent(), '42%');
    await progress.scrollIntoViewIfNeeded();
    const geometry = await progress.evaluate(el => {
      const svg = el.querySelector('svg').getBoundingClientRect();
      const text = el.querySelector('.plaud-progress-ring > strong').getBoundingClientRect();
      return { copyWidth: el.querySelector('.plaud-progress-copy').getBoundingClientRect().width, svg: svg.width, centered: Math.abs(svg.x + svg.width / 2 - text.x - text.width / 2) < 1 && Math.abs(svg.y + svg.height / 2 - text.y - text.height / 2) < 1, overflow: el.scrollWidth > el.clientWidth + 2 || document.documentElement.scrollWidth > innerWidth + 2 };
    });
    assert(geometry.svg >= 70 && geometry.centered, JSON.stringify({ width, theme, geometry }));
    assert(geometry.copyWidth >= 130, `Progress copy too narrow: ${JSON.stringify({ width, geometry })}`);
    assert(!geometry.overflow, `Overflow at ${width} ${theme}`);
    phase = 'converting'; percent = 67; resumedBytes = 100 * 1048576;
    await page.getByRole('progressbar', { name: 'Conversion audio pour la lecture' }).waitFor();
    assert.equal(await progress.locator('.plaud-progress-ring > strong').textContent(), '67%');
    await page.getByText('Téléchargement déjà terminé. Réutilisation du fichier local.', { exact: true }).waitFor();
    if (screenshots && motion === 'reduce') await page.screenshot({ path: join(screenshots, `plaud-${width}-${theme}.png`), fullPage: true });
    await page.addScriptTag({ content: axe });
    const violations = await page.evaluate(async () => (await window.axe.run('.plaud-workspace', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })));
    assert.equal(violations.filter(v => ['serious', 'critical'].includes(v.impact)).length, 0, JSON.stringify(violations));
    phase = 'verifying'; percent = null;
    const ring = page.getByRole('progressbar', { name: 'Vérification de l’audio et de l’original conservé' });
    await ring.waitFor();
    assert.equal(await ring.getAttribute('aria-valuenow'), null);
    assert.equal(await ring.getAttribute('aria-valuetext'), 'En cours');
    if (motion === 'reduce') assert.equal(await progress.locator('.plaud-ring-value').evaluate(el => getComputedStyle(el).animationName), 'none');
    const cancel = page.locator('.plaud-import-progress').getByRole('button', { name: 'Annuler', exact: true });
    await cancel.focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert(await cancel.evaluate(el => el === document.activeElement));
    assert(await cancel.evaluate(el => { const s = getComputedStyle(el); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; }), 'Keyboard focus must be visible');
    await page.keyboard.press('Enter');
    await progress.waitFor({ state: 'detached' }); assert(cancelled);
    unauthorized = true; await page.reload();
    await page.getByLabel('Jeton de connexion Plaud', { exact: true }).last().fill('synthetic-session');
    await page.getByRole('button', { name: 'Autoriser cet ordinateur', exact: true }).click();
    await page.getByText('Votre session Plaud a expiré. Reconnectez-vous.', { exact: true }).waitFor();
    if (width >= 1180 && motion === 'reduce') {
      unauthorized = false; cancelled = false; phase = 'converting'; percent = 67;
      await page.goto(origin);
      await page.getByRole('button', { name: 'Récupérer depuis le Plaud', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await dialog.getByRole('checkbox', { name: 'Sélectionner l’enregistrement 1', exact: true }).check();
      await dialog.getByRole('button', { name: 'Importer 1', exact: true }).click();
      await dialog.getByRole('progressbar', { name: 'Conversion audio pour la lecture' }).waitFor();
      assert.equal(await dialog.locator('.plaud-progress-ring > strong').textContent(), '67%');
      await page.keyboard.press('Escape'); assert(await dialog.isVisible());
      await page.addScriptTag({ content: axe });
      const dialogViolations = await page.evaluate(async () => (await window.axe.run('.plaud-import-dialog')).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      assert.deepEqual(dialogViolations, []);
      if (screenshots) await page.screenshot({ path: join(screenshots, `dialog-${width}-${theme}.png`) });
      await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
      await dialog.locator('.plaud-live-progress').waitFor({ state: 'detached' }); assert(cancelled);
      console.log(`PASS dialog ${width}px ${theme}: progress, accessibility, busy Escape guard, cancellation`);
    }
    assert.deepEqual(errors, []); assert.deepEqual([...new Set(unexpected)], []);
    results.push({ width, theme, motion, passed: true });
    console.log(`PASS ${width}px ${theme} ${motion}: progress, resume, accessibility, keyboard, cancellation, localized authorization error`);
    await context.close();
  }
} finally { await browser.close(); server.stop(true); }
console.log(`Isolated Plaud UI: ${results.length} scenarios passed. No vault, recorder or external service accessed.`);
