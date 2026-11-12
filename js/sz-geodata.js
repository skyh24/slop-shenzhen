import { readCityPayload, decodeCityPayload } from './sz-data-format.js';

// 正式版与预览共用一次加载，后续模块不得各自请求不同城市快照。
// 快读包先在本机 QA 对照；来源真实性审核未完成，不自动迁移正式默认包。
const cityFormat = globalThis.__szBoot?.cityFormat === 'szc' ? 'szc' : 'json';
const CITY_URL = new URL(`./sz-city.${cityFormat}.gz`, import.meta.url);

// 失败阶段映射成启动页兜底入口认识的四个种类之一，界面文字由 sz-strings.js 集中提供。
function bootKind(error) {
  if (error?.code === 'request') return 'dataRequest';
  if (error?.code === 'decompress') return 'dataDecompress';
  return 'dataInvalid';
}

// 计时字段固定五个，缺省填 0，[init] 日志按同一组标签打印。
function pickTimings(metrics = {}) {
  const value = key => (Number.isFinite(metrics[key]) ? metrics[key] : 0);
  return {
    downloadMs: value('downloadMs'),
    decompressMs: value('decompressMs'),
    parseMs: value('parseMs'),
    validateMs: value('validateMs'),
    decodeMs: value('decodeMs')
  };
}

// 城市包在主模块求值之前加载。失败时交给启动页兜底入口（window.__szBoot）显示原因并等待页内重试；
// 主模块此时尚未求值，重试不会重复创建画布或动画循环。
async function loadCityData(url) {
  const boot = globalThis.__szBoot;
  let pendingRetry = null;
  boot?.setRetryHandler?.(() => {
    const resolve = pendingRetry;
    pendingRetry = null;
    resolve?.();
  });
  let retry = false;
  for (;;) {
    const metrics = {};
    // 先建等待器再报告失败，避免玩家在 fail() 返回之前点击重试导致点击丢失。
    let resolveRetry;
    const retried = new Promise(resolve => { resolveRetry = resolve; });
    pendingRetry = resolveRetry;
    try {
      // 缓存中的坏响应不能再次喂给重试；仍从同一个不可变版本取包。
      const fetcher = retry ? input => fetch(input, { cache: 'reload' }) : fetch;
      const raw = await readCityPayload(url, fetcher, metrics);
      const decoded = decodeCityPayload(raw, metrics);
      pendingRetry = null;
      boot?.clear?.();
      return { raw, decoded, timings: pickTimings(metrics) };
    } catch (error) {
      const wait = boot?.fail?.(bootKind(error), error);
      // 没有兜底入口（Node 测试、其他嵌入方）时保持原行为：模块求值直接失败。
      if (!wait || typeof wait.then !== 'function') {
        pendingRetry = null;
        throw error;
      }
      await retried;
      retry = true;
    }
  }
}

const data = await loadCityData(CITY_URL);
export const CITY_PAYLOAD = data.raw;
export const GEO = data.decoded.geo;
export const REAL_BUILDINGS = data.decoded.buildings;
// 毫秒：downloadMs、decompressMs、parseMs、validateMs、decodeMs。
export const DATA_TIMINGS = data.timings;
