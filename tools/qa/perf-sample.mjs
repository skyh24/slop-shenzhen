// M9 性能采样脚本（ego-browser 运行）：固定渲染尺寸、固定视角、采样 rAF 帧间隔，输出 P50/P95/最大值。
// 用法（需本机 8080 已启动）：
//   ego-browser nodejs < tools/qa/perf-sample.mjs
// 可选环境变量：SZ_PERF_URL（默认 http://127.0.0.1:8080/?qa=1）、SZ_PERF_SECONDS（默认 60）、
//   SZ_PERF_WIDTH/SZ_PERF_HEIGHT（默认 2560×1440）、SZ_PERF_CAMERA（scenic 相机 id，默认不切换）
// 注意：必须在可见、聚焦的浏览器窗口下跑；后台/被遮挡窗口会被 Chromium 限到 30 Hz，
// 得到的 33 ms 帧间隔不代表场景性能（见 docs/10-PERF-QA.md 与 docs/HANDOFF.md 的 M9 记录）。

const url = process.env.SZ_PERF_URL ?? 'http://127.0.0.1:8080/?qa=1';
const seconds = Number(process.env.SZ_PERF_SECONDS ?? 60);
const width = Number(process.env.SZ_PERF_WIDTH ?? 2560);
const height = Number(process.env.SZ_PERF_HEIGHT ?? 1440);
const camera = process.env.SZ_PERF_CAMERA ?? '';
const task = await taskSpace(process.env.SZ_PERF_TASK ?? 'slop-shenzhen-round2');
const page = task.page(process.env.SZ_PERF_PAGE ?? 'p1');
await page.cdp('Network.enable');
await page.cdp('Network.setCacheDisabled', { cacheDisabled: true });
await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await page.goto(url);
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => typeof window.__szQA === 'function').catch(() => false)) break;
}
await page.waitForTimeout(3000);
if (camera) {
  await page.evaluate(id => document.getElementById(id)?.click(), camera);
  await page.waitForTimeout(2500);
}
await page.evaluate(() => {
  window.__szPerf = { samples: [] };
  let last = 0;
  const tick = at => { if (last) window.__szPerf.samples.push(at - last); last = at;
    if (window.__szPerf.samples.length < 20000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(seconds * 1000);
const result = await page.evaluate(() => {
  const samples = window.__szPerf.samples.slice(2).sort((a, b) => a - b);
  const pick = q => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const query = window.__szQA();
  return {
    frames: samples.length,
    meanMs: Math.round(mean * 100) / 100,
    p50Ms: Math.round(pick(0.5) * 100) / 100,
    p95Ms: Math.round(pick(0.95) * 100) / 100,
    maxMs: Math.round(samples[samples.length - 1] * 100) / 100,
    fpsMean: Math.round(1000 / mean * 10) / 10,
    fpsP50: Math.round(1000 / pick(0.5) * 10) / 10,
    fpsP95: Math.round(1000 / pick(0.95) * 10) / 10,
    drawCalls: query.renderer.render.drawCalls,
    triangles: query.renderer.render.triangles,
    cssViewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    camera: query.camera.id
  };
});
result.seconds = seconds;
result.renderSize = [width, height];
await page.cdp('Emulation.clearDeviceMetricsOverride');
console.log(JSON.stringify(result, null, 1));
