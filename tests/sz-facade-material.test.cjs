const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (file) => readFileSync(join(root, 'js', file), 'utf8');
const geometrySource = read('sz-geometry.js');
const materialsSource = read('sz-materials.js');
const facadeProfiles = loadModule(read('sz-facade-profiles.js'));
const cityLightingSource = read('city-lighting-materials.js');
const layout = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': {} } });

// --- sz-geometry：用最小 THREE 桩读回顶点缓冲，不需要浏览器或真实 three ---
const geometryThree = {
  Vector2: class { constructor(x, y) { this.x = x; this.y = y; } },
  ShapeUtils: { triangulateShape: (outer) => [[0, 1, 2], [0, 2, 3]].slice(0, Math.max(1, outer.length - 2)) },
  BufferAttribute: class { constructor(array, itemSize) { Object.assign(this, { array, itemSize }); } },
  BufferGeometry: class {
    attributes = {};
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    setIndex(index) { this.index = index; }
    computeBoundingSphere() {}
    computeBoundingBox() {}
  }
};
const loadGeometry = () => loadModule(geometrySource, { imports: { 'three/webgpu': geometryThree } });

// 顶点顺序：每面墙 4 个顶点 a0, b0, b1, a1；u 依次为 0、墙长、墙长、0。
const wallLengths = (builder, count) => {
  const pos = Array.from(builder.pos.view());
  const uv = Array.from(builder.uv.view());
  const meta = Array.from(builder.meta.view());
  const walls = [];
  for (let w = 0; w < count; w++) {
    const base = w * 4;
    const ax = pos[base * 3], az = pos[base * 3 + 2];
    const bx = pos[(base + 1) * 3], bz = pos[(base + 1) * 3 + 2];
    walls.push({
      length: Math.hypot(bx - ax, bz - az),
      u: [uv[base * 2], uv[(base + 1) * 2], uv[(base + 2) * 2], uv[(base + 3) * 2]],
      v: [uv[base * 2 + 1], uv[(base + 1) * 2 + 1], uv[(base + 2) * 2 + 1], uv[(base + 3) * 2 + 1]],
      meta: [0, 1, 2, 3].map((k) => meta.slice((base + k) * 4, (base + k) * 4 + 4))
    });
  }
  return walls;
};

test('addWalls restarts u on every wall and writes the wall length into meta.z', () => {
  const { GeoBuilder, addWalls } = loadGeometry();
  const outer = [0, 0, 10, 0, 10, 5, 0, 5];
  const hole = [2, 2, 8, 2, 8, 4, 2, 3];
  const meta = [4, 2.5, 0, 12];
  const builder = new GeoBuilder(true);
  addWalls(builder, [outer, hole], 3, 9, meta, 1);
  const walls = wallLengths(builder, 8);

  assert.equal(walls.length, 8);
  for (const wall of walls) {
    assert.ok(wall.length > 0);
    assert.equal(wall.u[0], 0, 'each wall starts at u = 0');
    assert.ok(Math.abs(wall.u[1] - wall.length) < 1e-6, 'u reaches the wall length at the far corner');
    assert.ok(Math.abs(wall.u[2] - wall.length) < 1e-6);
    assert.equal(wall.u[3], 0);
    for (const vertexMeta of wall.meta) {
      assert.equal(vertexMeta[0], 4);
      assert.equal(vertexMeta[1], 2.5);
      assert.ok(Math.abs(vertexMeta[2] - wall.length) < 1e-6, 'vertex meta.z is this wall length in metres');
      assert.equal(vertexMeta[3], 12, 'meta.w keeps the building height');
    }
    // v 语义不变：仍是离地高度（y - uvOriginY）。
    assert.deepEqual(wall.v, [2, 2, 8, 8]);
  }
  assert.deepEqual(meta, [4, 2.5, 0, 12], 'the caller meta array must not be mutated, the roof still shares it');
});

