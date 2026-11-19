// 会场草坪上的独立立体字。每个字的第一圈为外轮廓，后续圈为镂空。
import * as THREE from 'three/webgpu';

const outlines = {
  A: ['0,0 3.5,10 6,10 9.5,0 7,0 6.3,2.3 3.1,2.3 2.4,0', '3.7,4.2 5.7,4.2 4.7,7.7'],
  P: ['0,0 0,10 5.2,10 7.1,9.5 8.2,8.1 8.3,6 7.7,4.4 6.2,3.4 2.4,3.2 2.4,0',
    '2.4,5.3 5,5.3 5.9,5.9 6,7.1 5.5,7.8 4.9,8 2.4,8'],
  E: ['0,0 0,10 7.3,10 7.3,8 2.4,8 2.4,6 6.7,6 6.7,4 2.4,4 2.4,2 7.5,2 7.5,0'],
  C: ['8.4,8.4 6.7,9.8 4.6,10.2 2.3,9.7 0.8,8.1 0.1,6.2 0.1,3.8 0.8,1.9 2.4,0.4 4.6,-0.1 6.8,0.3 8.4,1.8 7,3.2 5.9,2.3 4.6,2 3.2,2.5 2.5,3.9 2.5,6.1 3.2,7.5 4.6,8.1 5.9,7.8 7,7'],
  H: ['0,0 0,10 2.4,10 2.4,6.1 6.2,6.1 6.2,10 8.6,10 8.6,0 6.2,0 6.2,4 2.4,4 2.4,0'],
  I: ['0,0 0,10 2.4,10 2.4,0'],
  N: ['0,0 0,10 2.4,10 6.4,4.1 6.4,10 8.7,10 8.7,0 6.4,0 2.3,6 2.3,0'],
  2: ['0,0 0,1.7 4.4,5.7 5.4,7 5.1,7.9 4.2,8.2 3,8 1.5,6.9 0.2,8.4 1.9,9.8 4.1,10.2 6,9.9 7.4,8.8 7.8,7.2 7.4,5.6 6.1,4.1 3.7,2 7.9,2 7.9,0'],
  0: ['2.2,0.4 0.7,2 0.1,4.1 0.1,6 0.7,8.1 2.2,9.7 4.2,10.2 6.2,9.7 7.6,8.1 8.2,6 8.2,4.1 7.6,2 6.2,0.4 4.2,-0.1',
    '3.2,2.4 4.2,2 5.2,2.4 5.8,4 5.8,6.1 5.2,7.8 4.2,8.2 3.2,7.8 2.5,6.1 2.5,4'],
  6: ['7.4,9.2 6.2,10 4.4,10.2 2.5,9.7 1,8.2 0.2,6 0.1,3.6 0.7,1.7 2.2,0.3 4.4,-0.1 6.5,0.4 7.9,1.8 8.2,3.8 7.6,5.5 6.3,6.6 4.6,6.9 2.5,6.3 3.1,7.8 4.5,8.3 5.8,8.1 6.5,7.7',
    '2.6,3.2 3.1,2.4 4.3,2 5.4,2.4 5.9,3.5 5.4,4.6 4.3,5 3.1,4.7 2.6,4']
};

export function createVenueLetters(text, width, height) {
  const shapes = [];
  let cursor = 0;
  for (const char of text) {
    if (char === ' ') { cursor += 3.6; continue; }
    const shape = new THREE.Shape();
    let right = 0;
    for (const [i, outline] of outlines[char].entries()) {
      const path = i ? new THREE.Path() : shape;
      for (const [j, pair] of outline.split(' ').entries()) {
        const [x, y] = pair.split(',').map(Number);
        if (j === 0) path.moveTo(cursor + x, y);
        else path.lineTo(cursor + x, y);
        right = Math.max(right, x);
      }
      path.closePath();
      if (i) shape.holes.push(path);
    }
    shapes.push(shape);
    cursor += right + 1;
  }
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: 1.2, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 1
  });
  const span = cursor - 1;
  geometry.translate(-span / 2, 0, 0);
  geometry.scale(width / span, height / 10, height / 10);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cyan = new THREE.Color(0x66c9e7), lime = new THREE.Color(0xc0e58a), tint = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(pos.getX(i) / width + 0.5, 0, 1);
    tint.lerpColors(cyan, lime, t).toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
