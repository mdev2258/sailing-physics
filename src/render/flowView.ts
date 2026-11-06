import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Boat, SailRuntime } from '../physics/boat';
import { sailOptAlpha } from '../physics/coeffs';
import { DEG, clamp, smoothstep } from '../physics/math';

/**
 * Flow lines over the sails, driven by the flow the physics computed for each sail strip:
 * the incoming arrow is that strip's real apparent wind; the line on the suction (leeward) side
 * stays attached and leaves the leech cleanly when trimmed, breaks away into a wake when stalled,
 * and wanders past when luffing. Colours read like telltales.
 */

type V3 = [number, number, number];
const N = 28; // points per line
const COLORS = { ok: new THREE.Color(0x2fe08a), luff: new THREE.Color(0xffb020), stall: new THREE.Color(0xff4d4d) };

interface FlowLine { line: Line2; geo: LineGeometry; pos: Float32Array; mat: LineMaterial; phase: number }

// which strips to draw per sail (keeps it readable)
const PICK: Record<string, number[]> = { main: [0, 2, 4], jib: [0, 2], gennaker: [1, 3, 5] };

export class FlowView {
  group = new THREE.Group();
  private lines = new Map<string, FlowLine>();
  private heads: THREE.InstancedMesh;
  private headCount = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.heads = new THREE.InstancedMesh(new THREE.ConeGeometry(0.075, 0.26, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }), 96);
    this.heads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(96 * 3), 3);
    this.heads.frustumCulled = false;
    this.group.add(this.heads);
  }

  private getLine(key: string): FlowLine {
    let l = this.lines.get(key);
    if (!l) {
      const pos = new Float32Array(N * 3);
      const geo = new LineGeometry();
      geo.setPositions(pos);
      const mat = new LineMaterial({ color: 0xffffff, linewidth: 3, dashed: true, dashSize: 0.3, gapSize: 0.18, transparent: true, opacity: 0.95 });
      const line = new Line2(geo, mat);
      line.frustumCulled = false;
      this.group.add(line);
      l = { line, geo, pos, mat, phase: Math.random() };
      this.lines.set(key, l);
    }
    return l;
  }

  update(b: Boat, t: number, dt: number, visible: boolean) {
    this.group.visible = visible;
    if (!visible) return;
    this.group.position.copy(b.origin);
    this.group.quaternion.copy(b.q);
    this.headCount = 0;
    const seen = new Set<string>();
    for (const sail of b.sails) {
      const name = sail.def.name;
      const on = name !== 'gennaker' || b.genHoist > 0.9;
      for (const i of PICK[name]) {
        for (const side of [1, -1]) {
          const key = `${name}${i}${side}`;
          if (!on) continue;
          seen.add(key);
          this.drawStrip(this.getLine(key), sail, i, side, t, dt);
        }
      }
    }
    for (const [k, l] of this.lines) l.line.visible = seen.has(k);
    this.heads.count = this.headCount;
    this.heads.instanceMatrix.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
  }

  /** side = +1 suction (leeward) face, −1 pressure (windward) face. */
  private drawStrip(l: FlowLine, s: SailRuntime, i: number, side: number, t: number, dt: number) {
    const st = s.strips[i];
    const k = s.axis;
    const c = s.chordDir(st.u, [0, 0, 0]);
    const chord = st.chord;
    const depth = s.depths[i];
    // incoming flow, perpendicular to the luff
    const f = s.flow[i];
    const fk = f[0] * k[0] + f[1] * k[1] + f[2] * k[2];
    let fx = f[0] - fk * k[0], fy = f[1] - fk * k[1], fz = f[2] - fk * k[2];
    const speed = Math.hypot(fx, fy, fz);
    if (speed < 0.2) { l.line.visible = false; return; }
    fx /= speed; fy /= speed; fz /= speed;
    // camber normal (towards the side the sail bulges) and which face is the suction face
    const cs = s.angle >= 0 ? 1 : -1;
    let nx = (k[1] * c[2] - k[2] * c[1]) * cs, ny = (k[2] * c[0] - k[0] * c[2]) * cs, nz = (k[0] * c[1] - k[1] * c[0]) * cs;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // flow pushes the sail towards the suction side; if that's against the camber, the sail is backed
    const push = fx * nx + fy * ny + fz * nz; // >0: wind hitting the concave (windward) face — normal
    const suction = push >= 0 ? 1 : -1;
    const face = side * suction; // sign along n of the face this line runs over
    const a = s.alpha[i];
    const opt = sailOptAlpha(depth);
    const luffing = a < s.luffTol;
    const stalled = a > opt + 10 * DEG;
    const col = luffing ? COLORS.luff : stalled ? COLORS.stall : COLORS.ok;

    const P = st.p;
    const surf = (x: number, gap: number, out: V3) => {
      const bulge = depth * chord * 6.75 * x * (1 - x) ** 2 * 0.9;
      out[0] = P[0] + c[0] * chord * x + nx * (bulge + face * gap);
      out[1] = P[1] + c[1] * chord * x + ny * (bulge + face * gap);
      out[2] = P[2] + c[2] * chord * x + nz * (bulge + face * gap);
      return out;
    };
    const up = 1.1, down = 1.2;
    const pos = l.pos;
    const tmp: V3 = [0, 0, 0];
    // separation point on the suction face when stalled; the pressure face stays attached
    const sep = side > 0 && stalled ? clamp(1 - (a - opt) / (35 * DEG), 0.15, 0.75) : 1;
    const nUp = 7, nSurf = 12;
    let p = 0;
    // 1) incoming: straight along the real apparent wind, easing onto the luff
    surf(0, 0.07, tmp);
    for (let j = 0; j < nUp; j++) {
      const u = j / nUp;
      const d = up * (1 - u);
      pos[p++] = tmp[0] - fx * d; pos[p++] = tmp[1] - fy * d; pos[p++] = tmp[2] - fz * d;
    }
    // 2) along the sail
    let lastX = 0;
    for (let j = 0; j < nSurf; j++) {
      const x = (j + 1) / nSurf;
      lastX = x;
      if (x > sep) break;
      surf(x, 0.07 + 0.03 * x, tmp);
      if (luffing) { // flogging: the line rattles about near the luff
        const w = 0.06 * (1 - x) * Math.sin(t * 22 + x * 9 + i);
        tmp[0] += nx * w; tmp[1] += ny * w; tmp[2] += nz * w;
      }
      pos[p++] = tmp[0]; pos[p++] = tmp[1]; pos[p++] = tmp[2];
    }
    // 3) leaving: attached flow leaves along the leech, then relaxes back to the free stream;
    //    separated flow peels away into a wobbling wake.
    const e = surf(Math.min(lastX, sep), 0.07 + 0.03 * sep, [0, 0, 0]);
    const remaining = N - p / 3;
    for (let j = 0; j < remaining; j++) {
      const u = (j + 1) / remaining;
      const d = down * u * (sep < 1 ? 1.2 : 1);
      const blend = smoothstep(0, 1, u);
      let dx = c[0] * (1 - blend) + fx * blend, dy = c[1] * (1 - blend) + fy * blend, dz = c[2] * (1 - blend) + fz * blend;
      if (sep < 1) { dx = fx; dy = fy; dz = fz; }
      let wx = 0, wy = 0, wz = 0;
      if (sep < 1) { // turbulent wake, thrown off the suction face
        const amp = 0.05 + 0.22 * u;
        const w = amp * Math.sin(t * 9 + u * 11 + i * 1.7) + 0.5 * amp * Math.sin(t * 15.3 + u * 23);
        wx = nx * face * (Math.abs(w) + 0.15 * u); wy = ny * face * (Math.abs(w) + 0.15 * u) + 0.05 * Math.sin(t * 7 + u * 13); wz = nz * face * (Math.abs(w) + 0.15 * u);
      }
      pos[p++] = e[0] + dx * d + wx; pos[p++] = e[1] + dy * d + wy; pos[p++] = e[2] + dz * d + wz;
    }
    // dashes move at a fraction of the real flow speed so you can follow them
    l.phase = (l.phase + dt * speed * 0.35) % 0.48;
    l.geo.setPositions(pos);
    l.line.computeLineDistances();
    l.mat.dashOffset = -l.phase;
    l.mat.color.copy(col);
    l.mat.linewidth = side > 0 ? 3 : 1.8;
    l.mat.opacity = side > 0 ? 0.95 : 0.6;
    l.line.visible = true;
    // arrowheads: one on the incoming arrow (the apparent wind), one where the flow leaves
    if (side > 0) {
      this.head(pos, 4, col);
      this.head(pos, N - 3, col);
    }
  }

  private head(pos: Float32Array, j: number, col: THREE.Color) {
    if (this.headCount >= 96) return;
    const a = new THREE.Vector3(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
    const b = new THREE.Vector3(pos[j * 3 + 3], pos[j * 3 + 4], pos[j * 3 + 5]);
    const d = b.clone().sub(a);
    if (d.lengthSq() < 1e-8) return;
    this.q.setFromUnitVectors(this.up, d.normalize());
    this.m4.compose(b, this.q, new THREE.Vector3(1, 1, 1));
    this.heads.setMatrixAt(this.headCount, this.m4);
    this.heads.setColorAt(this.headCount, col);
    this.headCount++;
  }
}
