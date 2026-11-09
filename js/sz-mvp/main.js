import * as THREE from 'three/webgpu';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { STR } from '../sz-strings.js';
import { loadCityData } from './data.js';
import { buildGround } from './ground.js';
import { buildBuildings } from './buildings.js';
import { createTraffic } from './traffic.js';
import { createAir } from './air.js';
import { sceneUniforms } from './materials.js';

// 三个时段；sun 是太阳方向（x 东、y 上、z 南）
const TIMES = {
  day: { sun: [0.45, 0.85, 0.35], sunColor: 0xfff4e2, sunI: 3.2, sky: 0x9cc4e4, hemiI: 1.25, fog: [2500, 26000], night: 0, show: 0, exposure: 1.0 },
  dusk: { sun: [-0.85, 0.18, 0.2], sunColor: 0xffa060, sunI: 2.0, sky: 0xd8946c, hemiI: 0.7, fog: [1800, 20000], night: 0.55, show: 0.6, exposure: 1.05 },
  night: { sun: [-0.3, 0.6, -0.5], sunColor: 0x7d93c8, sunI: 0.25, sky: 0x0a1424, hemiI: 0.22, fog: [1500, 18000], night: 1, show: 1, exposure: 1.15 }
};

const START_VIEW = { target: [-2200, 0, 1500], position: [-700, 1400, 4800] };
const FLY_SECONDS = 1.6;

const $ = (id) => document.getElementById(id);

function setLoading(text) {
  $('loading-text').textContent = text;
}

