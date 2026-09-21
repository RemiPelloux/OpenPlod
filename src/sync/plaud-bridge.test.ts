import { describe, expect, test } from 'bun:test';
import { BLE_IDENTIFIER_PATTERN, isBluetoothIdentifier } from './plaud-bridge';

describe('Bluetooth bridge identifier validation', () => {
  test('accepts CoreBluetooth UUIDs and Bluetooth MAC addresses', () => {
    expect(isBluetoothIdentifier('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(isBluetoothIdentifier('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
    expect(isBluetoothIdentifier('a1:b2:c3:d4:e5:f6')).toBe(true);
    expect(isBluetoothIdentifier('AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  test('rejects names, short addresses, and malformed identifiers', () => {
    expect(isBluetoothIdentifier('Plaud Note Pro')).toBe(false);
    expect(isBluetoothIdentifier('A1:B2:C3:D4:E5')).toBe(false);
    expect(isBluetoothIdentifier('A1-B2-C3-D4-E5-F6')).toBe(false);
    expect(isBluetoothIdentifier('')).toBe(false);
  });

  test('exposes a reusable pattern', () => {
    expect(BLE_IDENTIFIER_PATTERN.test('11:22:33:44:55:66')).toBe(true);
  });
});