test('addWalls keeps the no-meta landmark path and addFlatPolygon keeps its meta and xz uv', () => {
  const { GeoBuilder, addWalls, addFlatPolygon } = loadGeometry();
  const outer = [0, 0, 10, 0, 10, 5, 0, 5];
  const landmark = new GeoBuilder();
  addWalls(landmark, [outer], 0, 5, null);
  assert.equal(landmark.meta, null, 'landmark parts build without a bmeta attribute');
  const uv = Array.from(landmark.uv.view());
  for (let wall = 0; wall < 4; wall++) {
    assert.equal(uv[wall * 8], 0);
    assert.equal(uv[wall * 8 + 6], 0);
  }

  const roof = new GeoBuilder(true);
  const meta = [4, 2.5, 0, 12];
  addFlatPolygon(roof, [outer], 9, meta);
  const roofUv = Array.from(roof.uv.view());
  const roofMeta = Array.from(roof.meta.view());
  assert.deepEqual([roofUv[0], roofUv[1], roofUv[2], roofUv[3]], [0, 0, 10, 0]);
  for (let vertex = 0; vertex < 4; vertex++) {
    const offset = vertex * 4;
    assert.deepEqual(Array.from(roofMeta.slice(offset, offset + 4)), meta, 'roof vertices keep the caller meta unchanged');
  }
});

test('FACADE_PROFILES follows the data pipeline facade order and carries the shared facade parameters', () => {
  const pipeline = readFileSync(join(root, 'tools/sz/buildings.py'), 'utf8');
  const declaration = /FACADES\s*=\s*\[([^\]]+)\]/.exec(pipeline);
  assert.ok(declaration, 'tools/sz/buildings.py must declare FACADES');
  const pipelineFacades = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);

  const profiles = facadeProfiles.FACADE_PROFILES;
  assert.deepEqual(Array.from(profiles.slice(0, pipelineFacades.length), profile => profile.name), pipelineFacades);
  assert.equal(facadeProfiles.facadeProfile(null).name, 'unknown');
  assert.equal(facadeProfiles.facadeProfile(undefined).name, 'unknown');
  assert.throws(() => facadeProfiles.facadeProfile('new-invalid-facade'), /Unknown building facade/);

  for (const profile of profiles) {
    for (const field of ['bayWidth', 'floorHeight', 'winRatioW', 'winRatioH', 'glazing', 'warmth']) {
      assert.ok(Number.isFinite(profile[field]), `${profile.name}.${field} must be a finite number`);
    }
    assert.ok(profile.bayWidth >= 0.6 && profile.bayWidth <= 12, `${profile.name}.bayWidth`);
    assert.ok(profile.floorHeight >= 2 && profile.floorHeight <= 12, `${profile.name}.floorHeight`);
    assert.ok(profile.winRatioW > 0 && profile.winRatioW <= 1, `${profile.name}.winRatioW`);
    assert.ok(profile.winRatioH > 0 && profile.winRatioH <= 1, `${profile.name}.winRatioH`);
    assert.ok(profile.glazing >= 0 && profile.glazing <= 1, `${profile.name}.glazing`);
    assert.ok(profile.warmth >= 0 && profile.warmth <= 1, `${profile.name}.warmth`);
    for (const field of ['wallA', 'trim']) {
      assert.ok(Number.isInteger(profile[field]) && profile[field] >= 0 && profile[field] <= 0xffffff, `${profile.name}.${field}`);
    }
  }
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('building material builds one MeshStandardNodeMaterial with day/night nodes',
  { skip: !threeDir }, async () => {
    const loadThree = (file) => import(pathToFileURL(join(threeDir, 'build', file)));
    const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
    assert.match(materialsSource, /import \{ cityUniforms \} from '\.\/city-lighting-materials\.js';/,
      'the facade reads the live city lighting uniforms instead of only sceneUniforms.night');
    assert.match(materialsSource, /uInteriorGlow/, 'window glow follows cityUniforms.uInteriorGlow');
    assert.match(materialsSource, /uSkyHorizonColor/, 'curtain-wall glass reflects the sky horizon colour');
    const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
    // 和 tests/sz-road-material.test.cjs 一样加载真实模块：城市 uniform 必须是真实 TSL uniform 节点。
    const cityLighting = loadModule(cityLightingSource, { imports });
    const materials = loadModule(materialsSource, { imports: { ...imports, './city-lighting-materials.js': cityLighting, './sz-facade-profiles.js': facadeProfiles } });
    const material = materials.createBuildingMaterial();
    assert.ok(material instanceof THREE.MeshStandardNodeMaterial);
    for (const node of ['colorNode', 'roughnessNode', 'metalnessNode', 'emissiveNode']) {
      assert.ok(material[node], `${node} must be assigned`);
    }
    // Dawn/Naga 冷编译对 TSL 图规模很敏感：这里直接守住节点数预算，防止再退回一次 50s 冷启动。
    const countNodes = (roots) => {
      const seen = new Set();
      const stack = [...roots];
      while (stack.length) {
        const node = stack.pop();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        for (const child of node.getChildren ? node.getChildren() : []) stack.push(child);
      }
      return seen.size;
    };
    const colorNodes = countNodes([material.colorNode]);
    assert.ok(colorNodes <= 600, `colorNode must stay within 600 nodes for a 5s cold compile (got ${colorNodes})`);
    const totalNodes = countNodes([material.colorNode, material.roughnessNode, material.metalnessNode, material.emissiveNode]);
    assert.ok(totalNodes <= 700, `combined building material graph must stay within 700 nodes (got ${totalNodes})`);
  });

