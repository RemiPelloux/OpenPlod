import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const repo = resolve(import.meta.dir, '..');
const destination = '/Applications/OpenPlod.app';
const built = join(repo, 'src-tauri/target/release/bundle/macos/OpenPlod.app');
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const bundleId = 'com.openplod.vault';
const command = (name: string, args: string[]) => execFileSync(name, args, { cwd: repo, stdio: 'inherit' });
const capture = (name: string, args: string[]) => execFileSync(name, args, { cwd: repo, encoding: 'utf8' }).trim();
const args = process.argv.slice(2);
const extraCopies: string[] = [];
let build = true, launch = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-build') build = false;
  else if (args[i] === '--launch') launch = true;
  else if (args[i] === '--archive-copy' && args[i + 1]) extraCopies.push(resolve(args[++i]));
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (process.platform !== 'darwin') throw new Error('This installer is only for macOS.');

function requireBundle(path: string) {
  if (!path.endsWith('.app') || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error(`Not a regular app bundle: ${path}`);
  const id = capture('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents/Info.plist')]);
  if (id !== bundleId) throw new Error(`Refusing to modify an unrelated app: ${path}`);
}
function requireStopped() {
  const lines = capture('ps', ['-axo', 'pid,comm']).split('\n').filter(line => /\/OpenPlod[^/]*\.app\/Contents\/MacOS\/(openplod|openplod-server)\s*$/.test(line));
  if (lines.length) throw new Error('Quit OpenPlod before installing. Unsaved documents and active recording sessions must not be interrupted.');
}
function unregister(path: string) {
  try { capture(register, ['-u', path]); } catch { console.warn(`Launch Services did not have a removable registration for ${path}`); }
}
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
requireStopped();
if (build) command('bun', ['run', 'tauri', 'build', '--bundles', 'app']);
requireBundle(built);
command('codesign', ['--force', '--deep', '--sign', '-', built]);
command('codesign', ['--verify', '--deep', '--strict', built]);
const copies = [...new Set([join(repo, 'src-tauri/target/debug/bundle/macos/OpenPlod.app'), ...extraCopies, built])]
  .filter(path => path !== destination && existsSync(path));
for (const path of copies) requireBundle(path);
if (existsSync(destination)) requireBundle(destination);

const backupRoot = join(homedir(), 'Library/Application Support/OpenPlod-install-archives');
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const archives = mkdtempSync(join(backupRoot, 'update-'));
const archived: { original: string; archive: string; executableSha256: string }[] = [];
function archive(path: string) {
  requireBundle(path);
  const zip = join(archives, `${String(archived.length + 1).padStart(2, '0')}-${basename(path, '.app')}.zip`);
  command('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path, zip]);
  command('unzip', ['-tq', zip]);
  archived.push({ original: path, archive: zip, executableSha256: hash(join(path, 'Contents/MacOS/openplod')) });
  writeFileSync(join(archives, 'manifest.json'), JSON.stringify(archived, null, 2), { mode: 0o600 });
}

// Stage and verify before replacing the installed bundle; keep the old copy for rollback.
const staging = mkdtempSync('/Applications/.OpenPlod-install-');
const staged = join(staging, 'OpenPlod.app');
const previous = join(staging, 'previous.app');
let installed = false;
try {
  command('ditto', [built, staged]);
  command('codesign', ['--verify', '--deep', '--strict', staged]);
  requireStopped();
  if (existsSync(destination)) { archive(destination); unregister(destination); renameSync(destination, previous); }
  try {
    renameSync(staged, destination);
    command('codesign', ['--verify', '--deep', '--strict', destination]);
    if (hash(join(destination, 'Contents/MacOS/openplod')) !== hash(join(built, 'Contents/MacOS/openplod'))) throw new Error('Installed executable does not match the build.');
    command(register, ['-f', destination]);
    installed = true;
  } catch (error) {
    if (existsSync(destination)) { requireBundle(destination); rmSync(destination, { recursive: true }); }
    if (existsSync(previous)) { renameSync(previous, destination); command(register, ['-f', destination]); }
    throw error;
  }
  if (existsSync(previous)) { requireBundle(previous); rmSync(previous, { recursive: true }); }
  for (const path of copies) {
    archive(path);
    unregister(path);
    requireBundle(path);
    rmSync(path, { recursive: true });
  }
  command(register, ['-f', destination]);
  console.log(JSON.stringify({ installed: destination, sha256: hash(join(destination, 'Contents/MacOS/openplod')), archivedCopies: archived.length, archives }, null, 2));
} finally {
  if (existsSync(staged)) { requireBundle(staged); rmSync(staged, { recursive: true }); }
  if (!existsSync(previous)) rmdirSync(staging);
}
if (launch && installed) {
  // CLI XPC identity can make WebKit treat its child as a daemon and leave the window blank.
  const env = { ...process.env };
  delete env.XPC_SERVICE_NAME;
  delete env.XPC_FLAGS;
  const child = spawn(join(destination, 'Contents/MacOS/openplod'), [], { detached: true, stdio: 'ignore', cwd: dirname(destination), env });
  child.unref();
  console.log(`Started installed OpenPlod (PID ${child.pid}).`);
}
