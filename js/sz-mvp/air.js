import * as THREE from 'three/webgpu';

export function createAir() {
  // 旧版虚构航线已撤除。来源证据未达到路径验收前，预览页也不生成自动飞行。
  const group = new THREE.Group();
  group.name = 'air';
  const routeLines = new THREE.Group();
  routeLines.name = 'droneRoutes';
  routeLines.visible = false;
  group.add(routeLines);
  return { group, routeLines, evtol: null, droneCount: 0, update() {} };
}
