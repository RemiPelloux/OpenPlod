export interface PlaudImportProgress {
  stage: 'connecting' | 'downloading' | 'decrypting' | 'converting' | 'verifying' | 'saving' | 'complete';
  percent: number | null;
  receivedBytes: number;
  totalBytes: number;
  resumedBytes: number;
}

export const bytePercent = (received: number, total: number) => total > 0
  ? Math.min(100, Math.max(0, Math.floor(received * 100 / total))) : null;

export function ffmpegProgress(duration: number, report: (percent: number | null) => void) {
  let pending = '';
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop()!.slice(-4096);
    for (const line of lines) {
      const match = /^out_time_us=(\d+)\r?$/.exec(line);
      if (match && Number.isFinite(duration) && duration > 0) {
        report(bytePercent(Number(match[1]), duration * 1000000));
      }
    }
  };
}