// --- 最小 TSL 数值求值器：把生产着色器表达式在 CPU 上算成像素值，用来验证开间、
// 墙角留白、楼层和夜灯确定性；不依赖浏览器、GPU 或真实 three。 ---
function createFacadeEvaluator() {
  let epoch = 0;
  const bump = () => { epoch++; };
  class Node {
    constructor(compute) { this.compute = compute; this.e = -1; this.cache = null; this.children = []; }
    get values() {
      if (this.e !== epoch) { this.cache = this.compute(); this.e = epoch; }
      return this.cache;
    }
    comp(index) { return this.children[index] || (this.children[index] = new Node(() => [this.values[index] ?? 0])); }
    get x() { return this.comp(0); } get y() { return this.comp(1); }
    get z() { return this.comp(2); } get w() { return this.comp(3); }
    add(value) { return binary(this, value, (a, b) => a + b); }
    sub(value) { return binary(this, value, (a, b) => a - b); }
    mul(value) { return binary(this, value, (a, b) => a * b); }
    div(value) { return binary(this, value, (a, b) => b === 0 ? 0 : a / b); }
    toVar() { return this; }
  }
  class Input extends Node { constructor(values) { super(null); this.current = values; } get values() { return this.current; } }
  const values = (value) => value instanceof Node ? value.values : Array.isArray(value) ? value : [value];
  const binary = (a, b, operation) => new Node(() => {
    const A = values(a), B = values(b), length = Math.max(A.length, B.length);
    return Array.from({ length }, (_, i) => operation(A[i % A.length], B[i % B.length]));
  });
  const ternary = (a, b, c, operation) => new Node(() => {
    const A = values(a), B = values(b), C = values(c), length = Math.max(A.length, B.length, C.length);
    return Array.from({ length }, (_, i) => operation(A[i % A.length], B[i % B.length], C[i % C.length]));
  });
  const unary = (operation) => (value) => new Node(() => values(value).map(operation));
  const vector = (args, size) => new Node(() => {
    if (args.length === 1) {
      const single = values(args[0]);
      return single.length === size ? single : new Array(size).fill(single[0]);
    }
    return args.map((arg) => values(arg)[0]);
  });
  const uniforms = [];
  // 颜色 uniform 在真实 TSL 里是 vec3：CPU 求值时摊平成 rgb；数值 uniform（uInteriorGlow）保持单值。
  const uniformValues = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && 'r' in value) return [value.r, value.g, value.b];
    return [value];
  };
  const state = {
    meta: new Input([0, 0, 10, 30]),
    uv: new Input([0, 0]),
    normal: new Input([0, 0, 1]),
    position: new Input([0, 0, 0]),
    camera: new Input([0, 0, 10]),
    time: new Input([0]),
    pixel: new Input([0.0015])
  };
  const tsl = {
    Fn: (fn) => (...args) => fn(args),
    attribute: () => state.meta,
    uv: () => state.uv,
    vec2: (...args) => vector(args, 2),
    vec3: (...args) => vector(args, 3),
    vec4: (...args) => vector(args, 4),
    float: (value) => new Node(() => [Number(value)]),
    fract: unary((value) => value - Math.floor(value)),
    floor: unary(Math.floor),
    abs: unary(Math.abs),
    sin: unary(Math.sin),
    step: (edge, value) => binary(edge, value, (edgeValue, x) => x < edgeValue ? 0 : 1),
    smoothstep: (low, high, value) => ternary(low, high, value, (lowValue, highValue, x) => {
      const t = Math.min(1, Math.max(0, (x - lowValue) / (highValue - lowValue || Number.EPSILON)));
      return t * t * (3 - 2 * t);
    }),
    mix: (a, b, t) => ternary(a, b, t, (aValue, bValue, tValue) => aValue * (1 - tValue) + bValue * tValue),
    max: (a, b) => binary(a, b, Math.max),
    min: (a, b) => binary(a, b, Math.min),
    dot: (a, b) => new Node(() => {
      const A = values(a), B = values(b);
      let sum = 0;
      for (let i = 0; i < Math.max(A.length, B.length); i++) sum += A[i % A.length] * B[i % B.length];
      return [sum];
    }),
    color: (hex) => new Node(() => [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255]),
    uniform: (value) => {
      const node = new Node(() => uniformValues(node.value));
      node.value = value;
      uniforms.push(node);
      return node;
    },
    // 幕墙玻璃的菲涅尔反射用到的三个 TSL 基础算子。
    clamp: (value, low, high) => ternary(value, low, high,
      (component, lowValue, highValue) => Math.min(highValue, Math.max(lowValue, component))),
    pow: (base, exponent) => binary(base, exponent, Math.pow),
    normalize: (value) => new Node(() => {
      const vector = values(value);
      const length = Math.hypot(...vector) || 1;
      return vector.map((component) => component / length);
    }),
    fwidth: () => state.pixel,
    positionWorld: state.position,
    normalWorldGeometry: state.normal,
    cameraPosition: state.camera,
    time: state.time
  };
  class MeshStandardNodeMaterial { constructor(options = {}) { Object.assign(this, options); } }
  // city-lighting-materials.js 加载时会构造 Color/Vector3 类型的城市 uniform，这里给最小实现。
  class Color {
    constructor(hex) {
      this.r = (hex >> 16 & 255) / 255;
      this.g = (hex >> 8 & 255) / 255;
      this.b = (hex & 255) / 255;
    }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    normalize() {
      const length = Math.hypot(this.x, this.y, this.z) || 1;
      this.x /= length; this.y /= length; this.z /= length;
      return this;
    }
  }
  const three = { MeshStandardNodeMaterial, Color, Vector3 };
  const cityLighting = loadModule(cityLightingSource, { imports: { 'three/webgpu': three, 'three/tsl': tsl } });
  const materials = loadModule(materialsSource, {
    imports: { 'three/webgpu': three, 'three/tsl': tsl, './city-lighting-materials.js': cityLighting, './sz-facade-profiles.js': facadeProfiles }
  });
  return { materials, cityUniforms: cityLighting.cityUniforms, state, uniforms, bump };
}

