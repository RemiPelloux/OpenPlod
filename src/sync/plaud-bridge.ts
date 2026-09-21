import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The Bluetooth bridge is the small native helper the desktop vault spawns to
 * talk to a Plaud recorder over BLE.
 *
 * Since 0.6.0 one binary serves every desktop: `plaud-bridge` (Rust +
 * `btleplug`, `src-tauri/plaud-bridge`) binds CoreBluetooth on macOS, BlueZ on
 * Linux and WinRT on Windows, so the recorder protocol above it has a single
 * code path that every platform exercises.
 *
 * The original macOS Swift helpers are kept as an escape hatch for a Mac whose
 * CoreBluetooth binding misbehaves.  They are opt-in only:
 * `OPENPLOD_BLE_BACKEND=swift`.
 */
export const BRIDGE_BINARY = process.platform === 'win32' ? 'plaud-bridge.exe' : 'plaud-bridge';

/** Desktop platforms the vault can drive Bluetooth from. */
export const DESKTOP_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];
export const isDesktopPlatform = () =>
  (DESKTOP_PLATFORMS as readonly string[]).includes(process.platform);

/** The host Bluetooth stack `plaud-bridge` binds to, keyed by platform. */
export const BLUETOOTH_BACKENDS: Record<DesktopPlatform, string> = {
  darwin: 'corebluetooth',
  linux: 'bluez',
  win32: 'winrt',
};

/** Name of the Bluetooth stack this machine uses, or `null` off desktop. */
export const bluetoothBackend = (): string | null =>
  BLUETOOTH_BACKENDS[process.platform as DesktopPlatform] ?? null;

/** CoreBluetooth UUID (macOS) or BD_ADDR (Linux/Windows). */
export const BLE_IDENTIFIER_PATTERN = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{2}(?::[0-9a-f]{2}){5})$/i;

/** Bluetooth identifiers are CoreBluetooth UUIDs (macOS) or BD_ADDR (Linux/Windows). */
export const isBluetoothIdentifier = (value: string) => BLE_IDENTIFIER_PATTERN.test(value);

/**
 * The Swift helpers only exist on macOS and are never chosen automatically, so
 * a Linux or Windows box can never be steered onto a backend it cannot run.
 */
export const usesSwiftBridge = () =>
  process.platform === 'darwin' && process.env.OPENPLOD_BLE_BACKEND === 'swift';

/** Which helper this machine will spawn: the portable binary or macOS Swift. */
export const bridgeBackend = (): 'native' | 'swift' => (usesSwiftBridge() ? 'swift' : 'native');

/** Locate the cross-platform Rust bridge, if it has been built or installed. */
export function findRustBridge(): string | null {
  const override = process.env.OPENPLOD_BLE_BRIDGE;
  if (override) return existsSync(override) ? override : null;
  const candidates: string[] = [];
  // Packaged app: the bridge is bundled next to the server executable.
  if (process.execPath) candidates.push(join(dirname(process.execPath), BRIDGE_BINARY));
  // Development and build output.
  candidates.push(
    join(process.cwd(), 'src-tauri', 'plaud-bridge', 'target', 'release', BRIDGE_BINARY),
    join(process.cwd(), 'src-tauri', 'plaud-bridge', 'target', 'debug', BRIDGE_BINARY),
    join(process.cwd(), 'src-tauri', 'target', 'release', BRIDGE_BINARY),
    join(process.cwd(), 'src-tauri', 'target', 'debug', BRIDGE_BINARY),
  );
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/** Path to the macOS Swift session helper (opt-in backend only). */
export const swiftBridgeScript = () => process.env.OPENPLOD_BLE_SCRIPT || 'scripts/plaud-bridge.swift';
/** Path to the macOS Swift scan helper (opt-in backend only). */
export const swiftScanScript = () => process.env.OPENPLOD_SCAN_SCRIPT || 'scripts/scan-plaud.swift';

/** True when BLE support is available on this platform (native helper present). */
export function bluetoothSupported() {
  if (!isDesktopPlatform()) return false;
  return usesSwiftBridge() ? existsSync(swiftBridgeScript()) : findRustBridge() !== null;
}

const missingBridge = () =>
  new Error('The OpenPlod Bluetooth bridge is not installed. Reinstall the app, or build it with `bun run build:sidecar`.');

/**
 * Resolve the bridge the connect protocol should be spawned from.  Throws when
 * no usable helper exists so callers can surface an actionable message.
 */
export function defaultBridgeSpec(): string {
  if (usesSwiftBridge()) return swiftBridgeScript();
  const binary = findRustBridge();
  if (!binary) throw missingBridge();
  return binary;
}

/** Invocation for the one-shot "scan and report a probe" bridge. */
export function bleScanCommand(): string[] {
  if (usesSwiftBridge()) return ['swift', swiftScanScript()];
  const binary = findRustBridge();
  if (!binary) throw missingBridge();
  return [binary, 'scan'];
}

/**
 * Invocation for the non-scanning host check.  The Swift helpers never had one,
 * so a Mac pinned to that backend reports "no host check" rather than pretending.
 */
export function bleDoctorCommand(): string[] | null {
  if (usesSwiftBridge()) return null;
  const binary = findRustBridge();
  return binary ? [binary, 'doctor'] : null;
}
