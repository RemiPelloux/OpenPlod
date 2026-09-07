import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const origin = process.env.OPENPLOD_TEST_ORIGIN || 'http://127.0.0.1:3492';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use a private loopback vault');
const token = readFileSync(process.env.OPENPLOD_TEST_TOKEN_FILE, 'utf8').trim();
const { chromium } = await import(process.env.OPENPLOD_PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1586, height: 992 } });
const { app: { security: { csp } } } = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const headers = { 'X-OpenPlod-Token': token };
const errors = [];
const screenshotDir = process.env.OPENPLOD_SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
const screenshot = async name => { if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`), animations: 'disabled' }); };
const request = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(`${origin}/api${path}`, { method, headers, data });
  assert(response.ok(), `${method} ${path.split('?')[0]}: ${response.status()}`);
  return (await response.json()).data;
};
let restore;
let restoreProcessing;
try {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && route.request().isNavigationRequest()) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
    }
    return route.continue({ headers: { ...route.request().headers(), ...(url.origin === origin && url.pathname.startsWith('/api/') ? headers : {}) } });
  });
  const documents = await request('/v1/documents?limit=30');
  assert(documents.documents.length, 'A real saved document is required');
  const original = await request(`/v1/documents/${documents.documents[0].id}`);
  const documentUrl = `${origin}/notes?document=${original.id}`;
  await page.goto(documentUrl);
  await page.getByLabel('Note title', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Note title', { exact: true }).inputValue(), original.title);
  await page.locator('.notes-markdown-preview').waitFor();
  const buildIdentity = await page.locator('meta[name="openplod-build"]').getAttribute('content');
  assert.match(buildIdentity, /^\d+\.\d+\.\d+ \d{4}-\d{2}-\d{2}T/);
  await page.locator('span[title^="OpenPlod "]').filter({ hasText: 'Build' }).waitFor();
  assert(await page.locator('svg[data-openplod-icon]').count() > 20, 'Custom SVGs must render throughout the document workspace');
  assert.equal(await page.locator('svg.lucide').count(), 0, 'No legacy library icons remain');
  await screenshot('documents-desktop');
  await page.getByRole('button', { name: 'Document outline', exact: true }).click();
  const outline = page.getByRole('complementary', { name: 'Document outline', exact: true });
  await outline.waitFor();
  const headings = await page.locator('.notes-markdown-preview h1,.notes-markdown-preview h2,.notes-markdown-preview h3,.notes-markdown-preview h4,.notes-markdown-preview h5,.notes-markdown-preview h6').count();
  assert.equal(await outline.locator('nav button').count(), headings);
  if (headings) {
    await outline.locator('nav button').last().click();
    assert.match(await page.evaluate(() => document.activeElement.id), /^document-heading-/);
  }
  await screenshot('documents-outline');
  await page.getByRole('button', { name: 'Document source', exact: true }).click();
  await page.getByRole('complementary', { name: 'Document source', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close document panel', exact: true }).click();
  await page.getByRole('button', { name: 'Export note', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Markdown file', exact: true }).click();
  assert((await download).suggestedFilename().endsWith('.md'));
  await page.getByRole('button', { name: 'Document actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Note history', exact: true }).click();
  await page.getByRole('dialog', { name: 'Note history', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Send note', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send document', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('radio', { name: 'Markdown', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown content', exact: true });
  await editor.waitFor();
  await editor.evaluate(element => { element.focus(); element.setSelectionRange(0, Math.min(5, element.value.length)); });
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  const edited = await editor.inputValue();
  assert(edited.startsWith('**'), 'Toolbar must format the actual selection');
  assert.equal(await page.getByRole('button', { name: 'Save note', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Document actions', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: 'Reload saved note', exact: true }).click();
  await page.waitForFunction(content => document.querySelector('[aria-label="Markdown content"]').value === content, original.content);
  if (process.env.OPENPLOD_TEST_MUTATIONS === 'isolated-snapshot') {
    assert.equal(new URL(origin).port, '3492', 'Mutating checks are restricted to the isolated snapshot');
    restore = original;
    await editor.fill(original.content + '\n');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Save note"]').disabled);
    const saved = await request(`/v1/documents/${original.id}`);
    assert.equal(saved.content, original.content + '\n');
    assert.equal(saved.revision, original.revision + 1);
    await request(`/v1/documents/${original.id}`, 'PATCH', { content: original.content, revision: saved.revision });
    restore = null;
    await page.goto(documentUrl);
    await page.getByLabel('Note title', { exact: true }).waitFor();
  }
  for (const width of [1586, 1180, 900, 390, 320]) {
    await page.setViewportSize({ width, height: width > 1000 ? 992 : 844 });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.notes-workspace,.notes-columns,.notes-editor,.document-format-bar')].some(el => el.scrollWidth > el.clientWidth + 2)), false, `Documents overflow at ${width}`);
    assert((await page.locator('.notes-document-body').boundingBox()).height > 140, `Document remains readable at ${width}`);
    await screenshot(`documents-${width}`);
  }
  await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
  await page.locator('.notes-list-item').first().waitFor();
  await page.getByRole('button', { name: 'Toggle folders', exact: true }).click();
  await page.getByRole('complementary', { name: 'Note folders', exact: true }).waitFor();
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`${origin}/devices`);
  await page.getByRole('heading', { name: 'Plaud Note Pro', exact: true }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Automatically import new recordings"]').disabled);
  assert.equal(await page.locator('.plaud-product-image img').evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.match(await page.getByRole('region', { name: 'Recordings on Note Pro', exact: true }).innerText(), /unknown/);
  assert.equal(await page.getByRole('button', { name: 'Import selected', exact: true }).isDisabled(), true);
  await screenshot('plaud-desktop');
  await page.getByRole('button', { name: 'Connect Note Pro', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel device operation', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.plaud-connect-actions button').disabled);
  assert.match(await page.getByRole('region', { name: 'Recordings on Note Pro', exact: true }).innerText(), /unknown/);
  if (process.env.OPENPLOD_TEST_MUTATIONS === 'isolated-snapshot') {
    const settings = await request('/settings');
    restoreProcessing = { autoTranscribe: settings.autoTranscribe, autoSummarize: settings.autoSummarize };
    for (const [key, name] of [['autoTranscribe', 'Transcribe after import'], ['autoSummarize', 'Summarize after transcription']]) {
      const control = page.getByRole('switch', { name, exact: true });
      const previous = await control.getAttribute('aria-checked');
      await control.click();
      await page.waitForFunction(label => !document.querySelector(`[aria-label="${label}"]`).disabled, name);
      assert.equal((await request('/settings'))[key], previous === 'true' ? 'false' : 'true');
      await request(`/settings/${key}`, 'PUT', { value: String(restoreProcessing[key]) });
    }
    restoreProcessing = null;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Automatically import new recordings"]')?.disabled);
  }
  for (const width of [1672, 1180, 900, 390, 320]) {
    await page.setViewportSize({ width, height: width > 1000 ? 941 : 844 });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.plaud-workspace,.plaud-workspace-grid,.plaud-device-overview,.plaud-health,.plaud-vault-column')].some(el => el.scrollWidth > el.clientWidth + 2)), false, `Plaud overflow at ${width}`);
    await screenshot(`plaud-${width}`);
  }
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.plaud-switch > span').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await page.getByRole('button', { name: 'Use light mode', exact: true }).click();
  await screenshot('plaud-light');
  await page.goto(documentUrl);
  await page.getByLabel('Note title', { exact: true }).waitFor();
  await screenshot('documents-light');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ realDocuments: documents.total, formatting: true, outline: true, export: true, history: true, sendDialog: true, draftDiscard: true, saveVersioned: process.env.OPENPLOD_TEST_MUTATIONS === 'isolated-snapshot', processingPreferences: process.env.OPENPLOD_TEST_MUTATIONS === 'isolated-snapshot', responsive: true, deviceUnknown: true, deviceCancellation: true, realProductAsset: true, reducedMotion: true, pageErrors: errors.length }));
} finally {
  if (restoreProcessing) for (const [key, value] of Object.entries(restoreProcessing)) await request(`/settings/${key}`, 'PUT', { value: String(value) });
  if (restore) {
    const current = await request(`/v1/documents/${restore.id}`);
    await request(`/v1/documents/${restore.id}`, 'PATCH', { content: restore.content, title: restore.title, revision: current.revision });
  }
  await browser.close();
}
