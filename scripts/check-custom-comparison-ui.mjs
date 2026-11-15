import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = 'http://openplod-fixture.invalid';
const recording = { id: 'synthetic', originalFilename: 'Synthetic.wav', status: 'complete', retentionState: 'active',
  transcript: { fullText: 'Synthetic dialogue', segments: [{ start: 0, end: 1, text: 'Synthetic dialogue' }] } };
const browser = await chromium.launch();
try {
  for (const [width, theme] of [[1440, 'dark'], [390, 'light'], [320, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
    page.setDefaultTimeout(4500);
    await page.addInitScript(theme => { localStorage.setItem('openplod.locale', 'en'); localStorage.setItem('theme', theme); }, theme);
    const errors = [], posts = [], lookups = [];
    page.on('pageerror', error => errors.push(error.message));
    const remote = 'https://speech.example/v1', local = 'http://127.0.0.1:8000/v1';
    let endpoint = remote;
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        const asset = path.startsWith('/assets/');
        const file = new URL(asset ? '../web/dist' + path : '../web/dist/index.html', import.meta.url);
        return route.fulfill({ body: await readFile(file), contentType: asset ? path.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html' });
      }
      let data = [];
      if (path === '/api/recordings/synthetic') data = recording;
      else if (path === '/api/recordings') data = [recording];
      else if (path === '/api/onboarding') data = { completedAt: '2026-01-01', skipped: true };
      else if (path === '/api/settings') data = {};
      else if (path.endsWith('/transcript/versions')) data = [{ id: 'synthetic-version', origin: 'transcription', createdAt: '2026-01-01' }];
      else if (path.endsWith('/transcript/provider-comparisons')) {
        if (req.method() === 'POST') {
          const input = req.postDataJSON(); posts.push(input);
          if (input.expectedCustomEndpoint !== endpoint) return route.fulfill({ status: 409, json: { success: false, error: 'The custom endpoint changed. Review the destination and confirm again.' } });
          data = { jobId: 'synthetic-job', alreadyQueued: false };
        } else data = { runs: [], available: { whisper: true, custom: true }, customBaseUrl: endpoint };
      } else if (path === '/api/ai-settings/check/custom') {
        const body = req.postDataJSON(); lookups.push(body);
        data = { models: body.customBaseUrl === remote ? ['remote-model'] : ['local-model'] };
      } else if (req.method() !== 'GET') {
        errors.push(`Unexpected write: ${path}`); return route.abort();
      }
      return route.fulfill({ json: { success: true, data } });
    });
    await page.goto(origin + '/recording/synthetic');
    await page.getByRole('radio', { name: 'Studio' }).click();
    const studio = page.locator('.transcript-studio');
    await studio.getByRole('tab', { name: 'Versions' }).click();
    const provider = studio.locator('label').filter({ hasText: /Choose a provider/ }).locator('select');
    const model = studio.locator('label').filter({ hasText: /Select server model/ }).locator('select');
    const run = studio.getByRole('button', { name: 'Run comparison' });
    const consent = studio.getByRole('checkbox', { name: /audio/i });
    await provider.selectOption('custom');
    assert(await run.isDisabled());
    await studio.getByRole('button', { name: 'Load server models' }).click();
    await model.selectOption('remote-model');
    assert(await run.isDisabled());
    await consent.focus(); await page.keyboard.press('Space');
    assert(await consent.isChecked());
    assert((await consent.locator('..').innerText()).includes(remote));
    endpoint = local;
    await run.click();
    await studio.getByText('The custom endpoint changed. Review the destination and confirm again.', { exact: true }).waitFor();
    assert(await run.isDisabled(), 'Stale consent must be cleared');
    await studio.getByRole('button', { name: 'Load server models' }).click();
    await model.selectOption('local-model');
    assert.equal(await model.getByRole('option', { name: 'remote-model' }).count(), 0);
    await consent.check();
    assert(await studio.getByText(local, { exact: true }).isVisible());
    await run.click();
    await studio.getByText('Queued. The Custom endpoint version appears in the list above when it finishes.').waitFor();
    assert.deepEqual(lookups, [{ customBaseUrl: remote }, { customBaseUrl: local }]);
    assert.deepEqual(posts, [
      { provider: 'custom', confirm: true, model: 'remote-model', expectedCustomEndpoint: remote },
      { provider: 'custom', confirm: true, model: 'local-model', expectedCustomEndpoint: local },
    ]);
    assert(await studio.evaluate(el => el.scrollWidth <= el.clientWidth + 2), `Studio overflows at ${width}px`);
    assert.deepEqual(errors, []);
    console.log(`PASS comparison ${width}px ${theme}: selection, consent, stale destination, recovery, isolated queue`);
    await page.close();
  }
} finally { await browser.close(); }
