import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 按生产 import map 解析依赖，调用实际沥青生成函数。全路网保留，以免样区边缘的路口缺失接臂。
const defaultThree = fileURLToPath(new URL('../../.agents/three-0.187.0', import.meta.url));
const three = resolve(process.env.SZ_THREE_PACKAGE_DIR ?? defaultThree);
if (JSON.parse(readFileSync(resolve(three, 'package.json'), 'utf8')).version !== '0.187.0') {
  throw new Error('The audit requires Three.js 0.187.0');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three/webgpu' || specifier === 'three/tsl') {
      const modulePath = resolve(three, 'build', `three.${specifier.split('/')[1]}.js`);
      return nextResolve(pathToFileURL(modulePath).href, context);
    }
    return nextResolve(specifier, context);
  }
});

// Node 需先注册解析钩子，再加载依赖浏览器 import map 的生产模块。
const { createRoadSurfaceLayout } = await import('../../js/sz-roads.js');
const { roadGraph, terrainSurface } = JSON.parse(readFileSync(0, 'utf8'));
const { chunks } = createRoadSurfaceLayout(roadGraph, terrainSurface);
process.stdout.write(JSON.stringify(chunks.map(({ origin, positions }) => ({ origin, positions: Array.from(positions) }))));
