import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPlaudCheckpoint } from './plaud-checkpoint';

test('checkpoint keeps prefix, truncates unconfirmed tail and appends each byte once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openplod-checkpoint-'));
  try {
    const path = join(directory, 'audio.part');
    await writeFile(path, Buffer.from([1, 2, 99]));
    const checkpoint = await openPlaudCheckpoint(path, 2);
    try {
      await checkpoint.save(Buffer.from([1, 2, 3]));
      await checkpoint.save(Buffer.from([1, 2, 3]));
      await checkpoint.save(Buffer.from([1, 2, 3, 4]));
      await expect(checkpoint.save(Buffer.from([1]))).rejects.toThrow('shrink');
    } finally { await checkpoint.close(); }
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
  } finally { await rm(directory, { recursive: true }); }
});
