import { expect, test } from 'bun:test';
import { PlaudTransport, type PlaudBridgeProcess } from './plaud-transport';

function fixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>, finish!: (code: number) => void;
  const writes: string[] = [];
  let ended = false;
  const close = () => { if (!ended) { ended = true; controller.close(); finish(0); } };
  const process: PlaudBridgeProcess = {
    stdout: new ReadableStream({ start: stream => { controller = stream; } }),
    stderr: new ReadableStream({ start: stream => stream.close() }),
    stdin: { write: value => writes.push(value), flush: () => {}, end: close },
    exited: new Promise(resolve => { finish = resolve; }), kill: close,
  };
  const transport = new PlaudTransport('00000000-0000-0000-0000-000000000001', 'fixture', () => process);
  return { transport, process, writes, send: (event: unknown) => controller.enqueue(Buffer.from(JSON.stringify(event) + '\n')) };
}

test('bridge readiness waits for subscription-ready event and routes early notifications', async () => {
  const f = fixture();
  try {
    let ready = false;
    const waiting = f.transport.wait(event => event.event === 'ready').then(() => { ready = true; });
    f.send({ event: 'connected' });
    await Bun.sleep(5); expect(ready).toBe(false);
    f.send({ event: 'packet', data: Buffer.from([1, 9, 0]).toString('base64') });
    f.send({ event: 'ready', maxWrite: 512 });
    await waiting;
    expect(await f.transport.packet()).toEqual(Buffer.from([1, 9, 0]));
    const write = f.transport.write(Buffer.from([1, 26, 0]));
    const command = JSON.parse(f.writes[0]!);
    f.send({ event: 'reply', id: command.id, ok: true });
    await write;
  } finally { await f.transport.close(); }
});

test('transport timeout does not consume future events and close cancels outstanding waits', async () => {
  const f = fixture();
  await expect(f.transport.packet(5)).rejects.toThrow('timeout');
  f.send({ event: 'packet', data: 'AQ==' });
  expect(await f.transport.packet()).toEqual(Buffer.from([1]));
  const pending = f.transport.packet().catch(error => error);
  await f.transport.close();
  expect((await pending).message).toContain('closed');
  await f.transport.close();
});

test('disconnect and stdin failure reject pending operations without leaking request payloads', async () => {
  const f = fixture();
  const pending = f.transport.packet().catch(error => error);
  f.send({ event: 'closed', reason: 'disconnected' });
  expect((await pending).message).toContain('disconnected');
  await f.transport.close();
  const g = fixture();
  g.process.stdin.write = () => { throw new Error('sensitive-payload'); };
  await expect(g.transport.request('rsa-decrypt', { key: 'sensitive-payload' })).rejects.toThrow('Bluetooth bridge write failed');
  await g.transport.close();
});
