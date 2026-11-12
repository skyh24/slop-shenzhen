// 本机离线审核，与浏览器使用相同的载荷校验和立交范围。
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeCityPayload } from '../../js/sz-data-format.js';

const three = process.env.SZ_THREE_PACKAGE_DIR
  ? pathToFileURL(resolve(process.env.SZ_THREE_PACKAGE_DIR) + '/')
  : new URL('../../.agents/three-0.187.0/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', three), 'utf8'));
if (pkg.version !== '0.187.0') throw new Error('Tunnel audit requires Three.js 0.187.0');
const aliases = { three: 'build/three.webgpu.js', 'three/webgpu': 'build/three.webgpu.js',
  'three/tsl': 'build/three.tsl.js' };
const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(Object.hasOwn(aliases, specifier) ? new URL(aliases[specifier], three).href : specifier, context);
  }
});
let planSzTunnels;
try {
  ({ planSzTunnels } = await import('./sz-tunnels.js'));
} finally {
  hook.deregister();
}
const bytes = await readFile(new URL('../../js/sz-city.json.gz', import.meta.url));
const { geo, buildings } = decodeCityPayload(JSON.parse(gunzipSync(bytes)));
const { reviewList, statistics } = planSzTunnels(geo.roadGraph, geo.terrainSurface, { buildings });
console.log(JSON.stringify({ statistics, reviewList }, null, 2));