test('the Houhai lobby affects only the named tower and its north wall', () => {
  const { materials, state, bump } = createFacadeEvaluator();
  const material = materials.createBuildingMaterial();
  for (const [id, profile] of Object.entries(facadeProfiles.FACADE_SAMPLE_PROFILES)) {
    assert.equal(profile.materialSeed, Math.fround(layout.buildingSeed(id) * 10));
  }
  const sampleSeed = Math.fround(layout.buildingSeed('way/737426464') * 10);
  const colorAt = (seed, normal, position, y) => {
    state.meta.current = [0, seed, 43, 232.1];
    state.uv.current = [13.5, y];
    state.normal.current = normal;
    state.position.current = position;
    state.camera.current = [position[0], position[1], position[2] + 10];
    bump();
    return Array.from(material.colorNode.values);
  };
  const north = [0, 0, -1];
  const south = [0, 0, 1];
  const tower = [-12085, 12, 2571];
  const outside = [-12115, 12, 2571];
  assert.notDeepEqual(colorAt(sampleSeed, north, tower, 12), colorAt(sampleSeed, north, outside, 12));
  assert.notDeepEqual(colorAt(sampleSeed, north, tower, 12), colorAt(sampleSeed + 0.01, north, tower, 12));
  assert.deepEqual(colorAt(sampleSeed, south, tower, 12), colorAt(sampleSeed, south, outside, 12));
});

