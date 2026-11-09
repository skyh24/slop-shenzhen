import { CITY_PAYLOAD } from '../sz-geodata.js';
export { decodeRing, decodePoly } from '../sz-data-format.js';

export async function loadCityData() {
  return CITY_PAYLOAD;
}
