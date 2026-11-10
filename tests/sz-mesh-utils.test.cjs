const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');

// 这些用例需要真实 three 0.187.0；未指定 SZ_THREE_PACKAGE_DIR 时干净跳过。
const source = readFileSync(join(__dirname, '../js/sz-mesh-utils.js'), 'utf8');
const threeDir = process.env.SZ_THREE_PACKAGE_DIR;

test('mergeParts joins indexed boxes and bakes per-part vertex colours', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const { mergeParts } = loadModule(source, { imports: { 'three/webgpu': THREE } });
  const red = new THREE.BoxGeometry(1, 2, 3);
  const green = new THREE.BoxGeometry(2, 1, 1);
  const disposed = [];
  red.addEventListener('dispose', () => disposed.push('red'));
  green.addEventListener('dispose', () => disposed.push('green'));
  const redVertices = red.getAttribute('position').count;
  const greenVertices = green.getAttribute('position').count;
  const merged = mergeParts([{ geometry: red, colour: 0xff0000 }, { geometry: green }]);
  assert.equal(merged.getAttribute('position').count, redVertices + greenVertices);
  assert.equal(merged.getAttribute('normal').count, redVertices + greenVertices);
  assert.equal(merged.getAttribute('uv').count, redVertices + greenVertices);
  assert.equal(merged.getAttribute('color').count, redVertices + greenVertices);
  assert.equal(merged.index.count, red.index.count + green.index.count);
  assert.equal(merged.index.array.BYTES_PER_ELEMENT, 2, 'Uint16 index');
  assert.deepEqual(disposed, ['red', 'green'], 'temporary part geometries are disposed after merging');
  const expectedRed = new THREE.Color(0xff0000).convertSRGBToLinear();
  assert.ok(Math.abs(merged.getAttribute('color').getX(0) - expectedRed.r) < 1e-6);
  assert.equal(merged.getAttribute('color').getY(0), expectedRed.g);
  assert.equal(merged.getAttribute('color').getZ(0), expectedRed.b);
  assert.equal(merged.getAttribute('color').getX(redVertices), 1, 'missing colour falls back to white');
  assert.equal(merged.getAttribute('color').getY(redVertices), 1);
  assert.equal(merged.getAttribute('color').getZ(redVertices), 1);
  assert.ok(merged.boundingSphere && Number.isFinite(merged.boundingSphere.radius));
});

test('mergeParts indexes unindexed parts and widens the index buffer past 65535 vertices',
  { skip: !threeDir }, async () => {
    const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
    const { mergeParts } = loadModule(source, { imports: { 'three/webgpu': THREE } });
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mixed = mergeParts([{ geometry: box, colour: 0xffffff }, { geometry: triangle, colour: 0x0000ff }]);
    assert.equal(mixed.index.count, box.index.count + 3);
    assert.equal(mixed.getAttribute('position').count, box.getAttribute('position').count + 3);

    // 非索引部件只提供位置属性时，法线和 UV 用 0 补齐。
    const positions = new Float32Array(70000 * 3);
    const big = new THREE.BufferGeometry();
    big.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const widened = mergeParts([{ geometry: big }]);
    assert.equal(widened.getAttribute('position').count, 70000);
    assert.equal(widened.index.array.BYTES_PER_ELEMENT, 4, 'Uint32 index past 65535 vertices');
  });

test('canvasTexture falls back to a 1x1 colour texture without a DOM', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const { canvasTexture } = loadModule(source, { imports: { 'three/webgpu': THREE } });
  assert.equal(typeof document, 'undefined', 'node has no canvas');
  const plain = canvasTexture(64, 32, () => {});
  assert.ok(plain.isDataTexture);
  assert.equal(plain.image.width, 1);
  assert.equal(plain.image.height, 1);
  assert.equal(plain.colorSpace, THREE.SRGBColorSpace);
  assert.ok(plain.version > 0, 'DataTexture upload is scheduled');
  assert.deepEqual([...plain.image.data], [255, 255, 255, 255]);
  const apec = canvasTexture(1024, 512, () => {}, { fallback: [200, 16, 46, 255] });
  assert.deepEqual([...apec.image.data], [200, 16, 46, 255]);
});

test('canvasTexture repeats on S only when repeatX is requested', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const { canvasTexture } = loadModule(source, { imports: { 'three/webgpu': THREE },
    globals: { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) } } });
  const clamped = canvasTexture(64, 32, () => {});
  assert.equal(clamped.wrapS, THREE.ClampToEdgeWrapping);
  const repeated = canvasTexture(64, 32, () => {}, { repeatX: true });
  assert.equal(repeated.wrapS, THREE.RepeatWrapping);
  assert.equal(repeated.anisotropy, 4);
  assert.equal(repeated.colorSpace, THREE.SRGBColorSpace);
});
