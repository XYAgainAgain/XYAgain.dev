import * as THREE from 'three/webgpu';
import { TANK } from '../config.js';
import { section } from '../diag/panel.js';

export const CAMERA_KNOBS = {
  maxZoom: 24, sideLean: 30, verticalLean: 15, wideLean: 15, follow: true,
  response: 12, resetDuration: 1, mouseSensitivity: 0.65, pickRadius: 28, frozen: false,
};

const clamp = THREE.MathUtils.clamp;
const radians = THREE.MathUtils.degToRad;
const blend = (zoom) => 1 - 1 / Math.max(1, zoom);

function resist(value, delta, limit) {
  if (limit <= 0) return 0;
  const space = delta > 0 ? limit - value : limit + value;
  if (space <= 0) return value;
  return value + Math.sign(delta) * space * (1 - Math.exp(-Math.abs(delta) / space));
}

export class TankCamera {
  constructor(camera, canvas, { animals = [], scenery = [], say = () => {} } = {}) {
    Object.assign(this, { camera, canvas, animals, scenery, say });
    this.knobs = { ...CAMERA_KNOBS };
    this.focus = new THREE.Vector3(0, TANK.h / 2, 0);
    this.current = this.focus.clone();
    this.offset = new THREE.Vector3();
    this.zoom = this.currentZoom = 1;
    this.lean = new THREE.Vector2();
    this.currentLean = new THREE.Vector2();
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.point = new THREE.Vector3();
    this.projected = new THREE.Vector3();
    this.opticalFocus = new THREE.Vector3();
    this.instance = new THREE.Matrix4();
    this.pointers = new Map();
    this.tracking = null;
    this.pinnedFraming = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.events = new AbortController();
    this.oldTouchAction = canvas.style.touchAction;
    this.oldTabIndex = canvas.getAttribute('tabindex');
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Aquarium view. Scroll or pinch to zoom; drag on touch to pan. Right-drag slides parallel to the front glass. Right-click or two-finger tap to track. Arrow keys pan, plus and minus zoom, Enter toggles tracking at the center, Home resets, Escape releases tracking.');
    this.fit();
    this.bind();
    this.controls();
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height);
    this.camera.aspect = this.width / this.height;
    this.distance = TANK.d / 2 + Math.max((TANK.w / 2 + 0.045) / this.camera.aspect, TANK.h / 2 + 0.045) / Math.tan(radians(11));
    this.camera.far = Math.max(20, this.distance + TANK.d + 3);
    this.limit();
    this.update(0, true);
  }

  limits(zoom = this.zoom) {
    const amount = this.pinnedFraming ? 1 : blend(zoom);
    return [TANK.w / 2 * amount, TANK.h / 2 * amount];
  }

  limit() {
    this.zoom = clamp(this.zoom, 1, clamp(this.knobs.maxZoom, 2, 64));
    const [x, y] = this.limits();
    this.focus.x = clamp(this.focus.x, -x, x);
    this.focus.y = clamp(this.focus.y, TANK.h / 2 - y, TANK.h / 2 + y);
    this.focus.z = clamp(this.focus.z, -TANK.d / 2, TANK.d / 2);
    if (this.zoom === 1 && !this.pinnedFraming) this.focus.set(0, TANK.h / 2, 0);
  }

  pose(focus, zoom, lean) {
    const c = this.camera, wide = clamp(this.knobs.wideLean / 100, 0, 0.3);
    const amount = wide + (1 - wide) * blend(zoom);
    const yaw = Math.tanh(lean.x) * radians(clamp(this.knobs.sideLean, 0, 36)) * amount;
    const pitch = Math.tanh(lean.y) * radians(clamp(this.knobs.verticalLean, 0, 18)) * amount;
    c.position.set(focus.x + this.distance * Math.sin(yaw) * Math.cos(pitch), focus.y + this.distance * Math.sin(pitch), focus.z + this.distance * Math.cos(yaw) * Math.cos(pitch));
    c.lookAt(this.tracking?.opticalPath && this.optics?.project(focus, c, this.opticalFocus, this.tracking.opticalPath) || focus);
    c.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(radians(11)) / zoom));
    c.updateProjectionMatrix(); c.updateMatrixWorld();
  }

  vertex(target, out = this.point) {
    const { mesh, index, instanceId } = target;
    if (!mesh.parent || !mesh.geometry.attributes.position || index >= mesh.geometry.attributes.position.count) return null;
    mesh.updateWorldMatrix(true, false);
    mesh.getVertexPosition(index, out);
    if (instanceId !== undefined) { mesh.getMatrixAt(instanceId, this.instance); out.applyMatrix4(this.instance); }
    return out.applyMatrix4(mesh.matrixWorld);
  }

  update(dt, immediate = false) {
    if (this.disposed || this.knobs.frozen && !immediate) return;
    if (this.tracking) {
      const point = this.vertex(this.tracking);
      if (point) this.focus.copy(point).add(this.offset);
      else this.release();
    }
    this.limit();
    const motion = this.resetMotion;
    let a = immediate || this.reduced.matches ? 1 : 1 - Math.exp(-Math.max(0, dt) * this.knobs.response);
    if (motion) {
      motion.elapsed += Math.max(0, dt);
      const t = immediate || this.reduced.matches ? 1 : Math.min(1, motion.elapsed / motion.duration);
      a = t * t * t * (10 + t * (-15 + t * 6));
      this.current.copy(motion.focus); this.currentZoom = motion.zoom; this.currentLean.copy(motion.lean);
      if (t === 1) this.resetMotion = null;
    }
    this.current.lerp(this.focus, a);
    this.currentZoom = Math.exp(THREE.MathUtils.lerp(Math.log(this.currentZoom), Math.log(this.zoom), a));
    this.currentLean.lerp(this.lean, a);
    if (this.current.distanceToSquared(this.focus) < 1e-14) this.current.copy(this.focus);
    if (this.currentLean.distanceToSquared(this.lean) < 1e-14) this.currentLean.copy(this.lean);
    if (Math.abs(this.currentZoom - this.zoom) < this.zoom * 1e-7) this.currentZoom = this.zoom;
    this.pose(this.current, this.currentZoom, this.currentLean);
    if (this.zoomAnchor) {
      const { point, x, y } = this.zoomAnchor;
      const after = this.planePoint(x, y, point.z);
      this.current.x += point.x - after.x;
      this.current.y += point.y - after.y;
      const [lx, ly] = this.limits(this.currentZoom);
      this.current.x = clamp(this.current.x, -lx, lx);
      this.current.y = clamp(this.current.y, TANK.h / 2 - ly, TANK.h / 2 + ly);
      this.pose(this.current, this.currentZoom, this.currentLean);
      if (this.currentZoom === this.zoom) this.zoomAnchor = null;
    }
  }

  planePoint(x, y, depth) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    this.ray.setFromCamera(this.ndc, this.camera);
    this.optics?.bendRay(this.ray.ray);
    const t = (depth - this.ray.ray.origin.z) / this.ray.ray.direction.z;
    return this.ray.ray.at(Math.max(0, t), new THREE.Vector3());
  }

  depthAt(x, y) {
    this.planePoint(x, y, this.current.z);
    for (const mesh of [...this.animals, ...this.scenery]) {
      mesh.updateWorldMatrix(true, false);
      if (this.animals.includes(mesh)) mesh.geometry.computeBoundingSphere();
    }
    const hit = this.ray.intersectObjects([...this.animals, ...this.scenery], false).find((h) => h.object.visible);
    return hit ? clamp(hit.point.z, -TANK.d / 2, TANK.d / 2) : this.current.z;
  }

  zoomAt(factor, x = this.width / 2, y = this.height / 2) {
    if (this.knobs.frozen || !Number.isFinite(factor) || factor <= 0) return;
    if (this.resetMotion && factor <= 1) return;
    this.cancelReset();
    const old = this.zoom;
    this.zoom = clamp(old * factor, 1, clamp(this.knobs.maxZoom, 2, 64));
    if (this.zoom === 1 && factor <= 1) { this.reset(); return; }
    if (old === this.zoom) return;
    if (this.zoomPinned()) return;
    const before = this.planePoint(x, y, this.depthAt(x, y));
    this.focus.copy(this.current);
    this.pose(this.focus, this.zoom, this.lean);
    const after = this.planePoint(x, y, before.z);
    this.focus.add(before.clone().sub(after));
    this.limit();
    this.zoomAnchor = { point: before, x, y };
    this.pose(this.current, this.currentZoom, this.currentLean);
  }

  zoomPinned() {
    if (!this.tracking || !this.vertex(this.tracking)) return false;
    this.focus.copy(this.point); this.offset.set(0, 0, 0); this.zoomAnchor = null;
    this.limit();
    return true;
  }

  pan(dx, dy, mouse = false, pointer = null) {
    if (this.knobs.frozen || mouse && (!this.knobs.follow || this.reduced.matches)) return;
    if (mouse && this.resetMotion) return;
    this.cancelReset();
    this.zoomAnchor = null;
    const amount = blend(this.zoom), [lx, ly] = this.limits();
    if (!this.tracking) {
      const span = mouse ? TANK.w * amount * this.knobs.mouseSensitivity : 2 * this.distance * Math.tan(radians(11)) * this.camera.aspect / this.zoom;
      const sign = mouse ? 1 : -1;
      this.focus.x = resist(this.focus.x, sign * dx / this.width * span, lx);
      this.focus.y = TANK.h / 2 + resist(this.focus.y - TANK.h / 2, -sign * dy / this.height * (mouse ? TANK.h * amount * this.knobs.mouseSensitivity : span / this.camera.aspect), ly);
    }
    if (!this.reduced.matches) {
      if (mouse && pointer) {
        const rect = this.canvas.getBoundingClientRect();
        this.lean.set(-clamp((pointer.x - rect.left) / rect.width * 2 - 1, -1, 1) * 2, clamp((pointer.y - rect.top) / rect.height * 2 - 1, -1, 1) * 2);
      } else {
        this.lean.x = clamp(this.lean.x - dx / this.width * (mouse ? 2 : 1), -4, 4);
        this.lean.y = clamp(this.lean.y + dy / this.height * (mouse ? 2 : 1), -4, 4);
      }
    }
  }

  panFront(dx, dy) {
    if (this.knobs.frozen) return;
    this.zoomAnchor = null;
    const scale = 2 * this.distance * Math.tan(radians(11)) / this.currentZoom / this.height;
    const [lx, ly] = this.limits();
    this.focus.x = resist(this.focus.x, -dx * scale, lx);
    this.focus.y = TANK.h / 2 + resist(this.focus.y - TANK.h / 2, dy * scale, ly);
  }

  pick(x, y) {
    this.camera.updateMatrixWorld();
    const rect = this.canvas.getBoundingClientRect();
    const local = new THREE.Vector2(x - rect.left, y - rect.top);
    let best = null, score = this.knobs.pickRadius ** 2;
    for (const mesh of this.animals) {
      if (!mesh.visible || !mesh.geometry?.attributes.position || mesh.isInstancedMesh) continue;
      mesh.updateWorldMatrix(true, false);
      const count = mesh.geometry.attributes.position.count;
      for (let index = 0; index < count; index++) {
        mesh.getVertexPosition(index, this.point).applyMatrix4(mesh.matrixWorld);
        for (let path = 0; path < (this.optics?.paths(this.camera) ?? 1); path++) {
          const point = this.optics ? this.optics.project(this.point, this.camera, this.projected, path) : this.projected.copy(this.point);
          if (!point) continue;
          this.projected.project(this.camera);
          if (this.projected.z < 0 || this.projected.z > 1) continue;
          const d = ((this.projected.x + 1) * rect.width / 2 - local.x) ** 2 + ((1 - this.projected.y) * rect.height / 2 - local.y) ** 2;
          if (d < score) { score = d; best = { mesh, index, opticalPath: path }; }
        }
      }
    }
    if (best) return best;
    this.ndc.set(local.x / rect.width * 2 - 1, 1 - local.y / rect.height * 2);
    this.ray.setFromCamera(this.ndc, this.camera);
    this.optics?.bendRay(this.ray.ray);
    for (const mesh of this.scenery) {
      mesh.updateWorldMatrix(true, false);
      if (mesh.geometry.attributes.position.usage === THREE.DynamicDrawUsage) mesh.geometry.computeBoundingSphere();
    }
    const hit = this.ray.intersectObjects(this.scenery, false).find((h) => h.object.visible && h.face);
    if (!hit) return null;
    score = Infinity;
    for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
      const target = { mesh: hit.object, index, instanceId: hit.instanceId };
      this.vertex(target, this.point);
      const path = this.ray.ray.opticalPath ?? 0;
      target.opticalPath = path;
      const point = this.optics ? this.optics.project(this.point, this.camera, this.projected, path) : this.projected.copy(this.point);
      if (!point) continue;
      this.projected.project(this.camera);
      const d = ((this.projected.x + 1) * rect.width / 2 - local.x) ** 2 + ((1 - this.projected.y) * rect.height / 2 - local.y) ** 2;
      if (d < score) { score = d; best = target; }
    }
    return best;
  }

  toggleTracking(x, y) {
    if (this.knobs.frozen) return;
    this.cancelReset();
    if (this.tracking) { this.release(); return; }
    const target = this.pick(x, y);
    if (!target || !this.vertex(target)) { this.say('No tracking point here'); return; }
    this.tracking = target; this.offset.set(0, 0, 0);
    this.pinnedFraming = true;
    this.zoomAnchor = null; this.lean.set(0, 0);
    this.focus.copy(this.point); this.limit();
    this.say(this.animals.includes(target.mesh) ? 'Camera tracking Amira' : 'Camera anchored to scenery');
  }

  release() {
    if (this.tracking) {
      this.focus.copy(this.current); this.zoom = this.currentZoom; this.lean.copy(this.currentLean);
    }
    this.tracking = null; this.zoomAnchor = null; this.offset.set(0, 0, 0);
    this.say('Camera tracking released');
  }

  reset() {
    this.knobs.frozen = false;
    if (this.resetMotion) return;
    this.resetMotion = { focus: this.current.clone(), zoom: this.currentZoom, lean: this.currentLean.clone(), elapsed: 0, duration: clamp(this.knobs.resetDuration, 0.1, 2) };
    this.tracking = null; this.pinnedFraming = false; this.zoomAnchor = null; this.zoom = 1; this.focus.set(0, TANK.h / 2, 0);
    this.lean.set(0, 0); this.say('');
  }

  cancelReset() {
    if (!this.resetMotion) return;
    this.resetMotion = null;
    this.focus.copy(this.current); this.zoom = this.currentZoom; this.lean.copy(this.currentLean);
  }

  inspect({ zoom = this.zoom, focus, lean, immediate = true } = {}) {
    this.resetMotion = null;
    this.tracking = null; this.pinnedFraming = false; this.zoomAnchor = null;
    this.zoom = zoom;
    if (focus) this.focus.fromArray(focus);
    if (lean) this.lean.fromArray(lean);
    this.limit(); this.update(0, immediate);
  }

  controls() {
    const group = section('Camera');
    this.actions = [
      { name: 'Reset camera', label: () => 'Reset camera', run: () => this.reset() },
      { name: 'Freeze camera', label: () => `Camera: ${this.knobs.frozen ? 'frozen' : 'free'}`, run: () => { this.knobs.frozen = !this.knobs.frozen; } },
      { name: 'Mouse-follow', label: () => `Mouse-follow: ${this.knobs.follow ? 'on' : 'off'}`, run: () => { this.knobs.follow = !this.knobs.follow; } },
      { name: 'Release tracking', label: () => this.tracking ? 'Release tracking' : 'Tracking: off', run: () => this.release() },
      { name: 'Track center', label: () => 'Track center', run: () => {
        const rect = this.canvas.getBoundingClientRect(); this.toggleTracking(rect.left + rect.width / 2, rect.top + rect.height / 2);
      } },
      ...[
        ['Zoom', null, [1, 2, 4, 8, 12, 16, 24, 32, 48], '×'],
        ['Closest zoom', 'maxZoom', [4, 8, 12, 16, 24, 32, 48], '×'],
        ['Maximum side lean', 'sideLean', [0, 3, 6, 9, 12, 18, 24, 30, 36], '°'],
        ['Maximum vertical lean', 'verticalLean', [0, 2, 4, 6, 9, 12, 15, 18], '°'],
        ['Widest-view movement', 'wideLean', [0, 3, 6, 10, 15, 20, 25, 30], '%'],
        ['Return smoothing', 'resetDuration', [0.25, 0.4, 0.65, 1, 1.5], ' s'],
      ].map(([name, knob, values, unit]) => ({ type: 'range', name, values,
        get: () => knob ? this.knobs[knob] : this.zoom,
        label: () => `${name}: ${Number((knob ? this.knobs[knob] : this.zoom).toFixed(1))}${unit}`,
        set: (value) => { if (knob) { this.knobs[knob] = value; this.limit(); } else this.zoomAt(value / (this.resetMotion ? this.currentZoom : this.zoom)); },
      })),
    ];
    for (const action of this.actions) group.add(action);
  }

  bind() {
    const c = this.canvas, signal = this.events.signal;
    const on = (name, fn, options = {}) => c.addEventListener(name, fn, { ...options, signal });
    on('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1);
      this.zoomAt(Math.exp(-clamp(delta, -600, 600) * 0.0017), e.clientX, e.clientY);
    }, { passive: false });
    on('contextmenu', (e) => { e.preventDefault(); });
    on('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 2) {
          c.setPointerCapture(e.pointerId);
          this.rightDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
        }
        return;
      }
      c.setPointerCapture(e.pointerId);
      const p = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) { this.gesture = { start: performance.now(), moved: false, count: 1 }; }
      else { this.gesture.count = Math.max(this.gesture.count, this.pointers.size); }
      this.gesture.midpoint = this.midpoint();
      this.gesture.distance = this.separation();
      if (this.pointers.size === 2) {
        this.cancelReset();
        this.gesture.zoom = this.zoom;
        this.gesture.anchor = this.planePoint(this.gesture.midpoint.x, this.gesture.midpoint.y, this.depthAt(this.gesture.midpoint.x, this.gesture.midpoint.y));
      }
    });
    on('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        const drag = this.rightDrag;
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.x = e.clientX; drag.y = e.clientY;
          if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) {
            drag.moved = true;
            if (!this.knobs.frozen) {
              this.cancelReset();
              if (this.tracking) this.release();
              this.focus.copy(this.current); this.zoom = this.currentZoom; this.lean.copy(this.currentLean);
              this.pinnedFraming = true;
            }
          }
          if (drag.moved) this.panFront(dx, dy);
          this.mouse = null; return;
        }
        if (this.mouse && !e.buttons) this.pan(e.clientX - this.mouse.x, e.clientY - this.mouse.y, true, { x: e.clientX, y: e.clientY });
        this.mouse = { x: e.clientX, y: e.clientY }; return;
      }
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const old = this.midpoint(), distance = this.separation();
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(p.x - p.startX, p.y - p.startY) > 6) this.gesture.moved = true;
      const mid = this.midpoint(), nextDistance = this.separation();
      if (!this.gesture.moved) return;
      if (this.pointers.size === 2 && this.gesture.distance > 8 && nextDistance > 8) {
        if (this.knobs.frozen) return;
        if (this.resetMotion) {
          if (nextDistance <= distance) return;
          this.cancelReset();
          this.gesture.zoom = this.zoom;
          this.gesture.distance = Math.max(8.001, distance);
          this.gesture.anchor = this.planePoint(old.x, old.y, this.depthAt(old.x, old.y));
        }
        const point = this.gesture.anchor;
        this.zoom = clamp(this.gesture.zoom * nextDistance / this.gesture.distance, 1, clamp(this.knobs.maxZoom, 2, 64));
        if (this.zoom === 1) { this.reset(); return; }
        if (this.zoomPinned()) return;
        this.focus.copy(this.current);
        this.pose(this.focus, this.zoom, this.lean);
        const after = this.planePoint(mid.x, mid.y, point.z);
        this.focus.add(point.clone().sub(after)); this.limit();
        this.zoomAnchor = { point: point.clone(), x: mid.x, y: mid.y };
        this.pose(this.current, this.currentZoom, this.currentLean);
      } else this.pan(mid.x - old.x, mid.y - old.y);
    });
    on('pointerleave', () => { this.mouse = null; });
    const end = (e) => {
      if (this.rightDrag?.id === e.pointerId) {
        const drag = this.rightDrag; this.rightDrag = null; this.mouse = null;
        if (e.type === 'pointerup' && !drag.moved) this.toggleTracking(e.clientX, e.clientY);
        if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
        return;
      }
      if (!this.pointers.has(e.pointerId)) return;
      const g = this.gesture;
      this.pointers.delete(e.pointerId);
      if (e.type === 'pointercancel') g.moved = true;
      // A drag or pinch still ends in a click, which would otherwise send her to wherever the gesture let go.
      if (g.moved || g.count > 1) this.suppressClickUntil = performance.now() + 700;
      if (!this.pointers.size && g.count === 2 && !g.moved && performance.now() - g.start < 350) this.toggleTracking(g.midpoint.x, g.midpoint.y);
    };
    on('pointerup', end); on('pointercancel', end); on('lostpointercapture', end);
    on('click', (e) => {
      if (performance.now() < this.suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, { capture: true });
    on('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const rect = c.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (e.key === '+' || e.key === '=') this.zoomAt(1.3, x, y);
      else if (e.key === '-') this.zoomAt(1 / 1.3, x, y);
      else if (e.key === 'Home') this.reset();
      else if (e.key === 'Escape') this.release();
      else if (e.key === 'Enter') this.toggleTracking(x, y);
      else if (e.key.startsWith('Arrow')) this.pan(e.key === 'ArrowLeft' ? 50 : e.key === 'ArrowRight' ? -50 : 0, e.key === 'ArrowUp' ? 50 : e.key === 'ArrowDown' ? -50 : 0);
      else return;
      e.preventDefault(); e.stopPropagation();
    });
  }

  midpoint() {
    const ps = [...this.pointers.values()];
    return { x: ps.reduce((n, p) => n + p.x, 0) / ps.length, y: ps.reduce((n, p) => n + p.y, 0) / ps.length };
  }

  separation() {
    const ps = [...this.pointers.values()];
    return ps.length === 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
  }

  dispose() {
    this.disposed = true; this.events.abort(); this.pointers.clear();
    this.canvas.style.touchAction = this.oldTouchAction;
    if (this.oldTabIndex === null) this.canvas.removeAttribute('tabindex'); else this.canvas.setAttribute('tabindex', this.oldTabIndex);
    for (const action of this.actions) if (action.button) action.button.disabled = true;
  }
}
