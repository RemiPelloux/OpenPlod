import { expect, test } from 'bun:test';
import { bytePercent, ffmpegProgress } from './plaud-progress';
test('download percentage includes the saved prefix and remains bounded', () => {
  expect(bytePercent(75, 100)).toBe(75);
  expect(bytePercent(110, 100)).toBe(100);
  expect(bytePercent(0, 0)).toBeNull();
});
test('conversion progress handles split lines and microsecond units without inventing completion', () => {
  const values: (number | null)[] = [];
  const read = ffmpegProgress(100, value => values.push(value));
  read('out_time_us=25'); read('000000\nprogress=continue\nout_time_us=50000000\n');
  read('out_time_us=N/A\nprogress=end\n');
  expect(values).toEqual([25, 50]);
  ffmpegProgress(NaN, value => values.push(value))('out_time_us=100\n');
  expect(values).toEqual([25, 50]);
});