async function main() {
  $('title').textContent = STR.title;
  $('subtitle').textContent = STR.subtitle;
  $('apec-banner').textContent = STR.apecBanner;
  $('lm-title').textContent = STR.landmarks;
  $('tod-title').textContent = STR.timeOfDay;
  $('help').textContent = STR.help;
  setLoading(`${STR.loading} ${STR.loadingData}`);

  const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  $('app').appendChild(renderer.domElement);
  await renderer.init();

  const data = await loadCityData();
  setLoading(`${STR.loading} ${STR.loadingBuild}`);
  await new Promise((r) => setTimeout(r, 0));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 1, 80000);
  camera.position.set(...START_VIEW.position);
  const controls = new MapControls(camera, renderer.domElement);
  controls.target.set(...START_VIEW.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 25;
  controls.maxDistance = 22000;
  controls.screenSpacePanning = false;

  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6d6658, 1.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  scene.add(sun);
  scene.add(sun.target);
  scene.fog = new THREE.Fog(0x9cc4e4, 2500, 26000);

  scene.add(buildGround(data));
  const { group: buildings, landmarkTops } = buildBuildings(data);
  scene.add(buildings);
  const traffic = createTraffic(data);
  scene.add(traffic.group);
  const air = createAir(data, landmarkTops);
  scene.add(air.group);

  function applyTime(name) {
    const t = TIMES[name];
    if (!t) throw new Error(`Unknown time preset: ${name}`);
    sun.position.set(...t.sun).multiplyScalar(5000);
    sun.color.setHex(t.sunColor);
    sun.intensity = t.sunI;
    hemi.intensity = t.hemiI;
    scene.background = new THREE.Color(t.sky);
    scene.fog.color.setHex(t.sky);
    scene.fog.near = t.fog[0];
    scene.fog.far = t.fog[1];
    sceneUniforms.night.value = t.night;
    sceneUniforms.show.value = t.show;
    renderer.toneMappingExposure = t.exposure;
    document.querySelectorAll('#tod button').forEach((b) => b.classList.toggle('active', b.dataset.time === name));
  }
  for (const name of Object.keys(TIMES)) {
    const b = document.createElement('button');
    b.dataset.time = name;
    b.textContent = STR[name];
    b.onclick = () => applyTime(name);
    $('tod').appendChild(b);
  }

  // 相机飞到某个位置；following 时每帧跟着飞行器
  let fly = null;
  let following = false;
  function flyTo(target, distance) {
    following = false;
    followBtn.classList.remove('active');
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    fly = {
      t: 0,
      fromP: camera.position.clone(), fromT: controls.target.clone(),
      toT: target.clone(), toP: target.clone().add(dir.multiplyScalar(distance))
    };
  }

  const labels = [];
  const inBounds = (l) => {
    const [minx, minz, maxx, maxz] = data.bounds;
    return l.x >= minx && l.x <= maxx && l.z >= minz && l.z <= maxz;
  };
  data.landmarks.filter(inBounds).forEach((l) => {
    const idx = data.landmarks.indexOf(l);
    const top = landmarkTops.get(idx);
    const h = Math.max(l.height || 0, top ? top.h : 0, 30);
    const anchor = new THREE.Vector3(l.x, h + 12, l.z);
    const go = () => flyTo(new THREE.Vector3(l.x, h * 0.4, l.z), Math.max(420, h * 1.9));
    const btn = document.createElement('button');
    btn.textContent = l.name.replace(/（.*?）/g, '');
    btn.onclick = go;
    $('landmarks').appendChild(btn);
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = btn.textContent;
    el.onclick = go;
    $('labels').appendChild(el);
    labels.push({ el, anchor });
  });

  const followBtn = document.createElement('button');
  followBtn.textContent = STR.follow;
  followBtn.onclick = () => {
    following = !following;
    fly = null;
    followBtn.classList.toggle('active', following);
    if (following) {
      controls.target.copy(air.evtol.position);
      camera.position.copy(air.evtol.position).add(new THREE.Vector3(-60, 35, -60));
    }
  };
  const routesBtn = document.createElement('button');
  routesBtn.textContent = STR.routes;
  routesBtn.classList.add('active');
  routesBtn.onclick = () => {
    air.routeLines.visible = !air.routeLines.visible;
    routesBtn.classList.toggle('active', air.routeLines.visible);
  };
  const apecBtn = document.createElement('button');
  apecBtn.textContent = STR.apec;
  apecBtn.classList.add('active');
  apecBtn.onclick = () => {
    const on = sceneUniforms.apec.value < 0.5;
    sceneUniforms.apec.value = on ? 1 : 0;
    apecBtn.classList.toggle('active', on);
    $('apec-banner').style.visibility = on ? 'visible' : 'hidden';
  };
  $('toggles').append(followBtn, routesBtn, apecBtn);

  const params = new URLSearchParams(location.search);
  applyTime(params.get('time') in TIMES ? params.get('time') : 'day');
  $('stats').textContent = STR.stats(data.buildings.h.length, traffic.count, air.droneCount);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const v = new THREE.Vector3();
  const followOffset = new THREE.Vector3();
  let last = performance.now();
  function updateLabels() {
    const w = window.innerWidth, h = window.innerHeight;
    for (const { el, anchor } of labels) {
      v.copy(anchor).project(camera);
      const dist = camera.position.distanceTo(anchor);
      const visible = v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && dist < 9000;
      el.style.display = visible ? 'block' : 'none';
      if (visible) el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
    }
  }

  renderer.setAnimationLoop((now) => {
    // 首帧的 rAF 时间戳可能早于初始化末尾，负步长会让曲线参数越界。
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    traffic.update(dt);
    followOffset.copy(camera.position).sub(controls.target);
    air.update(dt);
    if (following) {
      controls.target.copy(air.evtol.position);
      camera.position.copy(air.evtol.position).add(followOffset);
    } else if (fly) {
      fly.t = Math.min(fly.t + dt / FLY_SECONDS, 1);
      const e = fly.t * fly.t * (3 - 2 * fly.t);
      camera.position.lerpVectors(fly.fromP, fly.toP, e);
      controls.target.lerpVectors(fly.fromT, fly.toT, e);
      if (fly.t >= 1) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
    updateLabels();
  });

  window.__sz = { scene, camera, controls, data, applyTime, flyTo, traffic, air };
  $('loading').classList.add('done');
}

main().catch((err) => {
  console.error(err);
  setLoading(`${STR.loadingFailed}: ${err.message}`);
});
