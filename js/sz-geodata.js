import { readCityPayload, decodeCityPayload } from './sz-data-format.js';

// 正式版与预览共用一次加载，后续模块不得各自请求不同城市快照。
export const CITY_PAYLOAD = await readCityPayload(new URL('./sz-city.json.gz', import.meta.url));
const decoded = decodeCityPayload(CITY_PAYLOAD);
export const GEO = decoded.geo;
export const REAL_BUILDINGS = decoded.buildings;
