import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Read-only acceptance for the Transcript Studio (roadmap TS-02..TS-06, TS-09)
// against an existing vault. This check must never mutate the vault or call an
// AI provider: it exercises the panels, the read-only endpoints and the honest
// empty/unavailable states, not the write paths.
const origin = process.env.OPENPLOD_TEST_ORIGIN || 'http://127.0.0.1:3492';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const token = process.env.OPENPLOD_TEST_TOKEN_FILE ? readFileSync(process.env.OPENPLOD_TEST_TOKEN_FILE, 'utf8').trim() : '';
const headers = token ? { 'X-OpenPlod-Token': token } : {};
// Playwright may resolve as ESM or as CJS interop depending on where it is
// installed, so accept either shape.
const playwright = await import(process.env.OPENPLOD_PLAYWRIGHT_PATH || 'playwright');
const { chromium } = playwright.chromium ? playwright : playwright.default;
// OPENPLOD_BROWSER_PATH lets the check run against a system Chromium when the
// Playwright-managed download is absent or a different build.
const browser = await chromium.launch({
  headless: true,
  ...(process.env.OPENPLOD_BROWSER_PATH ? { executablePath: process.env.OPENPLOD_BROWSER_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const screenshots = process.env.OPENPLOD_SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true, mode: 0o700 });
const { app: { security: { csp } } } = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const screenshot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true }); };
const api = async path => {
  const response = await page.request.get(`${origin}/api${path}`, { headers });
  assert(response.ok(), `API status ${response.status()} for ${path}`);
  return response.json();
};

const observed = { widths: [], tabs: [] };
try {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && route.request().isNavigationRequest()) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
    }
    // The studio's write and AI routes are POSTs; blocking them proves this
    // check cannot spend money or alter a real vault. The batch *estimate* is
    // the one exception: it is a POST only because it takes a list of IDs, it
    // reads configuration and counts, and it starts no work. POST /batch
    // itself — the call that would actually run transcription — stays blocked.
    const readOnlyPost = url.pathname === '/api/recordings/batch/estimate';
    assert(!(url.origin === origin && route.request().method() !== 'GET' && !readOnlyPost),
      `This UI check must not mutate the vault or call AI (${route.request().method()} ${url.pathname})`);
    return route.continue({ headers: { ...route.request().headers(), ...(url.origin === origin && url.pathname.startsWith('/api/') ? headers : {}) } });
  });

  // The list endpoint carries no transcript text, so find a real one by detail.
  const { data: recordings } = await api('/recordings');
  let withTranscript = null;
  for (const item of recordings) {
    const { data: detail } = await api(`/recordings/${item.id}`);
    if (detail.transcript?.fullText?.trim()) { withTranscript = detail; break; }
  }
  assert(withTranscript, 'Acceptance requires a real recording with a saved transcript');
  observed.recordingId = withTranscript.id;

  await page.goto(`${origin}/recording/${withTranscript.id}`);
  // The studio is a mode of the main pane, not a sidebar panel: it needs the
  // width for its two-column forms and its diff view.
  await page.getByRole('radio', { name: 'Studio' }).click();
  const studio = page.locator('.transcript-studio');
  await studio.waitFor();

  // Every tab must render its panel without a page error.
  for (const name of ['Edit', 'Versions', 'AI cleanup', 'Structure', 'Actions']) {
    await studio.getByRole('tab', { name }).click();
    // Wait for the loaded panel, not the loading placeholder, so a screenshot
    // is evidence of the real state rather than of a spinner. `networkidle`
    // is unusable here: the recording page polls while a job is running.
    await studio.locator('.tstudio-panel').first().waitFor();
    await studio.locator('.tstudio-empty:has-text("Loading")').waitFor({ state: 'detached' }).catch(() => {});
    observed.tabs.push(name);
    await screenshot(`tstudio-${name.toLowerCase().replace(/\s+/g, '-')}`);
  }

  // Edit: preview must be reachable and Apply must stay disabled until a
  // preview has actually found matches, so nothing can be written by accident.
  await studio.getByRole('tab', { name: 'Edit' }).click();
  const apply = studio.getByRole('button', { name: 'Apply' });
  assert(await apply.isDisabled(), 'Apply must be disabled before a preview');
  await studio.locator('input[placeholder="Text to find"]').fill('the');
  assert(await apply.isDisabled(), 'Apply must stay disabled until a preview reports matches');
  observed.applyGuarded = true;

  // Versions: the read-only comparison surface must list real versions.
  await studio.getByRole('tab', { name: 'Versions' }).click();
  const versions = await api(`/recordings/${withTranscript.id}/transcript/versions`);
  observed.versionCount = versions.data.length;
  if (versions.data.length > 0) await studio.locator('.tstudio-versions li').first().waitFor();

  // Structure: subtitle readiness is a GET, so its honest state must render.
  await studio.getByRole('tab', { name: 'Structure' }).click();
  const readiness = await api(`/recordings/${withTranscript.id}/transcript/subtitles`);
  observed.subtitlesExportable = readiness.data.exportable;
  if (readiness.data.exportable) {
    await studio.getByRole('button', { name: 'SRT' }).waitFor();
  } else {
    // A transcript without timings must say why, not render an empty panel.
    const empty = studio.locator('.tstudio-empty').filter({ hasText: readiness.data.detail });
    await empty.waitFor();
    observed.refusalShown = readiness.data.reason;
  }

  // Actions: the saved-action list and its creation form must render, and
  // Save must stay disabled until both fields are filled.
  await studio.getByRole('tab', { name: 'Actions' }).click();
  const saveAction = studio.getByRole('button', { name: 'Save action' });
  await saveAction.waitFor();
  assert(await saveAction.isDisabled(), 'Save action must be disabled while the form is empty');
  await studio.locator('input[placeholder="Decisions"]').fill('Probe');
  assert(await saveAction.isDisabled(), 'Save action must stay disabled without an instruction');
  observed.actionFormGuarded = true;

  // Batch transcription (TS-10) must require confirmation before it runs.
  await page.goto(`${origin}/recordings`);
  // The library polls, so networkidle never settles here; wait for the list.
  await page.locator('.studio-library').waitFor();
  const batch = page.locator('.batch-transcribe');
  await batch.waitFor();
  await page.getByRole('button', { name: 'Transcribe all' }).click();
  // The confirmation copy must appear before any work can start.
  await page.locator('.batch-confirm').waitFor();
  observed.batchConfirmRequired = true;
  await screenshot('batch-confirm');
  await page.goto(`${origin}/recording/${withTranscript.id}`);
  await page.getByRole('radio', { name: 'Studio' }).click();
  await studio.waitFor();

  // The studio must stay usable down to a phone width.
  for (const width of [1440, 1180, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await studio.waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert(!overflow, `Horizontal overflow at ${width}px`);
    observed.widths.push(width);
  }
  await screenshot('tstudio-narrow');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...observed, productionCsp: true, pageErrors: errors.length }));
} finally {
  await browser.close();
}
