import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

export type PlaudEvent = { event: string; id?: number; ok?: boolean; data?: string; uuid?: string;
  reason?: string; maxWrite?: number };
export interface PlaudBridgeProcess {
  stdin: { write(value: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>; kill(): unknown;
}

export class PlaudTransport {
  private child;
  private events: PlaudEvent[] = [];
  private waiters = new Set<{ match: (event: PlaudEvent) => boolean; accept: (event: PlaudEvent) => void;
    reject: (error: Error) => void }>();
  private sequence = 0;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  readonly metadata: Record<string, string> = {};

  constructor(identifier: string, script = process.env.OPENPLOD_BLE_SCRIPT || 'scripts/plaud-bridge.swift',
    launch: (command: string[]) => PlaudBridgeProcess = command => Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identifier)) throw new Error('Invalid Bluetooth device identifier');
    this.child = launch(['swift', script, identifier]);
    const lines = createInterface({ input: Readable.fromWeb(this.child.stdout as never) });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('Invalid Bluetooth bridge response')); }
    });
    void this.child.exited.then(() => this.fail(new Error('Bluetooth bridge exited')));
    void new Response(this.child.stderr).text();
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of [...this.waiters]) waiter.reject(this.failure);
  }

  private receive(event: PlaudEvent) {
    if (event.event === 'closed') { this.fail(new Error(`Bluetooth ${event.reason ?? 'closed'}`)); return; }
    if (event.event === 'metadata' && event.uuid && event.data) { this.metadata[event.uuid] = event.data; return; }
    if (event.event === 'connected' || event.event === 'read_error') return;
    const waiter = [...this.waiters].find(item => item.match(event));
    if (waiter) waiter.accept(event);
    else if (this.events.length < 4096) this.events.push(event);
    else { this.fail(new Error('Bluetooth receive queue overflow')); this.child.kill(); }
  }

  wait(match: (event: PlaudEvent) => boolean, timeoutMs = 10000): Promise<PlaudEvent> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.events.findIndex(match);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter = { match, accept: (event: PlaudEvent) => { finish(); resolve(event); },
        reject: (error: Error) => { finish(); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error('Bluetooth response timeout')), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async request(op: string, data: Record<string, unknown> = {}): Promise<PlaudEvent> {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const reply = this.wait(event => event.event === 'reply' && event.id === id);
    try {
      this.child.stdin.write(JSON.stringify({ ...data, op, id }) + '\n');
      this.child.stdin.flush();
    } catch { this.fail(new Error('Bluetooth bridge write failed')); }
    const result = await reply;
    if (!result.ok) throw new Error(`Bluetooth ${op} failed`);
    return result;
  }

  async write(packet: Uint8Array) { await this.request('write', { data: Buffer.from(packet).toString('base64') }); }

  async packet(timeoutMs = 10000): Promise<Buffer> {
    const event = await this.wait(event => event.event === 'packet', timeoutMs);
    if (!event.data) throw new Error('Empty Bluetooth packet');
    return Buffer.from(event.data, 'base64');
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new Error('Bluetooth session closed'));
    this.closing = (async () => {
      try { this.child.stdin.end(); } catch { this.child.kill(); }
      const timer = setTimeout(() => this.child.kill(), 2000);
      try { await this.child.exited; } finally { clearTimeout(timer); }
    })();
    return this.closing;
  }
}
