import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, clamp, color, distance, float, floor, fract, fwidth, length, max, mrt, positionWorld, smoothstep, vec2, vec4 } from 'three/tsl';

let roadSurfaceMaterial = null;
let roadPaintMaterial = null;

// 地面和沥青共面，深度偏移避免闪烁，标高仍以原三角面为准。
export function createSzRoadSurfaceMaterial(frontageLight = null) {
  if (!frontageLight && roadSurfaceMaterial) return roadSurfaceMaterial;
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x3b3d41, roughness: 0.95, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  });
  if (frontageLight) {
    const { x, z, night } = frontageLight;
    const reach = smoothstep(13, 62, distance(positionWorld.xz, vec2(x, z))).oneMinus();
    material.emissiveNode = color(0x747782).mul(night).mul(reach).mul(0.13);
  } else {
    roadSurfaceMaterial = material;
  }
  return material;
}

const transparentPaintMRT = mrt({
  normal: vec4(0, 0, 0, 0),
  metalRough: vec4(0, 0, 0, 0)
});

// 保留按沿线米数的虚线过滤；黄白颜色由标线几何给出。
export function createSzRoadPaintMaterial() {
  if (roadPaintMaterial) return roadPaintMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, transparent: true, depthWrite: false, metalness: 0, roughness: 0.85,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  mat.mrtNode = transparentPaintMRT;
  const paint = attribute('paint', 'vec3');
  const t = paint.x.div(paint.y), footprint = max(fwidth(t), 0.0001), duty = paint.z;
  const onSoFar = x => floor(x).mul(duty).add(clamp(fract(x).sub(float(1).sub(duty).mul(0.5)), 0, duty));
  const dashes = onSoFar(t.add(footprint.mul(0.5))).sub(onSoFar(t.sub(footprint.mul(0.5)))).div(footprint);
  mat.opacityNode = dashes.mul(smoothstep(1650, 1300, length(positionWorld.sub(cameraPosition))));
  roadPaintMaterial = mat;
  return mat;
}
