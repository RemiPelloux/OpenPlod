import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const apk = resolve(process.argv[2] || 'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('Set ANDROID_HOME to the Android SDK directory.');
const latest = (directory: string) => readdirSync(directory).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const ndk = process.env.ANDROID_NDK_HOME || join(sdk, 'ndk', latest(join(sdk, 'ndk')));
const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const readobj = join(ndk, 'toolchains/llvm/prebuilt', host, 'bin/llvm-readobj');
const zipalign = join(sdk, 'build-tools', latest(join(sdk, 'build-tools')), 'zipalign');
const temp = mkdtempSync(join(tmpdir(), 'openplod-alignment-'));
type Header = { Type: { Name: string }; Alignment: number; VirtualAddress: number; Offset: number };

function command(args: string[]) {
  const result = Bun.spawnSync(args, { stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

try {
  command([zipalign, '-c', '-P', '16', '4', apk]);
  console.log('PASS APK zip alignment (16 KB)');
  command(['unzip', '-q', apk, 'lib/*', '-d', temp]);
  let failed = false;
  let checked = 0;
  for (const abi of readdirSync(join(temp, 'lib'))) {
    if (!['arm64-v8a', 'x86_64'].includes(abi)) continue;
    for (const name of readdirSync(join(temp, 'lib', abi)).filter(name => name.endsWith('.so'))) {
      const data = JSON.parse(command([readobj, '--elf-output-style=JSON', '--program-headers', join(temp, 'lib', abi, name)]));
      const loads = (data[0].ProgramHeaders as { ProgramHeader: Header }[]).map(row => row.ProgramHeader).filter(row => row.Type.Name === 'PT_LOAD');
      const aligned = loads.length > 0 && loads.every(row => row.Alignment >= 16384 && (row.VirtualAddress - row.Offset) % 16384 === 0);
      console.log(`${aligned ? 'PASS' : 'FAIL'} ${abi}/${name}: PT_LOAD alignment ${loads.map(row => row.Alignment).join(', ')}`);
      failed ||= !aligned;
      checked++;
    }
  }
  if (!checked || failed) throw new Error('APK is not 16 KB compatible. Update or rebuild the failing native libraries.');
} finally { rmSync(temp, { recursive: true, force: true }); }
