import { expect, test } from 'bun:test';
import { runPlaudAudioTool } from './plaud-audio-tool';
const command = (script: string) => [process.execPath, '-e', script];

test('audio conversion stays alive while progress exceeds the inactivity budget', async () => {
  const output = await runPlaudAudioTool(command("let i=0; console.log('start'); const timer=setInterval(()=>{console.log('progress'); if(++i===12) clearInterval(timer);},50)"), { idleTimeoutMs: 250 });
  expect(output).toContain('progress');
});
test('audio conversion distinguishes stalls, process errors and cancellation', async () => {
  await expect(runPlaudAudioTool(command('setTimeout(()=>{},10000)'), { idleTimeoutMs: 250 })).rejects.toThrow('no progress');
  await expect(runPlaudAudioTool(command("console.error('synthetic codec error'); process.exit(7)"))).rejects.toThrow('synthetic codec error');
  const controller = new AbortController();
  const pending = runPlaudAudioTool(command('setTimeout(()=>{},10000)'), { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow();
});
