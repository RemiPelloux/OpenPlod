import assert from 'node:assert/strict';
const binary = process.argv[2];
assert(binary, 'Pass the optimized plaud-http executable');
const self = Bun.spawnSync([binary, '--self-test']);
assert.equal(self.exitCode, 0, self.stderr.toString());
assert.match(self.stdout.toString(), /restrictions passed/);
const base = { url: 'https://api.plaud.ai/device-app/device/sn-sign', authorization: 'Bearer synthetic', body: '{"sns":[]}' };
const invalid = [
  'invalid json', 'x'.repeat(32769), JSON.stringify({ ...base, authorization: 'bad\r\nheader' }),
  ...['http://api.plaud.ai/device-app/device/sn-sign', 'https://attacker.example/device-app/device/sn-sign',
    'https://user@api.plaud.ai/device-app/device/sn-sign', 'https://api.plaud.ai:8443/device-app/device/sn-sign',
    'https://api.plaud.ai/device-app/device/delete', 'https://api.plaud.ai/device-app/device/sn-sign?secret=synthetic']
    .map(url => JSON.stringify({ ...base, url })),
];
for (const input of invalid) {
  const result = Bun.spawnSync([binary], { stdin: Buffer.from(input) });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout.toString()).error, 'Invalid native Plaud request.');
  assert.equal(result.stderr.toString(), '');
}
console.log(`Optimized native transport: URL self-test and ${invalid.length} rejected inputs passed (no network requests).`);
