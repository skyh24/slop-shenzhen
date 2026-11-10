import { readCityPayload, decodeCityPayload } from './sz-data-format.js';

// 正式版与预览共用一次加载，后续模块不得各自请求不同城市快照。
const CITY_URL = new URL('./sz-city.json.gz', import.meta.url);

// 失败阶段映射成启动页兜底入口认识的四个种类之一，界面文字由 sz-strings.js 集中提供。
function bootKind(error) {
  if (error?.code === 'request') return 'dataRequest';
  if (error?.code === 'decompress') return 'dataDecompress';
  return 'dataInvalid';
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
  for (;;) {
    // 先建等待器再报告失败，避免玩家在 fail() 返回之前点击重试导致点击丢失。
    let resolveRetry;
    const retried = new Promise(resolve => { resolveRetry = resolve; });
    pendingRetry = resolveRetry;
    try {
      const raw = await readCityPayload(url, fetch);
      const decoded = decodeCityPayload(raw);
      pendingRetry = null;
      boot?.clear?.();
      return { raw, decoded };
    } catch (error) {
      const wait = boot?.fail?.(bootKind(error), error);
      // 没有兜底入口（Node 测试、其他嵌入方）时保持原行为：模块求值直接失败。
      if (!wait || typeof wait.then !== 'function') {
        pendingRetry = null;
        throw error;
      }
      await retried;
    }
  }
}

const data = await loadCityData(CITY_URL);
export const CITY_PAYLOAD = data.raw;
export const GEO = data.decoded.geo;
export const REAL_BUILDINGS = data.decoded.buildings;
