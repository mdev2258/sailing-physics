import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A pool of arrows drawn as two instanced meshes (shafts and heads): hundreds cost two draw calls.
 * Call begin(), add() for each arrow, end() every frame.
 */
export class ArrowSet {
  group = new THREE.Group();
  private shafts: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private d = new THREE.Vector3();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(private max: number, onTop = true, opacity = 0.95) {
    const mat = () => new THREE.MeshBasicMaterial({ depthTest: !onTop, depthWrite: !onTop, transparent: true, opacity, toneMapped: false });
    const shaft = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
    shaft.translate(0, 0.5, 0);
    const head = new THREE.ConeGeometry(1, 1, 12);
    head.translate(0, 0.5, 0);
    this.shafts = new THREE.InstancedMesh(shaft, mat(), max);
    this.heads = new THREE.InstancedMesh(head, mat(), max);
    for (const im of [this.shafts, this.heads]) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      im.frustumCulled = false;
      im.renderOrder = onTop ? 20 : 0;
      im.count = 0;
      this.group.add(im);
    }
  }

  begin() { this.n = 0; }

  /** Arrow from (x,y,z) along (vx,vy,vz), whose length is the arrow's length in metres. */
  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number | THREE.Color, radius = 0.035) {
    if (this.n >= this.max) return;
    const len = Math.hypot(vx, vy, vz);
    if (!(len > 0.015) || !Number.isFinite(len + x + y + z)) return;
    const headLen = Math.min(0.32, len * 0.4), headR = Math.min(radius * 2.6, headLen * 0.55);
    this.d.set(vx / len, vy / len, vz / len);
    this.q.setFromUnitVectors(UP, this.d);
    this.col.set(color);
    const i = this.n++;
    this.p.set(x, y, z);
    this.m.compose(this.p, this.q, this.s.set(radius, len - headLen, radius));
    this.shafts.setMatrixAt(i, this.m);
    this.shafts.setColorAt(i, this.col);
    this.p.addScaledVector(this.d, len - headLen);
    this.m.compose(this.p, this.q, this.s.set(headR, headLen, headR));
    this.heads.setMatrixAt(i, this.m);
    this.heads.setColorAt(i, this.col);
  }

  end() {
    for (const im of [this.shafts, this.heads]) {
      im.count = this.n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}

/** A pool of text labels pinned to points in the scene. begin(), put() each, end(). */
export class LabelSet {
  group = new THREE.Group();
  private items: CSS2DObject[] = [];
  private n = 0;
  constructor(private className = 'force-label') {}

  begin() { this.n = 0; }

  put(text: string, x: number, y: number, z: number, color = '#ffffff') {
    let o = this.items[this.n];
    if (!o) {
      const el = document.createElement('div');
      el.className = this.className;
      o = new CSS2DObject(el);
      this.items.push(o);
      this.group.add(o);
    }
    this.n++;
    const el = o.element as HTMLElement;
    if (el.textContent !== text) el.textContent = text;
    el.style.color = color;
    o.position.set(x, y, z);
    o.visible = true;
  }

  end() { for (let i = this.n; i < this.items.length; i++) this.items[i].visible = false; }

  hide() { for (const o of this.items) o.visible = false; }
}

/** Newtons as a short string: 148 N, 2.46 kN. */
export function fmtN(n: number): string {
  const a = Math.abs(n);
  return a >= 1000 ? `${(n / 1000).toFixed(2)} kN` : `${Math.round(n)} N`;
}
