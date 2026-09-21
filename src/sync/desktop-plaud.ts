import { bleScanCommand, isBluetoothIdentifier } from './plaud-bridge';
import { parseNoteProAdvertisement } from './plaud-protocol';

export interface DesktopPlaudProbe {
  detected: boolean;
  name: string | null;
  connectionVerified: boolean;
  detail: string;
  /** Bluetooth address (or CoreBluetooth UUID) used to reach the recorder. */
  identifier: string | null;
  /** Recorder serial number, when the advertisement exposes it. */
  serial: string | null;
  protocolVersion: number | null;
  rssi: number | null;
}

const unavailable = (detail: string): DesktopPlaudProbe => ({
  detected: false, name: null, connectionVerified: false, detail,
  identifier: null, serial: null, protocolVersion: null, rssi: null,
});

/** Older bridges omit `serial`, so decode it from the raw advertisement instead. */
function serialFromManufacturerData(value: unknown): { serial: string; protocolVersion: number } | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const encoded = (entry as { data?: unknown } | null)?.data;
    if (typeof encoded !== 'string') continue;
    try {
      const advertised = parseNoteProAdvertisement(new Uint8Array(Buffer.from(encoded, 'base64')));
      return { serial: advertised.serial, protocolVersion: advertised.protocolVersion };
    } catch {
      // Not a Note Pro advertisement payload; keep looking.
    }
  }
  return null;
}

export function parsePlaudProbe(output: string): DesktopPlaudProbe {
  try {
    const result = JSON.parse(output);
    if (typeof result.detected !== 'boolean' || typeof result.connectionVerified !== 'boolean'
      || typeof result.detail !== 'string' || (result.name !== null && typeof result.name !== 'string')) {
      return unavailable('The Bluetooth scanner returned an invalid result.');
    }
    if (!result.detected) return unavailable(result.detail);
    const advertised = typeof result.serial === 'string' && /^[0-9A-F]{16}$/.test(result.serial)
      ? { serial: result.serial, protocolVersion: Number.isInteger(result.protocolVersion) ? result.protocolVersion : null }
      : serialFromManufacturerData(result.manufacturerData);
    return {
      detected: true,
      name: result.name,
      connectionVerified: Boolean(result.connectionVerified),
      detail: result.detail,
      identifier: typeof result.identifier === 'string' && isBluetoothIdentifier(result.identifier) ? result.identifier : null,
      serial: advertised?.serial ?? null,
      protocolVersion: advertised?.protocolVersion ?? null,
      rssi: Number.isInteger(result.rssi) ? result.rssi : null,
    };
  } catch {
    return unavailable('The Bluetooth scanner returned an unreadable result.');
  }
}

// A burst of status requests shares one Bluetooth probe, including its failure result.
export function coalescedProbe(run: () => Promise<DesktopPlaudProbe>, cacheMs = 15_000) {
  let pending: Promise<DesktopPlaudProbe> | null = null;
  let cached: { result: DesktopPlaudProbe; expires: number } | null = null;
  return () => {
    if (pending) return pending;
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.result);
    pending = Promise.resolve().then(run).catch(() => unavailable('Bluetooth scan failed. Retry the scan.'))
      .then(result => { cached = { result, expires: Date.now() + cacheMs }; return result; })
      .finally(() => { pending = null; });
    return pending;
  };
}

export const scanDesktopPlaud = coalescedProbe(async () => {
  let command: string[];
  try { command = bleScanCommand(); }
  catch (error) { return unavailable(error instanceof Error ? error.message : 'Bluetooth detection is unavailable on this platform.'); }
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
  try {
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return timedOut ? unavailable('Bluetooth scan timed out. Check Bluetooth permissions and retry.') : parsePlaudProbe(output);
  } finally { clearTimeout(timeout); }
});
