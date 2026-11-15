import { basename } from 'node:path';

// Long recordings may encode for minutes. Only kill a stalled process, not one
// still producing FFmpeg progress; retain a bounded diagnostic on failure.
export async function runPlaudAudioTool(command: string[], options: { signal?: AbortSignal; idleTimeoutMs?: number; onOutput?: (chunk: string) => void } = {}) {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const timeout = options.idleTimeoutMs ?? 45000;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; child.kill(); }, timeout);
  };
  const abort = () => child.kill();
  options.signal?.addEventListener('abort', abort, { once: true });
  arm();
  async function capture(stream: ReadableStream<Uint8Array>, progress: boolean) {
    const reader = stream.getReader();
    let output = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (progress) arm();
        const text = decoder.decode(value, { stream: true });
        if (progress) options.onOutput?.(text);
        output = (output + text).slice(-65536);
      }
      return output + decoder.decode();
    } finally { reader.releaseLock(); }
  }
  try {
    const [output, diagnostic, code] = await Promise.all([
      capture(child.stdout, true), capture(child.stderr, false), child.exited,
    ]);
    options.signal?.throwIfAborted();
    const name = basename(command[0]!);
    if (stalled) throw new Error(`${name} made no progress for ${timeout / 1000} seconds. Downloaded audio is kept for retry.`);
    if (code !== 0) throw new Error(`${name} failed (exit ${code}): ${diagnostic.trim().slice(-2000) || 'no diagnostic available'}. Downloaded audio is kept for retry.`);
    return output;
  } finally {
    clearTimeout(timer!);
    options.signal?.removeEventListener('abort', abort);
    child.kill();
  }
}
