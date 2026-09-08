import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// This acceptance check uses an existing private vault, never seeded API responses.
const origin = process.env.OPENPLOD_TEST_ORIGIN || 'http://127.0.0.1:3492';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a loopback test server');
const token = process.env.OPENPLOD_TEST_TOKEN_FILE ? readFileSync(process.env.OPENPLOD_TEST_TOKEN_FILE, 'utf8').trim() : '';
const { chromium } = await import(process.env.OPENPLOD_PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
const errors = [];
const consoleErrors = [];
let testingFailure = false;
const { app: { security: { csp } } } = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const headers = token ? { 'X-OpenPlod-Token': token } : {};
const screenshots = process.env.OPENPLOD_SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true, mode: 0o700 });
const snapshot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) }); };
const api = async path => {
  const response = await page.request.get(`${origin}/api${path}`, { headers });
  assert(response.ok(), `Private API ${path.split('?')[0]} failed: ${response.status()}`);
  return response.json();
};
try {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !testingFailure) consoleErrors.push(message.text());
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && route.request().isNavigationRequest()) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
    }
    return route.continue({ headers: { ...route.request().headers(), ...(url.origin === origin && url.pathname.startsWith('/api/') ? headers : {}) } });
  });
  const library = await api('/recordings?limit=100');
  assert(library.data.length > 0, 'A real recording is required for acceptance');
  const transcript = library.data.find(row => row.status === 'complete') || library.data[0];
  await page.goto(origin);
  await page.locator('.studio-row-main').nth(library.data.findIndex(row => row.id === transcript.id)).click();
  await page.waitForFunction(() => !document.querySelector('.preview-play')?.disabled);
  assert.equal(new URL(page.url()).pathname, '/');
  assert.match(await page.title(), /OpenPlod/);
  const waveform = await page.locator('.preview-wave canvas').first().evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, painted: pixels.filter((value, index) => index % 4 === 3 && value > 0).length };
  });
  assert(waveform.painted > 0, 'Waveform must represent real decoded audio');
  await page.waitForFunction(() => !document.querySelector('.plaud-tile')?.textContent.includes('Checking Plaud'), null, { timeout: 45000 });
  await snapshot('desktop');
  await page.getByRole('button', { name: 'Play recording', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.preview-times span').textContent !== '0:00');
  await page.getByRole('button', { name: 'Pause recording', exact: true }).click();
  await page.getByRole('button', { name: 'Playback speed: 1x', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '1.5x', exact: true }).click();
  await page.getByRole('button', { name: 'Playback speed: 1.5x', exact: true }).waitFor();
  assert.equal(await page.locator('.preview-wave audio').evaluate(audio => audio.playbackRate), 1.5);
  await page.getByRole('button', { name: 'Playback speed: 1.5x', exact: true }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: '1.5x', exact: true }).getAttribute('aria-checked'), 'true');
  await snapshot('speed-menu');
  await page.keyboard.press('Escape');
  const recordingRow = page.locator(`[data-recording-id="${transcript.id}"]`);
  await recordingRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit tags', exact: true }).click();
  const tagsDialog = page.getByRole('dialog', { name: 'Edit tags', exact: true });
  await tagsDialog.getByLabel('Add a tag', { exact: true }).fill('Uncommitted tag');
  await tagsDialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  await tagsDialog.getByRole('button', { name: 'Remove tag Uncommitted tag', exact: true }).waitFor();
  await tagsDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tagsDialog.waitFor({ state: 'hidden' });
  await recordingRow.locator('.studio-row-actions button').click();
  await page.getByRole('menuitem', { name: 'Edit tags', exact: true }).click();
  await tagsDialog.getByLabel('Add a tag', { exact: true }).waitFor();
  assert.equal(await tagsDialog.getByRole('button', { name: 'Remove tag Uncommitted tag', exact: true }).count(), 0, 'Cancel must not write tags');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Download original audio', exact: true }).hover();
  await page.getByRole('tooltip', { name: 'Download original audio' }).waitFor();
  await page.mouse.move(0, 0);
  const tab = name => page.getByRole('tab', { name, exact: true });
  await tab('Transcript').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tab('AI Summary').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await tab('Export').getAttribute('aria-selected'), 'true');
  const markdown = page.getByRole('button', { name: 'Markdown', exact: true });
  if (await markdown.isEnabled()) {
    const download = page.waitForEvent('download');
    await markdown.click();
    assert((await download).suggestedFilename().endsWith('.md'));
  }
  await tab('Notes').click();
  await page.getByLabel('Recording notes', { exact: true }).waitFor();
  await tab('Chapters').click();
  await tab('Transcript').click();
  const create = page.getByRole('button', { name: 'Create document', exact: true });
  if (await create.isEnabled()) {
    await create.click();
    await page.getByRole('dialog', { name: 'Create AI document' }).waitFor();
    await page.getByRole('button', { name: 'Generate document', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('textbox', { name: 'Ask AI about this recording' }).fill('Summarize this recording');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('recording'), transcript.id);
    assert.equal(new URL(page.url()).searchParams.get('question'), 'Summarize this recording');
    await page.goto(origin);
    await page.locator('.studio-recording').first().waitFor();
  }
  await page.locator('.command-search').click();
  const search = page.getByRole('textbox', { name: 'Search workspace' });
  await search.fill(transcript.originalFilename.slice(0, 8));
  await page.locator('.command-results > button').first().waitFor();
  await search.fill('x');
  assert.equal(await page.locator('.command-results .animate-spin').count(), 0);
  await page.getByRole('button', { name: 'Close search' }).click();
  await page.getByRole('button', { name: 'Filter recordings', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter by title or tag' }).fill('__no_matching_title__');
  await page.getByRole('button', { name: 'Show recordings', exact: true }).click();
  await page.getByRole('heading', { name: 'No matching recordings' }).waitFor();
  await page.getByRole('button', { name: 'Filter recordings', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter by title or tag' }).fill('');
  await page.getByRole('button', { name: 'Show recordings', exact: true }).click();
  await tab('Plaud').click(); await tab('All').click();
  await page.getByRole('button', { name: 'Grid view' }).click();
  assert.equal(await page.locator('.studio-grid').count(), 1);
  await page.getByRole('button', { name: 'List view' }).click();
  await page.locator('.sidebar-actions a[href="/recordings?view=starred"]').click();
  assert.equal(await page.locator('.desktop-sidebar .nav-item.active').count(), 1);
  await page.locator('.sidebar-actions a[href="/recordings?view=trash"]').click();
  assert.equal(await page.locator('.desktop-sidebar .nav-item.active').count(), 1);
  await page.locator('.sidebar-nav a[href="/android"]').click();
  await page.getByRole('heading', { name: 'Android', exact: true }).waitFor();
  await page.goto(`${origin}/settings#pairing`);
  await page.waitForFunction(() => document.querySelector('#pairing')?.open);
  await page.locator('.sidebar-nav a[href="/developer"]').click();
  await page.getByRole('heading', { name: 'API & MCP', exact: true }).waitFor();
  await page.locator('.sidebar-nav a[href="/import"]').click();
  await page.getByRole('button', { name: 'Upload audio', exact: true }).waitFor();
  await page.goto(origin);
  await page.locator('.studio-recording').first().waitFor();
  testingFailure = true;
  const audioRoute = '**/api/recordings/*/audio';
  await page.route(audioRoute, route => route.abort('failed'));
  await page.reload();
  await page.getByRole('button', { name: 'Retry playback', exact: true }).waitFor();
  await page.locator('.preview-audio-error[role="alert"]').waitFor();
  await snapshot('audio-error');
  await page.unroute(audioRoute);
  testingFailure = false;
  await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
  await page.getByRole('button', { name: 'Play recording', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Play recording', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.preview-times span').textContent !== '0:00');
  await page.getByRole('button', { name: 'Pause recording', exact: true }).click();
  for (const width of [1440, 1180, 900, 390, 320]) {
    await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.app-content,.studio-page,.studio-library')].some(element => element.scrollWidth > element.clientWidth + 2)), false, `Overflow at ${width}`);
    await snapshot(`width-${width}`);
  }
  await page.setViewportSize({ width: 1180, height: 752 });
  await page.locator('.preview-body').waitFor();
  await page.waitForFunction(() => !document.querySelector('.preview-play')?.disabled);
  await snapshot('desktop-compact');
  assert((await page.locator('.preview-body').boundingBox()).height > 100, 'Short desktop must retain readable transcript space');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.locator('.studio-source-tabs').evaluate(element => element.scrollWidth > element.clientWidth + 2), false, 'All source filters must fit a narrow phone');
  await page.locator('.studio-row-main').first().click();
  assert(new URL(page.url()).pathname.startsWith('/recording/'), 'Phone opens full detail');
  await page.waitForFunction(() => document.querySelector('.player-strip audio')?.readyState >= 1);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.player-strip audio')?.currentTime > 0.5);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Playback speed: 1x', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '1.5x', exact: true }).click();
  assert.equal(await page.locator('.player-strip audio').evaluate(audio => audio.playbackRate), 1.5);
  await snapshot('phone-detail');
  await page.setViewportSize({ width: 1440, height: 900 });
  await snapshot('recording-detail');
  for (const route of ['/notes', '/record', '/transcripts', '/ai']) {
    await page.goto(`${origin}${route}`);
    await page.locator('h1').first().waitFor();
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await snapshot(route.slice(1));
  }
  await page.goto(origin);
  await page.getByRole('button', { name: 'Play recording', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use light mode', exact: true }).click();
  assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), false);
  await snapshot('light');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(errors.length, 0, 'Unexpected browser exceptions');
  assert.equal(consoleErrors.length, 0, 'Unexpected console errors');
  console.log(JSON.stringify({ realRecordings: library.data.length, waveform, playback: true, productionCsp: true, failureRecovery: true, tooltips: true, speedMenu: true, export: true, documentDialog: true, aiContext: true, search: true, filters: true, keyboardTabs: true, navigation: true, responsive: true, pageErrors: errors.length, consoleErrors: consoleErrors.length }));
} finally {
  await browser.close();
}