const hexToRgb = (hex) => [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
const hash21 = (x, y) => {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
};
const wallLength = 30;
const buildingHeight = 60;
const seed = 3.5;
const tone = hash21(seed, seed * 1.7);
const expectedWallColor = (profile) => hexToRgb(profile.wallA).map((value) => value * (tone * 0.22 + 0.86) * (tone * 0.16 + 0.92));
const fittedBay = (profile) => {
  const margin = Math.min(profile.cornerMargin, wallLength * 0.18);
  const inner = wallLength - margin * 2;
  const bays = Math.max(Math.floor(inner / profile.bayWidth + 0.5), 1);
  return { margin, bayWidth: inner / bays };
};

test('facade shader fits whole window bays inside each wall, keeps corners solid and lights windows deterministically', () => {
  const evaluator = createFacadeEvaluator();
  const profiles = facadeProfiles.FACADE_PROFILES;
  const material = evaluator.materials.createBuildingMaterial();
  const colorAt = (fid, u, v) => {
    evaluator.state.meta.current = [fid, seed, wallLength, buildingHeight];
    evaluator.state.normal.current = [0, 0, 1];
    evaluator.state.uv.current = [u, v];
    evaluator.bump();
    return Array.from(material.colorNode.values);
  };
  // 窗中心：幕墙/办公取 0.3 避开中间竖挺，住宅取 0.3 落在宽窗内，小窗取 0.5。
  const windowOffset = [0.3, 0.3, 0.3, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5];
  const windowCellV = [0.5, 0.5, 0.5, 0.5, 0.5, 0.7, 0.5, 0.5, 0.5];
  profiles.forEach((profile, fid) => {
    const { margin, bayWidth } = fittedBay(profile);
    const midFloorV = profile.groundHeight + profile.floorHeight * (1 + 0.5);
    const corner = colorAt(fid, 0.01, midFloorV);
    const expected = expectedWallColor(profile);
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(corner[channel] - expected[channel]) < 2e-6,
        `${profile.name}: the wall corner must stay solid masonry, no half window (${corner[channel]} vs ${expected[channel]})`);
    }
    const windowU = margin + bayWidth * windowOffset[fid];
    const windowV = profile.groundHeight + profile.floorHeight * (1 + windowCellV[fid]);
    const windowColor = colorAt(fid, windowU, windowV);
    const difference = Math.max(...windowColor.map((value, i) => Math.abs(value - corner[i])));
    assert.ok(difference > 0.06, `${profile.name}: the window bay centre must differ from the solid wall`);
  });
});

test('distant facades converge to the average glazing ratio instead of solid walls', () => {
  const evaluator = createFacadeEvaluator();
  const profiles = facadeProfiles.FACADE_PROFILES;
  const material = evaluator.materials.createBuildingMaterial();
  const { state } = evaluator;
  const colorAt = (fid, u, v, pixel) => {
    state.meta.current = [fid, seed, wallLength, buildingHeight];
    state.normal.current = [0, 0, 1];
    state.uv.current = [u, v];
    state.pixel.current = [pixel];
    evaluator.bump();
    return Array.from(material.colorNode.values);
  };
  for (const fid of [0, 1]) {
    const profile = profiles[fid];
    const { margin, bayWidth } = fittedBay(profile);
    const u = margin + bayWidth * 0.3;
    const v = profile.groundHeight + profile.floorHeight * 1.5;
    const wall = expectedWallColor(profile);
    const near = colorAt(fid, u, v, 0.0015);
    const far = colorAt(fid, u, v, 2.0);
    for (const sample of [near, far]) {
      const difference = Math.max(...sample.map((value, i) => Math.abs(value - wall[i])));
      assert.ok(difference > 0.05, `${profile.name}: glazing average must survive the far LOD`);
    }
  }
});

