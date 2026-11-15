/** One identity mutation at a time; cancellation waits until the operation settles. */
export class PlaudAuthorizationOperation {
  private current: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  private cancelled = new Map<string, number>();

  async run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (const [key, expiry] of this.cancelled) if (expiry < Date.now()) this.cancelled.delete(key);
    if (this.cancelled.has(id)) throw new Error('Recorder authorization cancelled.');
    if (this.current) throw new Error('A recorder authorization is already running. Wait or cancel it first.');
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.current = { id, controller, done };
    try { return await work(controller.signal); }
    finally { this.current = null; finish(); }
  }

  async cancel(id?: string): Promise<void> {
    // Cancellation may overtake the initial HTTP request.
    if (id !== undefined) {
      if (this.cancelled.size >= 100) this.cancelled.delete(this.cancelled.keys().next().value!);
      this.cancelled.set(id, Date.now() + 300_000);
    }
    const current = this.current;
    if (!current || (id !== undefined && current.id !== id)) return;
    current.controller.abort(new Error('Recorder authorization cancelled.'));
    await current.done;
  }
}
