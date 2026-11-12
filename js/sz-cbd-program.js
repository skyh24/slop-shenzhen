import * as THREE from 'three/webgpu';
import { positionWorld, normalWorldGeometry, smoothstep, texture, uniform, vec2 } from 'three/tsl';
import { STR } from './sz-strings.js';

export const CBD_PROGRAM_SECONDS = 96;

export function cbdProgramPhase(seconds) {
  const time = ((seconds % CBD_PROGRAM_SECONDS) + CBD_PROGRAM_SECONDS) % CBD_PROGRAM_SECONDS;
  const cue = Math.floor(time / 24);
  const phase = (time % 24) / 24;
  return { cue, phase, fade: Math.min(1, phase * 12, (1 - phase) * 12) };
}

export function isCbdProgramTower(building) {
  return building.height >= 85 && building.cz > 80 && building.cz < 2450
    && Math.abs(building.cx) < 1250 && ['glass_tower', 'office', 'landmark'].includes(building.facade);
}

function paint(context, time) {
  const { cue, phase, fade } = cbdProgramPhase(time);
  const w = context.canvas.width, h = context.canvas.height;
  context.clearRect(0, 0, w, h);
  context.save();
  context.globalAlpha = fade;
  const gradient = context.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#f43c42');
  gradient.addColorStop(0.46, '#ffca35');
  gradient.addColorStop(0.69, '#fa61af');
  gradient.addColorStop(1, '#3b9bff');
  context.fillStyle = gradient;
  context.strokeStyle = gradient;
  if (cue === 0) {
    // 中轴视线有真实楼间留白，花形落在几栋较宽且可见的外立面。
    for (const [x, y, radius, tint] of [[72, 253, 14, '#58baff'], [165, 118, 12, '#69d8ff'],
      [615, 192, 16, '#ff5d85'], [707, 162, 15, '#ffb324']]) {
      context.save();
      context.translate(x, y);
      const bloom = Math.min(1, 0.28 + phase * 2.3);
      context.scale(bloom, bloom * 2.4);
      context.fillStyle = tint;
      for (let petal = 0; petal < 6; petal++) {
        context.rotate(Math.PI / 3);
        context.beginPath();
        context.ellipse(0, -radius * 0.59, radius * 0.27, radius * 0.43, 0, 0, 2 * Math.PI);
        context.fill();
      }
      context.fillStyle = '#fff0aa';
      context.beginPath();
      context.arc(0, 0, radius * 0.23, 0, 2 * Math.PI);
      context.fill();
      context.restore();
    }
  } else if (cue === 1) {
    for (const [x, lowest, rise, width] of [[165, 255, 148, 10], [617, 273, 104, 15], [708, 270, 119, 14]]) {
      const y = lowest - rise * phase;
      context.fillStyle = '#42b1ff';
      context.beginPath();
      context.moveTo(x, y - 41);
      context.quadraticCurveTo(x + width * 0.52, y - 23, x + width * 0.49, y + 9);
      context.lineTo(x + width, y + 25);
      context.lineTo(x + width * 0.31, y + 19);
      context.lineTo(x - width * 0.31, y + 19);
      context.lineTo(x - width, y + 25);
      context.lineTo(x - width * 0.49, y + 9);
      context.quadraticCurveTo(x - width * 0.52, y - 23, x, y - 41);
      context.fill();
      context.fillStyle = '#ffe588';
      context.beginPath();
      context.ellipse(x, y - 10, width * 0.22, 7, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#ff6544';
      context.beginPath();
      context.moveTo(x - width * 0.28, y + 25);
      context.quadraticCurveTo(x - width * 0.4, y + 43, x, y + 56 + 6 * Math.sin(phase * 16));
      context.quadraticCurveTo(x + width * 0.4, y + 43, x + width * 0.28, y + 25);
      context.fill();
    }
  } else if (cue === 2) {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '900 45px sans-serif';
    const letters = [['A', 510, 12], ['P', 553, 16], ['E', 617, 23], ['C', 708, 25]];
    letters.forEach(([letter, x, width], i) => {
      context.fillStyle = ['#ff554e', '#ffcd56', '#f889c0', '#6cc8ff'][i];
      context.fillText(letter, x, 263, width);
    });
    context.fillStyle = '#ffdb75';
    context.font = '900 26px sans-serif';
    context.fillText('APEC', 617, 149, 31);
    context.fillText('APEC', 708, 130, 31);
    context.fillText('APEC', 165, 111, 14);
  } else {
    context.lineWidth = 20;
    for (let i = 0; i < 6; i++) {
      context.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const y = 52 + i * 48 + Math.sin(x / 106 + phase * 2 * Math.PI + i * 0.57) * 39;
        if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
  }
  context.restore();
}

// 节目投影固定在观景点，纹理只进入真实楼体已有的窗光材质。
export function createCbdProgram(eye) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 384;
  const context = canvas.getContext('2d');
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  const enabled = uniform(0);
  const deltaX = positionWorld.x.sub(eye.x);
  const deltaZ = positionWorld.z.sub(eye.z);
  const depth = deltaZ.max(1);
  const u = deltaX.div(depth).add(0.037).negate().add(0.5);
  const v = positionWorld.y.sub(eye.y).div(depth).add(0.052).div(0.21);
  const inside = smoothstep(0, 0.025, u).mul(smoothstep(0, 0.025, u.oneMinus()))
    .mul(smoothstep(0, 0.025, v)).mul(smoothstep(0, 0.025, v.oneMinus()));
  const incidence = normalWorldGeometry.x.mul(deltaX).add(normalWorldGeometry.z.mul(deltaZ)).negate().div(depth);
  const texel = texture(atlas, vec2(u, v));
  const mask = texel.a.mul(inside).mul(smoothstep(0.08, 0.35, incidence)).mul(enabled);
  let time = 0, lastPaint = -1, playing = false, active = false;
  function update(dt, night) {
    if (active && playing && night > 0.25) time = (time + dt) % CBD_PROGRAM_SECONDS;
    const frame = Math.floor(time * 12);
    if (active && lastPaint !== frame) {
      paint(context, frame / 12);
      atlas.needsUpdate = true;
      lastPaint = frame;
    }
    enabled.value = active && night > 0.25 ? night : 0;
  }
  return {
    color: texel.rgb, mask, includes: isCbdProgramTower,
    update,
    start() { active = playing = true; time = 0; },
    stop() { active = playing = false; enabled.value = 0; },
    replay() { playing = true; time = 0; },
    togglePause() { playing = !playing; },
    get active() { return active; },
    get playing() { return playing; },
    get time() { return time; },
    dispose() { atlas.dispose(); }
  };
}

export function wireCbdProgram({ program, arrival, controller, camera, lighting, touchControls, gamepadControls,
  selectMode, selectCamera, selectTime }) {
  const controls = document.getElementById('show-controls');
  const pause = document.getElementById('show-pause');
  let previous = null;
  const render = () => {
    controls.hidden = !program.active;
    pause.textContent = program.playing ? STR.lightShow.pause : STR.lightShow.resume;
  };
  pause.addEventListener('click', () => {
    program.togglePause();
    render();
  });
  document.getElementById('show-replay').addEventListener('click', () => {
    program.replay();
    render();
  });
  document.getElementById('show-exit').addEventListener('click', () => {
    if (!previous) return;
    program.stop();
    selectTime(previous.time);
    selectCamera(previous.camera, true);
    previous = null;
    render();
  });
  return {
    enter() {
      const destination = controller.findModePosition('person', {
        type: 'person', position: arrival, heading: arrival.heading,
        _support: { height: arrival.y, surfaceId: arrival.surfaceId }
      });
      if (!destination || destination.surfaceId !== arrival.surfaceId) return null;
      const restore = { time: lighting.activePresetId, camera: camera.activePresetId };
      if (!selectMode('person', destination)) return null;
      previous ??= restore;
      controller.resetInput();
      touchControls.reset();
      gamepadControls.reset();
      camera.resetForTeleport();
      selectCamera('pov', true);
      camera.camera.fov = 52;
      camera.camera.updateProjectionMatrix();
      selectTime('midnight');
      program.start();
      render();
      return destination;
    },
    get savedTime() { return previous?.time; }
  };
}
