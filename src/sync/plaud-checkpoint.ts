import { open } from 'node:fs/promises';

export async function openPlaudCheckpoint(path: string, prefixLength: number) {
  const file = await open(path, 'a+', 0o600);
  let written = prefixLength;
  try { await file.truncate(written); } catch (error) { await file.close(); throw error; }
  return {
    async save(bytes: Uint8Array) {
      if (bytes.length < written) throw new Error('Plaud checkpoint cannot shrink');
      while (written < bytes.length) {
        const result = await file.write(bytes.subarray(written));
        if (!result.bytesWritten) throw new Error('Plaud checkpoint write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
    },
    close: () => file.close(),
  };
}
