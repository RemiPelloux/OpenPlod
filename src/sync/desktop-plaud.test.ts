import { describe, expect, test } from 'bun:test';
import { coalescedProbe, parsePlaudProbe } from './desktop-plaud';

describe('desktop Plaud diagnostics', () => {
  test('preserves device presence when its connection fails', () => {
    expect(parsePlaudProbe(JSON.stringify({ detected: true, name: 'PLAUD Note Pro',
      connectionVerified: false, detail: 'Connection timed out' }))).toMatchObject({ detected: true, connectionVerified: false });
  });
  test('rejects malformed scanner output and inconsistent connection state', () => {
    expect(parsePlaudProbe('No Plaud found').detected).toBe(false);
    expect(parsePlaudProbe('{"detected":"true"}').connectionVerified).toBe(false);
    expect(parsePlaudProbe(JSON.stringify({ detected: false, name: 'PLAUD', connectionVerified: true, detail: 'Missing' })))
      .toMatchObject({ detected: false, name: null, connectionVerified: false });
  });
  test('coalesces concurrent scans and caches their result', async () => {
    let calls = 0;
    const probe = coalescedProbe(async () => { calls++; return { detected: false, name: null, connectionVerified: false, detail: 'Not found',
      identifier: null, serial: null, protocolVersion: null, rssi: null }; });
    const results = await Promise.all([probe(), probe(), probe()]);
    expect(calls).toBe(1);
    expect(await probe()).toEqual(results[0]);
    expect(calls).toBe(1);
  });
  test('reads the recorder serial and address from the advertisement', () => {
    // Real Plaud Note Pro advertisement captured over BlueZ/btleplug (company id restored by the bridge).
    const framed = 'XQACcQMEVgAHAQiIELUDJxdTIkQUAAQBAQ==';
    const probe = parsePlaudProbe(JSON.stringify({ detected: true, name: 'Plaud Note Pro', connectionVerified: true,
      detail: 'ok', identifier: 'C4:96:9D:11:27:21', serial: null, protocolVersion: null, rssi: null,
      manufacturerData: [{ companyId: 93, data: framed }] }));
    expect(probe).toMatchObject({ identifier: 'C4:96:9D:11:27:21', serial: '8810B50327175322', protocolVersion: 20 });
  });
  test('retries failed scans after cache expiration', async () => {
    let calls = 0;
    const probe = coalescedProbe(async () => { calls++; throw new Error('unavailable'); }, 0);
    expect((await probe()).detected).toBe(false);
    await probe();
    expect(calls).toBe(2);
  });
});
