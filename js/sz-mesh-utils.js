// three.js 网格与贴图工具：依赖 three.js，浏览器运行时使用；node 单元测试用真实 0.187.0 加载。
// 站点、地铁出入口和 APEC 城市元素共用同一份部件合并与 canvas 贴图实现。
import * as THREE from 'three/webgpu';

// 合并多个部件几何。部件形如 { geometry, colour }，colour 缺省白色；
// 合并结果只保留位置、法线、UV、顶点色和索引，与原实现一致。
// 每个部件合并后立即 dispose 临时几何；索引类型按 65535 顶点上限在 Uint16Array / Uint32Array 中选。
export function mergeParts(parts) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    const position = part.geometry.getAttribute('position');
    vertexCount += position.count;
    indexCount += part.geometry.index ? part.geometry.index.count : position.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colours = new Float32Array(vertexCount * 3);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const colour = new THREE.Color();
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    const geometry = part.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const index = geometry.index;
    positions.set(position.array, vertexOffset * 3);
    if (normal) normals.set(normal.array, vertexOffset * 3);
    if (uv) uvs.set(uv.array, vertexOffset * 2);
    colour.setHex(part.colour ?? 0xffffff).convertSRGBToLinear();
    for (let i = 0; i < position.count; i++) {
      colours[(vertexOffset + i) * 3] = colour.r;
      colours[(vertexOffset + i) * 3 + 1] = colour.g;
      colours[(vertexOffset + i) * 3 + 2] = colour.b;
    }
    if (index) {
      for (let i = 0; i < index.count; i++) indices[indexOffset + i] = index.array[i] + vertexOffset;
      indexOffset += index.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexOffset + i] = i + vertexOffset;
      indexOffset += position.count;
    }
    vertexOffset += position.count;
    geometry.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// 运行时用 canvas 2D 现画贴图，不加载外部图片；颜色空间固定 sRGB。
// node 测试和没有 DOM 的降级环境退回 1×1 纯色 DataTexture：fallback 是 RGBA 四元组，
// 各模块保留自己的兜底色（例如 APEC 大屏用中国红），构建和销毁仍然可用。
// repeatX 为真时贴图在 S 方向平铺：围挡文字按分段长度重复采样，UV.x 会超过 1。
export function canvasTexture(width, height, draw, { fallback = [255, 255, 255, 255], repeatX = false } = {}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    const texture = new THREE.DataTexture(new Uint8Array(fallback), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeatX) texture.wrapS = THREE.RepeatWrapping;
  return texture;
}
