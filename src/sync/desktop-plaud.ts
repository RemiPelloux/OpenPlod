export interface DesktopPlaudProbe {
  detected: boolean;
  name: string | null;
  connectionVerified: boolean;
  detail: string;
}

const unavailable = (detail: string): DesktopPlaudProbe => ({
  detected: false, name: null, connectionVerified: false, detail,
});

export function parsePlaudProbe(output: string): DesktopPlaudProbe {
  try {
    const result = JSON.parse(output);
    if (typeof result.detected !== 'boolean' || typeof result.connectionVerified !== 'boolean'
      || typeof result.detail !== 'string' || (result.name !== null && typeof result.name !== 'string')) {
      return unavailable('The Bluetooth scanner returned an invalid result.');
    }
    return { detected: result.detected, name: result.detected ? result.name : null,
      connectionVerified: result.detected && result.connectionVerified, detail: result.detail };
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
  if (process.platform !== 'darwin') return unavailable('Bluetooth detection is currently available on macOS.');
  const script = process.env.OPENPLOD_SCAN_SCRIPT || 'scripts/scan-plaud.swift';
  const child = Bun.spawn(['swift', script], { stdout: 'pipe', stderr: 'ignore' });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 35_000);
  try {
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return timedOut ? unavailable('Bluetooth scan timed out. Check Bluetooth permissions and retry.') : parsePlaudProbe(output);
  } finally { clearTimeout(timeout); }
});
