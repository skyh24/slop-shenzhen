// 只检查包内已裁去车道、建筑和绿地的楼前候选。跨渲染分块仍按同一条世界坐标边连通。
function frontagePatches(meshes) {
  const faces = [], edges = new Map();
  for (const { geometry } of meshes) {
    const { position, paved } = geometry.attributes;
    if (!paved.array.includes(2)) continue;
    const keys = new Map();
    function key(i) {
      if (!keys.has(i)) {
        const xyz = [position.getX(i), position.getY(i), position.getZ(i)];
        keys.set(i, xyz.map(v => Math.round(v * 1000)).join('/'));
      }
      return keys.get(i);
    }
    const indices = geometry.index.array;
    for (let n = 0; n < indices.length; n += 3) {
      const a = indices[n], b = indices[n + 1], c = indices[n + 2];
      if (paved.getX(a) !== 2 || paved.getX(b) !== 2 || paved.getX(c) !== 2) continue;
      const face = { geometry, offset: n, vertices: [a, b, c], neighbors: [], boundary: [] };
      faces.push(face);
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const u = key(i), v = key(j);
        const edge = u < v ? u + ':' + v : v + ':' + u;
        const other = edges.get(edge);
        if (other) {
          face.neighbors.push(other.face);
          other.face.neighbors.push(face);
          edges.delete(edge);
        } else edges.set(edge, { i, j, face });
      }
    }
  }
  for (const { i, j, face } of edges.values()) face.boundary.push([face.geometry, i, j]);
  const patches = [];
  for (const face of faces) {
    if (face.visited) continue;
    const pending = [face], parts = new Map(), boundary = [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    while (pending.length) {
      const item = pending.pop();
      if (item.visited) continue;
      item.visited = true;
      const geo = item.geometry, p = geo.attributes.position;
      if (!parts.has(geo)) parts.set(geo, new Map());
      for (const [corner, i] of item.vertices.entries()) {
        const vertices = parts.get(geo);
        if (!vertices.has(i)) vertices.set(i, []);
        vertices.get(i).push(item.offset + corner);
        minX = Math.min(minX, p.getX(i)); maxX = Math.max(maxX, p.getX(i));
        minZ = Math.min(minZ, p.getZ(i)); maxZ = Math.max(maxZ, p.getZ(i));
      }
      boundary.push(...item.boundary);
      pending.push(...item.neighbors);
    }
    patches.push({ parts, boundary, minX, minZ, maxX, maxZ });
  }
  return patches;
}

// 两块前场可能只共用一个角。分开该角的渲染顶点，避免石铺颜色插值到隔壁地块。
function separateCorners(patches) {
  const batches = new Map();
  for (const { parts } of patches) {
    for (const [geo, vertices] of parts) {
      if (!batches.has(geo)) batches.set(geo, { seen: new Set(), copies: [] });
      const { seen, copies } = batches.get(geo);
      for (const [i, offsets] of [...vertices]) {
        if (seen.has(i)) {
          const index = geo.attributes.position.count + copies.length;
          copies.push({ i, offsets, index });
          vertices.delete(i);
          vertices.set(index, offsets);
        } else seen.add(i);
      }
    }
  }
  for (const [geo, { copies }] of batches) {
    if (!copies.length) continue;
    const indices = Array.from(geo.index.array);
    for (const { index, offsets } of copies) for (const offset of offsets) indices[offset] = index;
    geo.setIndex(indices);
    for (const [name, attr] of Object.entries(geo.attributes)) {
      const { array, itemSize } = attr;
      const expanded = new array.constructor(array.length + copies.length * itemSize);
      expanded.set(array);
      for (const { i, index } of copies) expanded.set(array.subarray(i * itemSize, (i + 1) * itemSize), index * itemSize);
      geo.setAttribute(name, new attr.constructor(expanded, itemSize, attr.normalized));
    }
  }
}

// 沿实际边界至少半米连续触及步道顶面。19 厘米容许同层人行道路缘的设计高差。
function touchesSidewalk(boundary, heightAt) {
  for (const [geometry, a, b] of boundary) {
    const p = geometry.attributes.position;
    const x = p.getX(a), y = p.getY(a), z = p.getZ(a);
    const dx = p.getX(b) - x, dy = p.getY(b) - y, dz = p.getZ(b) - z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) continue;
    const steps = Math.ceil(length / 0.4);
    let run = 0, previous = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, top = heightAt(x + t * dx, z + t * dz);
      const here = Number.isFinite(top) && Math.abs(top - (y + t * dy)) <= 0.19;
      run = here && previous ? run + length / steps : 0;
      if (run >= 0.5) return true;
      previous = here;
    }
  }
  return false;
}

export function createFrontageFinish(meshes, concrete, stone) {
  const pending = new Set(frontagePatches(meshes));
  separateCorners(pending);
  function finish(patch, connected) {
    const tint = connected ? stone : concrete;
    for (const [geometry, vertices] of patch.parts) {
      const { color, paved } = geometry.attributes;
      for (const i of vertices.keys()) {
        tint.toArray(color.array, i * 3);
        paved.setX(i, connected ? 2 : -1);
      }
      color.needsUpdate = true;
      paved.needsUpdate = true;
    }
  }
  for (const patch of pending) finish(patch, false);
  return (bounds, heightAt) => {
    for (const patch of pending) {
      if (patch.minX > bounds.maxX || patch.maxX < bounds.minX ||
          patch.minZ > bounds.maxZ || patch.maxZ < bounds.minZ) continue;
      if (!touchesSidewalk(patch.boundary, heightAt)) continue;
      finish(patch, true);
      pending.delete(patch);
    }
  };
}