// 各时段的 cityUniforms.uInteriorGlow（js/lighting.js TIME_PRESETS）和旧公式的 sceneUniforms.night。
// 旧窗灯亮度 = ... × night；测试用它换算“比旧行为亮多少”。
const GLOW = { golden: 0.48, midday: 0.24, twilight: 1.25, midnight: 1.55 };
const OLD_NIGHT = { golden: 0, midday: 0, twilight: 0.28, midnight: 0.86 };
// 生产公式 glowStrength 的解析式，和 js/sz-materials.js 的 smoothstep gate + 仿射项保持一致。
const glowStrength = (glow) => {
  const t = Math.min(Math.max((glow - 0.5) / (1.2 - 0.5), 0), 1);
  const gate = t * t * (3 - 2 * t);
  return gate * Math.min(glow * 0.9 - 0.28, 0.95);
};
const luminanceOf = (emissive) => 0.2126 * emissive[0] + 0.7152 * emissive[1] + 0.0722 * emissive[2];

const sampleEmissive = (evaluator, material, fid, u, v, glow) => {
  evaluator.cityUniforms.uInteriorGlow.value = glow;
  const { state } = evaluator;
  state.meta.current = [fid, seed, wallLength, buildingHeight];
  state.normal.current = [0, 0, 1];
  state.uv.current = [u, v];
  evaluator.bump();
  return Array.from(material.emissiveNode.values);
};

const brightestEmissive = (evaluator, material, fid, glow) => {
  const profile = facadeProfiles.FACADE_PROFILES[fid];
  const { margin, bayWidth } = fittedBay(profile);
  let best = null;
  for (let floor = 1; floor <= 6; floor++) {
    for (let cell = 0; cell < 8; cell++) {
      const emissive = sampleEmissive(evaluator, material, fid, margin + bayWidth * (cell + 0.3),
        profile.groundHeight + profile.floorHeight * (floor + 0.5), glow);
      const luminance = luminanceOf(emissive);
      if (!best || luminance > best.luminance) best = { luminance, emissive };
    }
  }
  return best;
};

test('twilight windows glow from uInteriorGlow and stay stable per suite across frames', () => {
  const evaluator = createFacadeEvaluator();
  const profiles = facadeProfiles.FACADE_PROFILES;
  const material = evaluator.materials.createBuildingMaterial();
  const { state } = evaluator;
  const profile = profiles[2];
  const { margin, bayWidth } = fittedBay(profile);
  const windowU = margin + bayWidth * 0.15;
  const windowV = profile.groundHeight + profile.floorHeight * 2.5;
  for (const glow of [GLOW.midday, GLOW.golden]) {
    const day = sampleEmissive(evaluator, material, 2, windowU, windowV, glow);
    assert.ok(day.every((value) => value === 0), `daytime windows must not emit (glow ${glow})`);
  }
  const twilight = sampleEmissive(evaluator, material, 2, windowU, windowV, GLOW.twilight);
  assert.ok(twilight.some((value) => value > 0.01), 'twilight windows light up');
  state.time.current = [7.5];
  const laterFrame = sampleEmissive(evaluator, material, 2, windowU, windowV, GLOW.twilight);
  assert.deepEqual(laterFrame, twilight, 'window occupancy must be seeded per suite, not re-randomised per frame');
  const ground = sampleEmissive(evaluator, material, 2, wallLength * 0.5, 1.2, GLOW.twilight);
  assert.ok(ground.some((value) => value > 0.01), 'residential entrances keep a warm twilight light');
});

