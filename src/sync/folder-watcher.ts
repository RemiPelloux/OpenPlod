/**
 * Folder Watcher — watches PlaudSync folder for new audio files.
 * Extracted from hub/src/integrations/plaud.ts, R2/Vault deps removed.
 * Files stay on disk; we just track them in SQLite.
 */

import { watch, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { db } from '../db/client';
import { recordings, userSettings } from '../db/schema';
import { eq } from 'drizzle-orm';
import { importRecordingFile, inferRecordingType } from '../library/recording-library';
import { queueRecordingProcessing } from '../library/processing';

export interface PlaudRecording {
  filename: string;
  path: string;
  size: number;
  modifiedAt: Date;
}

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.aac', '.flac']);

export class FolderWatcher {
  private syncPath: string | null;
  private watcher: ReturnType<typeof watch> | null = null;
  private isWatching = false;
  private processedFiles = new Set<string>();
  private pendingFiles = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(syncPath?: string) {
    this.syncPath = syncPath || process.env.PLAUD_SYNC_PATH || null;

    if (this.syncPath && existsSync(this.syncPath)) {
      console.log(`[FolderWatcher] Configured: ${this.syncPath}`);
    } else if (this.syncPath) {
      console.log(`[FolderWatcher] Path does not exist: ${this.syncPath}`);
      this.syncPath = null;
    } else {
      console.log('[FolderWatcher] Not configured — set PLAUD_SYNC_PATH');
    }
  }

  isConfigured(): boolean {
    return this.syncPath !== null && existsSync(this.syncPath);
  }

  startWatching(): boolean {
    if (!this.syncPath || !existsSync(this.syncPath)) return false;
    if (this.isWatching) return true;

    this.watcher = watch(this.syncPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const fullPath = join(this.syncPath!, filename);
      if (existsSync(fullPath) && this.isAudio(filename)) {
        const existingTimer = this.debounceTimers.get(fullPath);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          this.debounceTimers.delete(fullPath);
          void this.processDetectedFile(fullPath).catch(error => {
            console.error(`[FolderWatcher] Failed to process ${filename}:`, error);
          });
        }, 1000);
        this.debounceTimers.set(fullPath, timer);
      }
    });

    this.isWatching = true;
    console.log('[FolderWatcher] Watching for new recordings');
    return true;
  }

  stopWatching() {
    this.watcher?.close();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.watcher = null;
    this.isWatching = false;
  }

  private isAudio(filename: string): boolean {
    return AUDIO_EXTS.has(extname(filename).toLowerCase());
  }

  /** Scan folder and list all audio files */
  listRecordings(): PlaudRecording[] {
    if (!this.syncPath || !existsSync(this.syncPath)) return [];
    const results: PlaudRecording[] = [];

    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (this.isAudio(entry.name)) {
          const stats = statSync(fullPath);
          results.push({ filename: entry.name, path: fullPath, size: stats.size, modifiedAt: stats.mtime });
        }
      }
    };

    scan(this.syncPath);
    return results;
  }

  /** Process a single file — insert into DB if new, queue for transcription */
  private async processFile(filePath: string, skipExistingCheck = false): Promise<boolean> {
    if (this.processedFiles.has(filePath) || this.pendingFiles.has(filePath)) return false;
    this.pendingFiles.add(filePath);

    try {
      if (!skipExistingCheck) {
        const existing = await db
          .select({ id: recordings.id })
          .from(recordings)
          .where(eq(recordings.filePath, filePath))
          .limit(1);

        if (existing.length > 0) {
          this.processedFiles.add(filePath);
          return false;
        }
      }

      const imported = await importRecordingFile({
        sourcePath: filePath,
        provenance: { sourceProvider: 'plaud', sourceTransport: 'folder' },
      });
      if (!imported.added) {
        this.processedFiles.add(filePath);
        return false;
      }
      const recording = imported.recording;

      this.processedFiles.add(filePath);

      const route = await queueRecordingProcessing({
        recordingId: recording.id,
        filePath: recording.filePath,
      });
      console.log(`[FolderWatcher] Imported recording ${recording.id}; processing route: ${route}`);
      if (await this.shouldDeleteSourceAfterImport()) unlinkSync(filePath);
      return true;
    } finally {
      this.pendingFiles.delete(filePath);
    }
  }

  /** Sync all existing files in folder */
  async syncAll(): Promise<{ added: number; skipped: number; errors: string[] }> {
    const result = { added: 0, skipped: 0, errors: [] as string[] };
    if (!this.isConfigured()) {
      result.errors.push('Not configured');
      return result;
    }

    const existingRows = await db.select({ filePath: recordings.filePath }).from(recordings);
    const existingPaths = new Set(existingRows.map(recording => recording.filePath));

    for (const rec of this.listRecordings()) {
      try {
        if (existingPaths.has(rec.path)) {
          result.skipped++;
          this.processedFiles.add(rec.path);
          continue;
        }
        if (await this.processFile(rec.path, true)) {
          result.added++;
          existingPaths.add(rec.path);
        }
      } catch (err) {
        result.errors.push(`${rec.filename}: ${err}`);
      }
    }

    return result;
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      watching: this.isWatching,
      syncPath: this.syncPath,
      recordingCount: this.isConfigured() ? this.listRecordings().length : 0,
    };
  }

  private async processDetectedFile(filePath: string): Promise<void> {
    const [setting] = await db.select({ value: userSettings.value }).from(userSettings)
      .where(eq(userSettings.key, 'autoImport')).limit(1);
    if (setting?.value !== 'true') return;
    if (!await this.isRecordingTypeSelected(filePath)) return;
    await this.processFile(filePath);
  }

  private async isRecordingTypeSelected(filePath: string): Promise<boolean> {
    const [setting] = await db.select({ value: userSettings.value }).from(userSettings)
      .where(eq(userSettings.key, 'plaudRecordingTypes')).limit(1);
    if (!setting?.value) return true;
    try {
      const selected = JSON.parse(setting.value);
      return Array.isArray(selected) && selected.includes(inferRecordingType(filePath));
    } catch {
      return true;
    }
  }

  private async shouldDeleteSourceAfterImport(): Promise<boolean> {
    const [setting] = await db.select({ value: userSettings.value }).from(userSettings)
      .where(eq(userSettings.key, 'deleteSourceAfterImport')).limit(1);
    return setting?.value === 'true';
  }
}
