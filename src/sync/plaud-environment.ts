import { existsSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import {
  bleDoctorCommand, bluetoothBackend, bridgeBackend, findRustBridge, isDesktopPlatform,
  swiftBridgeScript, usesSwiftBridge,
} from './plaud-bridge';
import { identityFilePath, readStoredIdentity } from './plaud-provision';

/**
 * Host autodetection for direct Bluetooth transfer.
 *
 * Direct extraction needs four independent things to be true, and until 0.6.0 a
 * failure in any of them surfaced as the same vague "Bluetooth scan failed".
 * This module checks each one separately so the vault can name the single thing
 * that is missing and what to do about it:
 *
 *  1. a desktop OS with a Bluetooth backend (`corebluetooth`/`bluez`/`winrt`),
 *  2. the `plaud-bridge` helper, built or bundled,
 *  3. a Bluetooth adapter that is present and powered on,
 *  4. `ffmpeg`/`ffprobe`, which decode and verify a downloaded recording,
 *  5. a provisioned recorder identity (the Plaud-minted key material).
 *
 * Everything here is read-only and safe to call on any platform, including
 * mobile and CI, where it reports an honest "not supported" instead of throwing.
 */

/** One checked precondition, with a fix the user can act on. */
export interface EnvironmentCheck {
  id: 'platform' | 'bridge' | 'adapter' | 'audio-tools' | 'identity';
  label: string;
  ok: boolean;
  detail: string;
  /** What to do when `ok` is false. Null when the check passed. */
  remediation: string | null;
  /** False when nothing the user does on this machine can satisfy the check. */
  actionable: boolean;
}

export interface PlaudEnvironment {
  platform: string;
  arch: string;
  osRelease: string;
  /** Host Bluetooth stack, or null when this platform has none. */
  backend: string | null;
  /** Which helper would be spawned: the portable binary, or macOS Swift. */
  bridgeBackend: 'native' | 'swift';
  bridgePath: string | null;
  /** Adapter name the host reports, when it could be read. */
  adapter: string | null;
  checks: EnvironmentCheck[];
  /** True when a direct Bluetooth transfer can be attempted right now. */
  ready: boolean;
  /** The checks that are blocking, most fundamental first. */
  blockers: EnvironmentCheck[];
  checkedAt: string;
}

/** Raw shape of one `plaud-bridge doctor` report. */
interface DoctorReport {
  backend: string;
  adapterAvailable: boolean;
  poweredOn: boolean;
  adapter: string | null;
  detail: string;
}

type Spawner = (command: string[]) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): unknown };

const spawnCapture: Spawner = command => Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });

