import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const revision = 'c5111a44938b8739313dcb5f105f696c6af8ad8d';
const expected = 'd342c8ca58a7326fb4f11e73ce23e00ae21a83c4bc399d869835e14013c6ab02';
const directory = 'src-tauri/gen/android/app/libs';
const destination = `${directory}/plaud-sdk.aar`;
const existing = Bun.file(destination);
if (await existing.exists() && createHash('sha256').update(new Uint8Array(await existing.arrayBuffer())).digest('hex') === expected) {
  console.log('Pinned Plaud SDK verified.');
} else {
  const response = await fetch(`https://raw.githubusercontent.com/Plaud-AI/plaud-sdk-public/${revision}/sdk/android/plaud-sdk.aar`);
  if (!response.ok) throw new Error(`SDK download failed: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== expected) throw new Error('Plaud SDK checksum mismatch.');
  await mkdir(directory, { recursive: true });
  await Bun.write(destination, bytes);
  console.log('Pinned Plaud SDK downloaded and verified.');
}
