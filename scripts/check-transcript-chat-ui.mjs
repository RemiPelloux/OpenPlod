import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Read-only acceptance against an existing vault. Never synthesize recordings or AI replies.
const origin = process.env.OPENPLOD_TEST_ORIGIN || 'http://127.0.0.1:3492';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const token = process.env.OPENPLOD_TEST_TOKEN_FILE ? readFileSync(process.env.OPENPLOD_TEST_TOKEN_FILE, 'utf8').trim() : '';
const headers = token ? { 'X-OpenPlod-Token': token } : {};
const { chromium } = await import(process.env.OPENPLOD_PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
const screenshots = process.env.OPENPLOD_SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true, mode: 0o700 });
const { app: { security: { csp } } } = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const screenshot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) }); };
const api = async path => {
  const response = await page.request.get(`${origin}/api${path}`, { headers });
  assert(response.ok(), `API status ${response.status()}`);
  return response.json();
};
try {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && route.request().isNavigationRequest()) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
    }
    assert(!(url.origin === origin && route.request().method() !== 'GET'), 'This UI check must not mutate the vault or call AI');
    return route.continue({ headers: { ...route.request().headers(), ...(url.origin === origin && url.pathname.startsWith('/api/') ? headers : {}) } });
  });
  const library = await api('/transcripts');
  assert(library.data.length, 'Acceptance requires a real saved transcript');
  const first = library.data[0];
  const { data: recording } = await api(`/recordings/${first.recordingId}`);
  const title = recording.originalFilename?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Untitled';
  const transcriptText = recording.transcript?.fullText;
  assert(transcriptText, 'Recording must contain real transcript text');
  await page.goto(`${origin}/transcripts`);
  await page.locator('.transcript-markdown').waitFor();
  assert.equal(await page.locator('.transcript-document').count(), library.data.length);
  assert((await page.locator('.transcript-reader-heading h2').textContent()) === title, 'Reader title matches recording');
  await page.getByRole('radio', { name: 'Markdown', exact: true }).click();
  assert((await page.getByLabel('Transcript Markdown').textContent()) === transcriptText, 'Markdown matches stored transcript');
  await page.getByRole('radio', { name: 'Preview', exact: true }).click();
  for (const [label, extension] of [['Markdown file', 'md'], ['Plain text', 'txt'], ['JSON file', 'json']]) {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const file = await downloaded;
    assert(file.suggestedFilename().endsWith(`.${extension}`));
    const content = readFileSync(await file.path(), 'utf8');
    if (extension === 'json') assert(JSON.parse(content).text === transcriptText);
    else assert(content.includes(transcriptText));
  }
  await page.getByRole('button', { name: 'Create document', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create document with Mistral' });
  await dialog.waitFor();
  assert((await dialog.getByRole('textbox', { name: 'Title', exact: true }).inputValue()) === title);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: 'Ask AI about transcript', exact: true }).click();
  await page.getByRole('heading', { name: 'AI Chat', exact: true }).waitFor();
  await page.locator('.ai-source-choice').first().waitFor();
  assert.equal(await page.locator('.ai-source-choice input:checked').count(), 1);
  await page.getByRole('button', { name: 'Action items', exact: true }).click();
  assert.match(await page.getByRole('textbox', { name: 'Question about selected recordings' }).inputValue(), /action items/);
  assert(await page.getByRole('button', { name: 'Send question' }).isDisabled(), 'Consent required');
  await page.getByRole('checkbox', { name: 'Allow selected transcript text to be sent to Mistral.' }).check();
  assert(await page.getByRole('button', { name: 'Send question' }).isEnabled());
  await page.getByRole('radio', { name: 'History', exact: true }).click();
  await page.getByRole('heading', { name: 'Recent conversations' }).waitFor();
  await page.getByRole('button', { name: 'Refresh conversations' }).click();
  await page.getByRole('radio', { name: 'Sources', exact: true }).click();
  await page.getByRole('button', { name: /^Remove source / }).first().click();
  assert(await page.getByRole('button', { name: 'Send question' }).isDisabled(), 'Source required');
  await page.locator('.ai-source-choice input').first().check();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Question about selected recordings' }).inputValue(), '');
  for (const width of [1440, 1180, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['transcripts', 'ai', 'android']) {
      await page.goto(`${origin}/${route}`);
      await page.locator(`.${route === 'transcripts' ? 'transcripts' : route}-page h1`).waitFor();
      if (route === 'transcripts') {
        await page.locator('.transcript-document').first().click();
        await page.locator('.transcript-markdown').waitFor();
      }
      if (route === 'ai') {
        if (width <= 767) await page.getByRole('button', { name: 'Select transcript sources', exact: true }).click();
        await page.locator('.ai-source-choice input').first().check();
        if (width <= 767) {
          await screenshot(`ai-sources-${width}`);
          await page.getByRole('button', { name: 'Toggle sources and history' }).click();
        }
        await page.getByRole('button', { name: 'Summary', exact: true }).click();
        const box = await page.locator('.ai-input').boundingBox();
        assert(box.width > 200 && box.height >= 70, 'Composer must remain usable');
      }
      if (route === 'android') {
        await page.getByRole('heading', { name: 'Open OpenPlod on your Mac', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Show pairing QR' }).count(), 0, 'Browser must not invent pairing credentials');
        await page.getByRole('button', { name: 'Check vault connection' }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('[aria-label="Check vault connection"]')?.disabled);
        await page.getByRole('button', { name: 'Check vault connection' }).click();
      }
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.app-content,.transcripts-page,.ai-page,.android-page')].some(el => el.scrollWidth > el.clientWidth + 2)), false, `${route} overflow at ${width}`);
      await screenshot(`${route}-${width}`);
      if (route === 'transcripts' && width <= 767) {
        await page.getByRole('button', { name: 'Back to transcripts' }).click();
        await page.locator('.transcript-document').first().waitFor();
        assert(!(await page.locator('.transcript-reader').isVisible()));
        assert(!new URL(page.url()).searchParams.has('recording'));
        await page.locator('.transcript-document').first().click();
        await page.goBack();
        assert(!(await page.locator('.transcript-reader').isVisible()), 'Browser back returns to the mobile list');
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Use light mode', exact: true }).click();
  for (const route of ['transcripts', 'ai', 'android']) {
    await page.goto(`${origin}/${route}`);
    await page.locator('h1').first().waitFor();
    if (route === 'transcripts') await page.locator('.transcript-markdown').waitFor();
    await screenshot(`${route}-light`);
  }
  await page.goto(`${origin}/transcripts`);
  const transcriptRoute = '**/api/transcripts*';
  await page.route(transcriptRoute, route => route.abort('failed'));
  await page.getByRole('button', { name: 'Refresh transcripts' }).click();
  await page.locator('.transcripts-library [role="alert"]').waitFor();
  await page.unroute(transcriptRoute);
  await page.locator('.transcripts-library').getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.transcript-document').first().waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ transcriptExport: ['md', 'txt', 'json'], mistralDocumentDialog: true, explicitChatConsent: true, contextSelection: true, failureRecovery: true, realTranscriptCount: library.data.length, widths: [1440, 1180, 900, 390, 320], productionCsp: true, privateQrNotExposed: true, pageErrors: errors.length }));
} finally {
  await browser.close();
}
