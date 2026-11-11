// 内存响应隔离网络波动；只测读取，不把结果当作整页首帧或 FPS。
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const source = await readFile(new URL('../../js/sz-data-format.js', import.meta.url), 'utf8');
const { readCityPayload } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const formats = await Promise.all(['json', 'szc'].map(async format => ({
  format, bytes: await readFile(new URL(`../../js/sz-city.${format}.gz`, import.meta.url)), samples: []
})));
for (let round = 0; round < 12; round++) {
  // 交错顺序，前两轮预热不参与统计。
  for (const entry of round % 2 ? [...formats].reverse() : formats) {
    const metrics = {};
    const start = performance.now();
    await readCityPayload('fixture', async () => new Response(entry.bytes), metrics);
    if (round >= 2) entry.samples.push({ ...metrics, totalMs: performance.now() - start });
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ runtime: process.version, scope: 'in-memory-response-read-only',
  formats: formats.map(({ format, bytes, samples }) => ({ format, compressedBytes: bytes.length,
    medianMs: Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(samples.map(sample => sample[key]))])), samples }))
}, null, 2));
