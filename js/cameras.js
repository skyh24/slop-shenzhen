import * as THREE from 'three/webgpu';
import { getScenicCamera } from './sz-camera-presets.js';
import { STR } from './sz-strings.js';
import { LANDMARK_RADIUS } from './sz-landmark-views.js';

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       name: STR.cameraNames.chase,         category: 'follow', fov: 56 },
  { id: 'action',      name: STR.cameraNames.action,         category: 'follow', fov: 60 },
  { id: 'pov',         name: STR.cameraNames.pov,   category: 'follow', fov: 68 },
  { id: 'centralPark', name: STR.cameraNames.centralPark,       category: 'scenic', fov: 52 },
  { id: 'fifthAve',    name: STR.cameraNames.fifthAve,   category: 'scenic', fov: 48 },
  { id: 'timesSquare', name: STR.cameraNames.timesSquare,  category: 'scenic', fov: 58 },
  { id: 'chryslerGCT', name: STR.cameraNames.chryslerGCT, category: 'scenic', fov: 50 },
  { id: 'observatory', name: STR.cameraNames.observatory,   category: 'scenic', fov: 52 },
  { id: 'bryantPark',  name: STR.cameraNames.bryantPark,       category: 'scenic', fov: 52 },
  { id: 'waterfront',  name: STR.cameraNames.waterfront,     category: 'scenic', fov: 46 },
  { id: 'drone',       name: STR.cameraNames.drone,     category: 'scenic', fov: 50 },
  { id: 'djiSkyCity',  name: STR.cameraNames.djiSkyCity, category: 'scenic', fov: 52 },
  { id: 'pingAnTower', name: STR.cameraNames.pingAnTower, category: 'scenic', fov: 52 },
  { id: 'chunsunTower', name: STR.cameraNames.chunsunTower, category: 'scenic', fov: 52 },
  { id: 'civicRoof', name: STR.cameraNames.civicRoof, category: 'scenic', fov: 52 },
  { id: 'chunjianShell', name: STR.cameraNames.chunjianShell, category: 'scenic', fov: 55 },
  { id: 'cultureSquare', name: STR.cameraNames.cultureSquare, category: 'scenic', fov: 52 },
  { id: 'conventionCenter', name: STR.cameraNames.conventionCenter, category: 'scenic', fov: 52 },
  { id: 'upperhills', name: STR.cameraNames.upperhills, category: 'scenic', fov: 52 },
  { id: 'nonferrousTower', name: STR.cameraNames.nonferrousTower, category: 'scenic', fov: 58 },
  { id: 'iecXiangmihu', name: STR.cameraNames.iecXiangmihu, category: 'scenic', fov: 58 },
  { id: 'superHq', name: STR.cameraNames.superHq, category: 'scenic', fov: 44 },
  { id: 'bayBridge',   name: STR.cameraNames.bayBridge, category: 'scenic', fov: 44 },
  { id: 'yanjiang', name: STR.cameraNames.yanjiang, category: 'scenic', fov: 56 }
];

const LANDMARK_ORBIT = { id: 'landmarkOrbit', name: STR.cameraNames.landmarkOrbit, category: 'scenic', fov: 62 };
const ORBIT_SECONDS = 120;

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the boroughs & harbor run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.landmarkOrbit = null;
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // 追尾和动作机位都相对当前玩家更新，避免移动时因帧间隔波动而前后窜动。
    this.followEntity = null;
    this.followHeading = 0;
    this.followZoom = 1;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (this.activePresetId === 'chase' && previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(this.activePresetId === 'pov' ? -1.18 : -0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      if (this.activePresetId !== 'chase') return;
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    if (this.activePresetId !== preset.id || snapImmediately) {
      this._clearPointers();
      this.followEntity = null;
      if (preset.id === 'chase') this.resetOrbit();
    }
    this.landmarkOrbit = null;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  startLandmarkOrbit(target, altitude) {
    const { x, z } = this.controllerManager.getActiveEntity().position;
    this._clearPointers();
    this.landmarkOrbit = { target, altitude, angle: Math.atan2(x - target.x, z - target.z), start: null };
    this.activePresetId = LANDMARK_ORBIT.id;
    this.camera.fov = LANDMARK_ORBIT.fov;
    this.camera.updateProjectionMatrix();
    this.followEntity = null;
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(this.activePresetId === 'pov' ? -1.18 : -0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // 传送和模式切换都从当前玩家正后方重新取景。
    this.smoothedSpeed = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    if (this.landmarkOrbit) return LANDMARK_ORBIT;
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed, wallTime = elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const k = 1 - Math.exp(-dt * 8.5);
    const preset = this.getActivePreset();
    const mode = this.landmarkOrbit ? LANDMARK_ORBIT.id : preset.category === 'scenic' ? 'scenic' : this.activePresetId;
    switch (mode) {
      case 'chase': {
        if (!this.initialized || this.followEntity !== entity) {
          this.followHeading = entity.heading;
          this.followBaseY = entity.position.y;
          this.followZoom = this.zoomMultiplier;
        } else {
          const turn = entity.heading - this.followHeading;
          this.followHeading += Math.atan2(Math.sin(turn), Math.cos(turn)) * k;
          this.followBaseY += (entity.position.y - this.followBaseY) * k;
          this.followZoom += (this.zoomMultiplier - this.followZoom) * k;
        }
        // 飞行以机体当前航向为基准，手动环绕角叠加在追尾方向上。
        const yaw = (entity.type === 'helicopter' ? entity.heading : this.followHeading) + this.orbitYawOffset;
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);
        const dist = entity.chaseDistance * this.followZoom * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.followZoom + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        // 直接沿环绕角度定位，避免快速拖动时插值穿过玩家。视线始终横向经过玩家。
        desiredPos.set(
          entity.position.x - sinYaw * horizDist,
          Math.max(0.65, this.followBaseY + height),
          entity.position.z - cosYaw * horizDist
        );

        desiredLook.set(entity.position.x, this.followBaseY + entity.cameraTargetOffset.y, entity.position.z);
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        const totalYaw = entity.heading + this.orbitYawOffset;
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'landmarkOrbit': {
        const orbit = this.landmarkOrbit;
        orbit.start ??= wallTime;
        const angle = orbit.angle + (wallTime - orbit.start) * 2 * Math.PI / ORBIT_SECONDS;
        const { x, y, z } = orbit.target;
        desiredPos.set(x + Math.sin(angle) * LANDMARK_RADIUS, orbit.altitude, z + Math.cos(angle) * LANDMARK_RADIUS);
        desiredLook.set(x, y, z);
        break;
      }

      case 'scenic': {
        const shot = getScenicCamera(preset.id, elapsed);
        desiredPos.set(...shot.position);
        desiredLook.set(...shot.target);
        break;
      }
      default:
        throw new Error(`Unhandled camera preset: ${this.activePresetId}`);
    }

    if (!this.initialized || mode === 'pov' || mode === 'chase' || mode === LANDMARK_ORBIT.id) {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = mode === 'chase' ? entity : null;
    } else if (mode === 'action') {
      if (this.followEntity !== entity) {
        // 动作机位从当前画面过渡到新的侧后方取景。
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