test('twilight glow is clearly brighter than the old night formula while midnight stays controlled', () => {
  const evaluator = createFacadeEvaluator();
  const material = evaluator.materials.createBuildingMaterial();
  const golden = brightestEmissive(evaluator, material, 2, GLOW.golden);
  const midday = brightestEmissive(evaluator, material, 2, GLOW.midday);
  const twilight = brightestEmissive(evaluator, material, 2, GLOW.twilight);
  const midnight = brightestEmissive(evaluator, material, 2, GLOW.midnight);
  // 白天 gate 为 0，乘法会留下 IEEE -0，所以用 === 0 而不是 Object.is 严格比较。
  assert.ok(golden.luminance === 0, 'golden hour keeps windows off');
  assert.ok(midday.luminance === 0, 'midday keeps windows off');
  assert.ok(twilight.luminance > 0.01, 'twilight lights windows');
  // 用新 gate 反推旧公式的亮度：旧公式黄昏只乘 night = 0.28、午夜 0.86。
  const baseLuminance = twilight.luminance / glowStrength(GLOW.twilight);
  const oldTwilight = baseLuminance * OLD_NIGHT.twilight;
  const oldMidnight = baseLuminance * OLD_NIGHT.midnight;
  assert.ok(twilight.luminance >= 1.5 * oldTwilight,
    `twilight must be clearly brighter than the old night factor (got ${(twilight.luminance / oldTwilight).toFixed(2)}x)`);
  assert.ok(twilight.luminance >= 2 * midday.luminance, 'twilight stays clearly above the daylight baseline');
  assert.ok(midnight.luminance >= oldMidnight, 'midnight is not dimmer than before');
  assert.ok(midnight.luminance <= twilight.luminance * 1.5, 'midnight must not blow out against twilight');
});

test('night window light follows building use: office stays cool, housing turns warm', () => {
  const evaluator = createFacadeEvaluator();
  const material = evaluator.materials.createBuildingMaterial();
  const office = brightestEmissive(evaluator, material, 1, GLOW.twilight);
  const housing = brightestEmissive(evaluator, material, 2, GLOW.twilight);
  assert.ok(office.luminance > 0.01, 'office suites must light up at twilight');
  assert.ok(housing.luminance > 0.01, 'housing suites must light up at twilight');
  assert.ok(office.emissive[2] >= office.emissive[0], 'office night light stays cool white (blue >= red)');
  assert.ok(housing.emissive[0] > housing.emissive[2], 'housing night light turns warm (red > blue)');
});

test('curtain-wall panes reach reference metalness and low roughness while solid masonry stays low', () => {
  const evaluator = createFacadeEvaluator();
  const material = evaluator.materials.createBuildingMaterial();
  const { state } = evaluator;
  const at = (fid, u, v) => {
    state.meta.current = [fid, seed, wallLength, buildingHeight];
    state.normal.current = [0, 0, 1];
    state.uv.current = [u, v];
    evaluator.bump();
    return { metalness: material.metalnessNode.values[0], roughness: material.roughnessNode.values[0] };
  };
  const glassTower = facadeProfiles.FACADE_PROFILES[0];
  const { margin, bayWidth } = fittedBay(glassTower);
  const midFloorV = glassTower.groundHeight + glassTower.floorHeight * 2.5;
  const pane = at(0, margin + bayWidth * 0.3, midFloorV);
  assert.ok(pane.metalness >= 0.6, `full-glazing curtain wall reaches reference metalness (got ${pane.metalness})`);
  assert.ok(pane.roughness <= 0.12, `pane roughness approaches the reference glass (got ${pane.roughness})`);
  const solid = at(0, 0.01, midFloorV);
  assert.ok(solid.metalness <= 0.1, `solid masonry stays non-metallic (got ${solid.metalness})`);
  assert.ok(solid.roughness >= 0.6, `solid masonry stays rough (got ${solid.roughness})`);
  // 普通开窗玻璃不跟着变镜面：住宅塔楼窗心金属度仍是旧的 0.5 × glazing。
  const housing = facadeProfiles.FACADE_PROFILES[2];
  const housingBay = fittedBay(housing);
  const punched = at(2, housingBay.margin + housingBay.bayWidth * 0.15,
    housing.groundHeight + housing.floorHeight * 2.5);
  assert.ok(punched.metalness < 0.2, `punched housing windows keep the old metalness (got ${punched.metalness})`);
  // 窗台积灰只加在幕墙上：普通开窗玻璃的粗糙度仍是旧的 mix(0.42, 0.12, glazing) = 0.336。
  assert.ok(punched.roughness >= 0.3 && punched.roughness <= 0.35,
    `punched housing windows keep the old roughness (got ${punched.roughness})`);
});