/** Run a short-lived helper and return its stdout, or null when it misbehaves. */
async function capture(command: string[], timeoutMs: number, spawn: Spawner): Promise<string | null> {
  let child: ReturnType<Spawner>;
  try { child = spawn(command); } catch { return null; }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  try {
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return timedOut || code !== 0 ? null : output;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the bridge about the host Bluetooth stack without scanning. */
export async function readDoctorReport(spawn: Spawner = spawnCapture): Promise<DoctorReport | null> {
  const command = bleDoctorCommand();
  if (!command) return null;
  const output = await capture(command, 10_000, spawn);
  if (output === null) return null;
  try {
    const parsed = JSON.parse(output) as Partial<DoctorReport>;
    if (typeof parsed.adapterAvailable !== 'boolean' || typeof parsed.poweredOn !== 'boolean') return null;
    return {
      backend: typeof parsed.backend === 'string' ? parsed.backend : (bluetoothBackend() ?? 'unknown'),
      adapterAvailable: parsed.adapterAvailable,
      poweredOn: parsed.poweredOn,
      adapter: typeof parsed.adapter === 'string' ? parsed.adapter : null,
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
    };
  } catch {
    return null;
  }
}

/** ffmpeg and ffprobe decode and verify a downloaded recording before import. */
export async function audioToolsAvailable(spawn: Spawner = spawnCapture): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
  const [ffmpeg, ffprobe] = await Promise.all([
    capture(['ffmpeg', '-version'], 5_000, spawn),
    capture(['ffprobe', '-version'], 5_000, spawn),
  ]);
  return { ffmpeg: ffmpeg !== null, ffprobe: ffprobe !== null };
}

/** Per-platform instructions for installing ffmpeg. */
function installFfmpegHint(): string {
  switch (platform()) {
    case 'darwin': return 'Install it with `brew install ffmpeg`.';
    case 'win32': return 'Install it with `winget install Gyan.FFmpeg`, then reopen OpenPlod.';
    default: return 'Install it with your package manager, for example `sudo pacman -S ffmpeg` or `sudo apt install ffmpeg`.';
  }
}

/** Per-platform instructions for a missing or blocked Bluetooth adapter. */
function adapterHint(): string {
  switch (platform()) {
    case 'darwin': return 'Turn Bluetooth on, and allow OpenPlod under System Settings → Privacy & Security → Bluetooth.';
    case 'win32': return 'Turn Bluetooth on in Windows Settings and confirm the adapter is enabled in Device Manager.';
    default: return 'Turn Bluetooth on: `rfkill unblock bluetooth` and `systemctl start bluetooth`, then retry.';
  }
}

/**
 * Inspect this machine and report every precondition for direct transfer.
 *
 * The spawners are injectable so the checks can be tested without a Bluetooth
 * adapter or an ffmpeg install present.
 */
export async function detectPlaudEnvironment(options: { spawn?: Spawner } = {}): Promise<PlaudEnvironment> {
  const spawn = options.spawn ?? spawnCapture;
  const desktop = isDesktopPlatform();
  const backend = bluetoothBackend();
  const checks: EnvironmentCheck[] = [];

  checks.push({
    id: 'platform',
    label: 'Desktop platform',
    ok: desktop,
    detail: desktop
      ? `${platform()} ${arch()} — Bluetooth via ${backend}.`
      : `${platform()} ${arch()} has no supported Bluetooth backend.`,
    remediation: desktop ? null : 'Run the OpenPlod desktop app on macOS, Linux, or Windows to transfer over Bluetooth.',
    actionable: false,
  });

  const swift = usesSwiftBridge();
  const bridgePath = swift ? (existsSync(swiftBridgeScript()) ? swiftBridgeScript() : null) : findRustBridge();
  const bridgeOk = desktop && bridgePath !== null;
  checks.push({
    id: 'bridge',
    label: 'Bluetooth bridge',
    ok: bridgeOk,
    detail: bridgeOk
      ? `${swift ? 'macOS Swift helper' : 'plaud-bridge'} found at ${bridgePath}.`
      : swift
        ? 'OPENPLOD_BLE_BACKEND=swift is set, but the Swift helper was not found.'
        : 'The plaud-bridge helper was not found.',
    remediation: bridgeOk ? null
      : swift ? 'Unset OPENPLOD_BLE_BACKEND to use the bundled cross-platform bridge.'
        : 'Build it with `bun run build:sidecar`, or reinstall the OpenPlod app.',
    actionable: desktop,
  });

  // The adapter can only be probed once a bridge exists to ask.
  const doctor = bridgeOk ? await readDoctorReport(spawn) : null;
  const adapterOk = Boolean(doctor?.adapterAvailable && doctor.poweredOn);
  checks.push({
    id: 'adapter',
    label: 'Bluetooth adapter',
    ok: adapterOk,
    detail: adapterOk ? (doctor?.detail || 'Bluetooth adapter is available and powered on.')
      : !bridgeOk ? 'Not checked: the Bluetooth bridge is unavailable.'
        : doctor === null ? 'The host Bluetooth check did not report a usable result.'
          : doctor.detail,
    remediation: adapterOk ? null : bridgeOk ? adapterHint() : null,
    actionable: bridgeOk,
  });

  const tools = await audioToolsAvailable(spawn);
  const toolsOk = tools.ffmpeg && tools.ffprobe;
  const missingTools = [!tools.ffmpeg && 'ffmpeg', !tools.ffprobe && 'ffprobe'].filter(Boolean).join(' and ');
  checks.push({
    id: 'audio-tools',
    label: 'Audio tools',
    ok: toolsOk,
    detail: toolsOk ? 'ffmpeg and ffprobe are installed.' : `${missingTools} ${missingTools.includes('and') ? 'are' : 'is'} missing; downloaded audio cannot be decoded or verified.`,
    remediation: toolsOk ? null : installFfmpegHint(),
    actionable: true,
  });

  const identity = await readStoredIdentity();
  checks.push({
    id: 'identity',
    label: 'Recorder authorization',
    ok: Boolean(identity),
    detail: identity
      ? `Authorized for recorder ${identity.serial}.`
      : `No recorder identity at ${identityFilePath()}.`,
    remediation: identity ? null : 'Authorize this recorder with a Plaud sign-in token on the Plaud connection page.',
    actionable: desktop,
  });

  const blockers = checks.filter(check => !check.ok);
  return {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    backend,
    bridgeBackend: bridgeBackend(),
    bridgePath,
    adapter: doctor?.adapter ?? null,
    checks,
    ready: blockers.length === 0,
    blockers,
    checkedAt: new Date().toISOString(),
  };
}
