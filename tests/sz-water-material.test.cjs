const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (name) => readFileSync(join(root, 'js', name), 'utf8');
const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
const loadThree = (file) => import(pathToFileURL(join(threeDir, 'build', file)));

// 入口接线：海面必须换用新的水面材质模块，并且模块图里的相对 import 都在 index.html 预载。
// 这两条同时守住：sz-sea 不再引用旧材质、新文件不会被入口漏掉。
test('sea surface uses the shared water material module and preloads it', () => {
  const sea = read('sz-sea.js');
  assert.match(sea, /import \{ createSzWaterMaterial \} from '\.\/sz-water-material\.js';/);
  assert.match(sea, /createSzWaterMaterial\(\{ coastal \}\)/);
  assert.doesNotMatch(sea, /createWaterMaterial/);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /<link rel="modulepreload" href="\.\/js\/sz-water-material\.js" \/>/);
});

// 波浪法线贴图必须确定性、带完整 mip 链：四层采样在贴图 mip 之间切换，闪烁和接缝就藏在这里。
test('water wave texture is a deterministic 256 px half-float mip chain', { skip: !threeDir }, async () => {
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = {
    'three/webgpu': THREE,
    'three/tsl': TSL,
    './city-lighting-materials.js': { cityUniforms: { uInteriorGlow: TSL.uniform(0.78) } }
  };
  const loadWater = () => loadModule(read('sz-water-material.js'), { imports });
  const first = loadWater().getWaterWaveTexture();
  const again = loadWater().getWaterWaveTexture();

  assert.ok(first instanceof THREE.DataTexture);
  assert.equal(first.image.width, 256);
  assert.equal(first.image.height, 256);
  assert.equal(first.type, THREE.HalfFloatType);
  assert.equal(first.wrapS, THREE.RepeatWrapping);
  assert.equal(first.wrapT, THREE.RepeatWrapping);
  assert.equal(first.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(first.magFilter, THREE.LinearFilter);
  assert.equal(first.generateMipmaps, false);
  assert.equal(first.anisotropy, 8);
  // 手工 mip 链：256 → 1 共 9 级，每级边长减半、每 texel 4 个 half。
  assert.equal(first.mipmaps.length, 9);
  first.mipmaps.forEach((level, i) => {
    const size = 256 >> i;
    assert.equal(level.width, size, `mip ${i} width`);
    assert.equal(level.height, size, `mip ${i} height`);
    assert.equal(level.data.length, size * size * 4, `mip ${i} texels`);
  });

  // 相同种子 + 确定性 FFT：fresh module 再生成一次必须逐字节相同（mip 0 抽查）。
  const reference = first.mipmaps[0].data;
  const repeat = again.mipmaps[0].data;
  assert.equal(repeat.length, reference.length);
  for (let i = 0; i < reference.length; i += 997) assert.equal(repeat[i], reference[i], `texel ${i} differs between loads`);
});

// 海面材质：五条通道都要是节点（不能退回常量色/常量金属度），两种变体各缓存一份。
test('water material builds day/night node channels for coast and inland variants', { skip: !threeDir }, async () => {
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = {
    'three/webgpu': THREE,
    'three/tsl': TSL,
    './city-lighting-materials.js': { cityUniforms: { uInteriorGlow: TSL.uniform(0.78) } }
  };
  const water = loadModule(read('sz-water-material.js'), { imports });
  const coast = water.createSzWaterMaterial({ coastal: true });
  const coastAgain = water.createSzWaterMaterial({ coastal: true });
  const inland = water.createSzWaterMaterial({ coastal: false });

  assert.ok(coast instanceof THREE.MeshStandardNodeMaterial);
  assert.equal(coast, coastAgain, 'the same variant must be cached, not rebuilt per build');
  assert.notEqual(coast, inland, 'inland lakes get their own material variant');
  for (const node of ['colorNode', 'normalNode', 'roughnessNode', 'metalnessNode', 'emissiveNode']) {
    assert.ok(coast[node], `coastal ${node} must be assigned`);
    assert.ok(inland[node], `inland ${node} must be assigned`);
  }
  assert.notEqual(coast.normalNode, undefined);
  // 菲涅尔走 metalness：旧材质 metalness 0.22 是常量，这里必须由节点驱动 SSR 反射。
  assert.ok(coast.metalnessNode, 'water metalness must come from the Fresnel node');
  assert.equal(coast.metalnessNode.isNode, true, 'metalnessNode is a TSL node');

  // 颜色与夜间反光都封装在 Fn 里一次求值；TSL 图构造时间必须稳定，避免再出现纽约注释里那种
  // 嵌套 mix 链把建图拖成指数级、页面卡死的情况（实测两种变体都是毫秒级）。
  assert.equal(coast.colorNode.isShaderCallNodeInternal, true);
  assert.equal(coast.emissiveNode.isShaderCallNodeInternal, true);
  const buildStartedAt = performance.now();
  const secondVariant = water.createSzWaterMaterial({ coastal: false });
  const buildMs = performance.now() - buildStartedAt;
  assert.equal(secondVariant, inland);
  assert.ok(buildMs < 500, `second water variant must build quickly, not stall the page (took ${buildMs.toFixed(1)} ms)`);
});

// 浏览器只在真正构建着色器时才执行 Fn 体，漏一个 three/tsl import 在 Node 测试里完全看不出来，
// 到 WebGPU 才抛 "x is not defined"。本轮真实踩过 hash2D 漏 import sin，所以用 three/tsl 的导出清单
// 做静态守卫：文件里调用的 TSL helper 必须在顶部 import 进来。
test('water shader calls only TSL helpers it imports', { skip: !threeDir }, async () => {
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  void THREE;
  const source = read('sz-water-material.js');
  const importBlock = /import \{([\s\S]*?)\} from 'three\/tsl';/.exec(source);
  assert.ok(importBlock, 'the module imports named helpers from three/tsl');
  const imported = new Set(importBlock[1].split(',').map((item) => item.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const helpers = new Set(Object.keys(TSL));
  const local = new Set([...source.matchAll(/(?:function\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
  const called = new Set([...source.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
  const missing = [...called].filter((name) => helpers.has(name) && !imported.has(name) && !local.has(name));
  assert.deepEqual(missing, [], 'three/tsl helpers called without an import: ' + missing.join(', '));
});
