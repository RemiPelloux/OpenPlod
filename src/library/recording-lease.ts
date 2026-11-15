// Application-level exclusion: audio replacement, purge and device deletion must
// not race. This does not protect against external filesystem modifications.
const active = new Set<string>();

export async function withRecordingLease<T>(id: string, operation: () => Promise<T>): Promise<T> {
  if (active.has(id)) throw new Error('Recording is busy. Try again when the current operation finishes.');
  active.add(id);
  try { return await operation(); }
  finally { active.delete(id); }
}
