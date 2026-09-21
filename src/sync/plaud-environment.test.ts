import { describe, expect, test } from 'bun:test';
import { audioToolsAvailable, detectPlaudEnvironment, readDoctorReport } from './plaud-environment';
import { bluetoothBackend, BLUETOOTH_BACKENDS, bridgeBackend, usesSwiftBridge } from './plaud-bridge';

/** Build a spawner that answers each command from a fixed script. */
function stubSpawn(responses: Record<string, { stdout?: string; code?: number } | 'throw'>) {
  const calls: string[][] = [];
  const spawn = (command: string[]) => {
    calls.push(command);
    const key = command[0]!.includes('plaud-bridge') ? 'plaud-bridge' : command[0]!;
    const response = responses[key];
    if (response === 'throw') throw new Error(`no such binary: ${key}`);
    const { stdout = '', code = 0 } = response ?? { code: 127 };
    return {
      stdout: new Response(stdout).body!,
      exited: Promise.resolve(code),
      kill() {},
    };
  };
  return { spawn, calls };
}

const workingTools = { ffmpeg: { stdout: 'ffmpeg version 7.1' }, ffprobe: { stdout: 'ffprobe version 7.1' } };
const healthyDoctor = {
  stdout: JSON.stringify({
    backend: 'bluez', adapterAvailable: true, poweredOn: true,
    adapter: 'hci0', detail: 'Bluetooth adapter is available and powered on.',
  }),
};

describe('Bluetooth backend autodetection', () => {
  test('names one backend per desktop platform', () => {
    expect(BLUETOOTH_BACKENDS.darwin).toBe('corebluetooth');
    expect(BLUETOOTH_BACKENDS.linux).toBe('bluez');
    expect(BLUETOOTH_BACKENDS.win32).toBe('winrt');
  });

  test('reports the backend for the host it runs on', () => {
    const backend = bluetoothBackend();
    // The suite must pass on every desktop platform, so assert the mapping
    // rather than one platform's answer.
    expect(backend).toBe(BLUETOOTH_BACKENDS[process.platform as keyof typeof BLUETOOTH_BACKENDS] ?? null);
  });

  test('defaults to the portable bridge rather than the macOS Swift helper', () => {
    expect(usesSwiftBridge()).toBe(false);
    expect(bridgeBackend()).toBe('native');
  });
});

describe('host Bluetooth check', () => {
  test('parses a healthy doctor report', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': healthyDoctor });
    const report = await readDoctorReport(spawn);
    expect(report).toMatchObject({ adapterAvailable: true, poweredOn: true, adapter: 'hci0' });
  });

  test('rejects a malformed report instead of assuming it is healthy', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': { stdout: 'not json' } });
    expect(await readDoctorReport(spawn)).toBeNull();
  });

  test('rejects a report that omits the adapter fields', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': { stdout: JSON.stringify({ backend: 'bluez' }) } });
    expect(await readDoctorReport(spawn)).toBeNull();
  });

  test('treats a nonzero exit as no result', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': { stdout: healthyDoctor.stdout, code: 1 } });
    expect(await readDoctorReport(spawn)).toBeNull();
  });
});

describe('audio tool detection', () => {
  test('detects both tools when each responds', async () => {
    const { spawn } = stubSpawn(workingTools);
    expect(await audioToolsAvailable(spawn)).toEqual({ ffmpeg: true, ffprobe: true });
  });

  test('reports a missing tool when the binary cannot be spawned', async () => {
    const { spawn } = stubSpawn({ ffmpeg: workingTools.ffmpeg, ffprobe: 'throw' });
    expect(await audioToolsAvailable(spawn)).toEqual({ ffmpeg: true, ffprobe: false });
  });
});

describe('environment report', () => {
  test('always reports every precondition, each with a stable id', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': healthyDoctor, ...workingTools });
    const environment = await detectPlaudEnvironment({ spawn });
    expect(environment.checks.map(check => check.id))
      .toEqual(['platform', 'bridge', 'adapter', 'audio-tools', 'identity']);
    expect(environment.platform).toBe(process.platform);
    expect(environment.backend).toBe(bluetoothBackend());
  });

  test('every failing check carries an actionable remediation, and passing ones do not', async () => {
    const { spawn } = stubSpawn({ ffmpeg: 'throw', ffprobe: 'throw' });
    const environment = await detectPlaudEnvironment({ spawn });
    for (const check of environment.checks) {
      if (check.ok) expect(check.remediation).toBeNull();
    }
    const tools = environment.checks.find(check => check.id === 'audio-tools')!;
    expect(tools.ok).toBe(false);
    expect(tools.remediation).toBeTruthy();
    expect(tools.detail).toContain('ffmpeg');
  });

  test('missing audio tools block readiness and appear as a blocker', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': healthyDoctor, ffmpeg: 'throw', ffprobe: 'throw' });
    const environment = await detectPlaudEnvironment({ spawn });
    expect(environment.ready).toBe(false);
    expect(environment.blockers.map(check => check.id)).toContain('audio-tools');
  });

  test('blockers are exactly the failing checks, in check order', async () => {
    const { spawn } = stubSpawn({ 'plaud-bridge': healthyDoctor, ffmpeg: 'throw', ffprobe: 'throw' });
    const environment = await detectPlaudEnvironment({ spawn });
    expect(environment.blockers).toEqual(environment.checks.filter(check => !check.ok));
  });

  test('an unpowered adapter is reported as its own failure, not a missing bridge', async () => {
    const { spawn } = stubSpawn({
      'plaud-bridge': {
        stdout: JSON.stringify({
          backend: 'bluez', adapterAvailable: true, poweredOn: false,
          adapter: 'hci0', detail: 'Bluetooth adapter is powered off. Turn Bluetooth on and retry.',
        }),
      },
      ...workingTools,
    });
    const environment = await detectPlaudEnvironment({ spawn });
    const adapter = environment.checks.find(check => check.id === 'adapter')!;
    expect(adapter.ok).toBe(false);
    expect(adapter.detail).toContain('powered off');
    expect(environment.checks.find(check => check.id === 'bridge')!.ok).toBe(true);
  });

  test('does not run the host check when no bridge is available', async () => {
    const { spawn, calls } = stubSpawn(workingTools);
    // Point the bridge override at a path that cannot exist so discovery fails.
    const previous = process.env.OPENPLOD_BLE_BRIDGE;
    process.env.OPENPLOD_BLE_BRIDGE = '/nonexistent/openplod/plaud-bridge';
    try {
      const environment = await detectPlaudEnvironment({ spawn });
      expect(environment.bridgePath).toBeNull();
      expect(environment.checks.find(check => check.id === 'bridge')!.ok).toBe(false);
      const adapter = environment.checks.find(check => check.id === 'adapter')!;
      expect(adapter.ok).toBe(false);
      expect(adapter.detail).toContain('Not checked');
      // No point telling someone to turn Bluetooth on when nothing can ask it.
      expect(adapter.remediation).toBeNull();
      expect(calls.some(command => command[0]!.includes('plaud-bridge'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENPLOD_BLE_BRIDGE;
      else process.env.OPENPLOD_BLE_BRIDGE = previous;
    }
  });
});
