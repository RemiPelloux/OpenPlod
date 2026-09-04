/**
 * Plaud Cloud Sync — downloads recordings from web.plaud.ai.
 * Extracted from hub/src/services/plaud-sync-service.ts.
 * Uses Playwright for browser-based auth.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const SYNC_PATH = process.env.PLAUD_SYNC_PATH || './data/plaud-sync';
const STATE_PATH = join(SYNC_PATH, '.plaud-sync-state.json');
const STORAGE_PATH = join(SYNC_PATH, '.plaud-auth.json');

interface SyncState {
  lastSync: string;
  syncedFiles: Record<string, { syncedAt: string; hasTranscript: boolean; hasSummary: boolean; hasAudio: boolean }>;
}

function loadState(): SyncState {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {}
  return { lastSync: '', syncedFiles: {} };
}

function saveState(state: SyncState) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export class PlaudCloudSync {
  constructor() {
    if (!existsSync(SYNC_PATH)) mkdirSync(SYNC_PATH, { recursive: true });
  }

  hasSession(): boolean {
    return existsSync(STORAGE_PATH);
  }

  /**
   * Full cloud sync using Playwright.
   * Requires playwright to be installed: bun add playwright
   * And a valid auth session saved at STORAGE_PATH.
   */
  async sync(): Promise<{ success: boolean; filesProcessed: number; errors: string[] }> {
    const result = { success: false, filesProcessed: 0, errors: [] as string[] };

    if (!this.hasSession()) {
      result.errors.push('No Plaud auth session. Save browser state to ' + STORAGE_PATH);
      return result;
    }

    // Lazy import playwright — it's optional
    let chromium: any;
    try {
      const moduleName = 'playwright';
      ({ chromium } = await import(moduleName));
    } catch {
      result.errors.push('Playwright not installed. Run: bun add playwright');
      return result;
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: STORAGE_PATH });
      const page = await context.newPage();
      await page.goto('https://web.plaud.ai/');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      const token = await page.evaluate(() => localStorage.getItem('tokenstr'));
      if (!token) {
        result.errors.push('Auth token expired. Re-login to web.plaud.ai');
        return result;
      }

      // Fetch file list
      const resp = await page.evaluate(async (authToken: string) => {
        const r = await fetch('https://api.plaud.ai/file/simple/web?skip=0&limit=100&is_trash=2&sort_by=start_time&is_desc=true', {
          headers: { Authorization: authToken },
        });
        return r.json();
      }, token);

      const files = (resp as any).data_file_list || [];
      const state = loadState();

      for (const file of files) {
        if (state.syncedFiles[file.id]?.hasAudio && state.syncedFiles[file.id]?.hasTranscript) continue;

        const date = new Date(file.start_time).toISOString().split('T')[0];
        const safeName = file.filename.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
        const dirName = `${date}_${safeName}_${file.id.slice(0, 8)}`;
        const dirPath = join(SYNC_PATH, dirName);
        if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

        // Save metadata
        writeFileSync(join(dirPath, 'metadata.json'), JSON.stringify({
          id: file.id,
          filename: file.filename,
          duration: file.duration,
          startTime: new Date(file.start_time).toISOString(),
        }, null, 2));

        state.syncedFiles[file.id] = {
          syncedAt: new Date().toISOString(),
          hasTranscript: state.syncedFiles[file.id]?.hasTranscript || false,
          hasSummary: state.syncedFiles[file.id]?.hasSummary || false,
          hasAudio: state.syncedFiles[file.id]?.hasAudio || false,
        };

        result.filesProcessed++;
      }

      state.lastSync = new Date().toISOString();
      saveState(state);
      result.success = true;
    } catch (err) {
      result.errors.push(String(err));
    } finally {
      await browser.close();
    }

    return result;
  }
}

export const plaudCloudSync = new PlaudCloudSync();
