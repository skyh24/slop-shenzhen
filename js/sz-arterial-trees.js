const ARTERIALS = new Set(['北环大道', '深南大道', '滨海大道']);

export function createArterialTreeFilter(nearRoads, medianAt = () => false) {
  return (x, z, source) => {
    if (medianAt(x, z)) return false;
    const nearby = nearRoads(x, z, 65);
    const main = nearby.find(({ road }) => ARTERIALS.has(road.name) && !road.highway.endsWith('_link')
      && !road.bridge && !road.tunnel && !road.layer && road.dir === 1);
    if (!main) return true;
    const side = hit => Math.sign((x - hit.x) * Math.cos(main.heading) - (z - hit.z) * Math.sin(main.heading));
    const aligned = hit => Math.cos(hit.heading - main.heading);
    const otherSide = hit => side(hit) * side(main) < 0;
    const frontage = nearby.filter(hit => hit.road.name === `${main.road.name}辅路`
      && !hit.road.bridge && !hit.road.tunnel && !hit.road.layer && Math.abs(aligned(hit)) > 0.9);
    // 中央及主辅路之间保持通透。滨水和公园独立树群只在落进这两类带状空间时避让。
    if (nearby.some(hit => hit.road.name === main.road.name && hit.road.dir === 1
      && !hit.road.bridge && !hit.road.tunnel && !hit.road.layer && !hit.road.highway.endsWith('_link')
      && aligned(hit) < -0.9 && otherSide(hit))) return false;
    if (frontage.some(otherSide)) return false;
    if (source !== 'simulated-street') return true;
    // 旧树包没有来源边，按原偏距识别主线生成的树点。独立道路及辅道外侧照常参与净空检查。
    const atTreeOffset = hit => Math.abs(hit.distance - hit.road.w / 2 - 2.5) < 1.1;
    return !atTreeOffset(main) || frontage.some(atTreeOffset);
  };
}
